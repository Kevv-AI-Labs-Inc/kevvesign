import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { requestListQuery } from './list-query.js';
import { previewField, safeFilename } from './review.js';
import type { Principal, BridgeConfig } from './config.js';
import { BridgeStore } from './store.js';
import { recipientIsCurrent } from './recipient-access.js';
import { Documenso, ProviderError, canonical, sha256, templateFingerprint } from './documenso.js';
import {
  BridgeError,
  createInput,
  publishInput,
  email,
  key,
  assertNativeOwner,
  bindRecipients,
  projectEnvelope,
} from './model.js';
import type {
  Connection,
  PackageRow,
  PartRow,
  RequestRow,
  PreparedPart,
  FileInput,
  CreateInput,
  PublishedPart,
} from './model.js';
import { readTemplate, compileTemplate, assertTemplateVersion, assertHrDraft } from './packages.js';
import {
  assertCompanyAccess,
  assertNewSigningScenario,
  isCustomerPackage,
  packageCompanyKeys,
} from './policy.js';

export const connectionInput = z
  .object({
    scope: z.enum(['customer', 'company']),
    ownerAgentId: z.number().int().positive().optional(),
    companyKey: key.optional(),
    // Supplied by the trusted Portal server after canonical account lookup.
    verifiedEmails: z.array(email).min(1).max(30),
    token: z.string().min(16).max(500),
    proofEnvelopeId: z.string().min(1).max(200),
    isolationConfirmed: z.literal(true),
    isolationNotes: z.string().trim().min(20).max(2000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.scope === 'customer' ? !v.ownerAgentId || !!v.companyKey : !v.companyKey || !!v.ownerAgentId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Choose an agent or an HR company connection',
      });
  });

export class SigningService {
  constructor(
    readonly store: BridgeStore,
    readonly config: BridgeConfig,
  ) {}
  provider(connection: Connection) {
    return new Documenso(
      this.config.DOCUMENSO_BASE_URL,
      this.store.decrypt(connection.token_ciphertext),
    );
  }
  private admin(principal: Principal) {
    if (!principal.admin) throw new BridgeError('ADMIN_REQUIRED', 403);
  }
  async connection(id: string, clientId: string) {
    const [connection] = await this.store.query<Connection>(
      'SELECT * FROM signing.connections WHERE id=$1 AND client_id=$2 AND revoked_at IS NULL',
      [id, clientId],
    );
    if (!connection) throw new BridgeError('SIGNING_CONNECTION_UNAVAILABLE', 409);
    return connection;
  }
  async targetConnection(principal: Principal, input: CreateInput) {
    assertNewSigningScenario(principal, input.scenario, input.companyKey);
    const company = input.scenario !== 'custom';
    const [connection] = await this.store.query<Connection>(
      `SELECT * FROM signing.connections WHERE client_id=$1 AND revoked_at IS NULL AND ${company ? "scope='company' AND company_key=$2" : "scope='customer' AND owner_agent_id=$2"}`,
      [principal.clientId, company ? input.companyKey : input.ownerAgentId],
    );
    if (!connection)
      throw new BridgeError(
        company ? 'COMPANY_SIGNING_NOT_CONFIGURED' : 'AGENT_SIGNING_NOT_CONNECTED',
        409,
      );
    if (!company && !principal.verifiedEmails.includes(connection.native_email))
      throw new BridgeError('CONNECTED_EMAIL_NO_LONGER_VERIFIED', 409);
    return connection;
  }
  async registerConnection(principal: Principal, raw: unknown) {
    this.admin(principal);
    const input = connectionInput.parse(raw);
    if (input.scope === 'customer') throw new BridgeError('PERSONAL_SIGNING_UNAVAILABLE', 403);
    const provider = new Documenso(this.config.DOCUMENSO_BASE_URL, input.token);
    const proof = await provider.get(input.proofEnvelopeId);
    if (
      proof.type !== 'DOCUMENT' ||
      proof.deletedAt ||
      proof.visibility !== 'ADMIN' ||
      !input.verifiedEmails.includes(proof.user.email.toLowerCase())
    )
      throw new BridgeError('CONNECTION_PROOF_MISMATCH', 409);
    // The proof must be a real document owned by the mapped upstream user.
    // Membership isolation is independently checked in native setup / QA.
    const id = randomUUID();
    await this.store.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO signing.connections(id,client_id,scope,owner_agent_id,company_key,native_user_id,native_email,team_id,team_url,token_ciphertext,isolation_verified_by,isolation_notes,proof_envelope_id,native_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          id,
          principal.clientId,
          input.scope,
          input.ownerAgentId ?? null,
          input.companyKey ?? null,
          proof.userId,
          proof.user.email.toLowerCase(),
          proof.teamId,
          proof.team.url,
          this.store.encrypt(input.token),
          principal.agentId,
          input.isolationNotes,
          proof.id,
          proof.user.name || '',
        ],
      );
      await tx.query(
        'INSERT INTO signing.events(client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4)',
        [
          principal.clientId,
          principal.agentId,
          'connection.verified',
          {
            connectionId: id,
            scope: input.scope,
            ownerAgentId: input.ownerAgentId,
            companyKey: input.companyKey,
            teamId: proof.teamId,
            nativeUserId: proof.userId,
          },
        ],
      );
    });
    return {
      id,
      scope: input.scope,
      nativeEmail: proof.user.email,
      teamId: proof.teamId,
      teamUrl: proof.team.url,
    };
  }
  async connections(principal: Principal) {
    const where = principal.admin ? '' : "AND scope='customer' AND owner_agent_id=$2";
    return this.store.query(
      'SELECT id,scope,owner_agent_id AS "ownerAgentId",company_key AS "companyKey",native_email AS "nativeEmail",team_url AS "teamUrl",revoked_at AS "revokedAt" FROM signing.connections WHERE client_id=$1 ' +
        where +
        ' ORDER BY created_at DESC',
      principal.admin ? [principal.clientId] : [principal.clientId, principal.agentId],
    );
  }
  async rotateConnection(principal: Principal, id: string, raw: unknown) {
    this.admin(principal);
    const input = connectionInput.parse(raw);
    const proof = await new Documenso(this.config.DOCUMENSO_BASE_URL, input.token).get(
      input.proofEnvelopeId,
    );
    await this.store.transaction(async (tx) => {
      const {
        rows: [current],
      } = await tx.query<Connection>(
        'SELECT * FROM signing.connections WHERE id=$1 AND client_id=$2 FOR UPDATE',
        [id, principal.clientId],
      );
      if (!current) throw new BridgeError('NOT_FOUND', 404);
      assertNativeOwner(proof, current);
      if (
        input.scope !== current.scope ||
        (input.ownerAgentId ?? null) !== current.owner_agent_id ||
        (input.companyKey ?? null) !== current.company_key ||
        !input.verifiedEmails.includes(current.native_email)
      )
        throw new BridgeError('CONNECTION_PROOF_MISMATCH', 409);
      await tx.query(
        'UPDATE signing.connections SET token_ciphertext=$2,proof_envelope_id=$3,isolation_verified_by=$4,isolation_notes=$5,native_name=$6,revoked_at=NULL,updated_at=NOW() WHERE id=$1',
        [
          id,
          this.store.encrypt(input.token),
          proof.id,
          principal.agentId,
          input.isolationNotes,
          proof.user.name || '',
        ],
      );
      await tx.query(
        'INSERT INTO signing.events(client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4)',
        [
          principal.clientId,
          principal.agentId,
          'connection.credentials_rotated',
          {
            connectionId: id,
            restored: Boolean(current.revoked_at),
            nativeUserId: proof.userId,
            teamId: proof.teamId,
          },
        ],
      );
    });
    return { id, nativeEmail: proof.user.email, teamUrl: proof.team.url };
  }
  async revokeConnection(principal: Principal, id: string, reason: string) {
    this.admin(principal);
    await this.store.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE signing.connections SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW() WHERE id=$1 AND client_id=$2 RETURNING id',
        [id, principal.clientId],
      );
      if (!result.rowCount) throw new BridgeError('NOT_FOUND', 404);
      await tx.query(
        'INSERT INTO signing.events(client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4)',
        [principal.clientId, principal.agentId, 'connection.revoked', { connectionId: id, reason }],
      );
    });
  }
  async packages(principal: Principal) {
    const items = await this.store.query<PackageRow>(
      "SELECT p.*,c.native_email AS company_signer_email,c.native_name AS company_signer_name FROM signing.packages p JOIN signing.connections c ON c.client_id=p.client_id AND c.scope='company' AND c.company_key=p.company_key AND c.revoked_at IS NULL WHERE p.client_id=$1 AND p.retired_at IS NULL ORDER BY p.package_key,p.version DESC",
      [principal.clientId],
    );
    return items.filter(
      (item) =>
        !isCustomerPackage(item.scenario) ||
        principal.admin ||
        packageCompanyKeys(item).some((company) => principal.allowedCompanyKeys?.includes(company)),
    );
  }
  async templates(principal: Principal, connectionId: string, templateId?: string, page = 1) {
    this.admin(principal);
    const connection = await this.connection(connectionId, principal.clientId);
    if (connection.scope !== 'company') throw new BridgeError('COMPANY_TEMPLATES_ONLY', 403);
    const provider = this.provider(connection);
    if (!templateId) {
      const result = await provider.list({ type: 'TEMPLATE', page });
      return {
        items: result.data.map((item) => ({
          id: item.id,
          title: String(item.title),
        })),
        page: result.currentPage,
        totalPages: result.totalPages,
      };
    }
    const template = await provider.get(templateId);
    if (
      template.type !== 'TEMPLATE' ||
      template.teamId !== connection.team_id ||
      template.userId !== connection.native_user_id ||
      template.user.email.toLowerCase() !== connection.native_email ||
      template.visibility !== 'ADMIN' ||
      template.deletedAt
    )
      throw new BridgeError('TEMPLATE_ACCESS_MISMATCH', 403);
    return {
      id: template.id,
      editorUrl: provider.editorUrl(template),
      title: template.title,
      files: template.envelopeItems.map((item) => ({
        id: item.id,
        title: item.title,
      })),
      roles: template.recipients.map((recipient) => ({
        id: recipient.id,
        name: recipient.name,
        role: recipient.role,
        order: recipient.signingOrder,
      })),
      fields: template.fields
        .filter((field) => ['TEXT', 'NUMBER', 'RADIO', 'CHECKBOX', 'DROPDOWN'].includes(field.type))
        .map((field) => ({
          id: field.id,
          label: String(field.fieldMeta?.label || ''),
          type: field.type,
          readOnly: Boolean(field.fieldMeta?.readOnly),
          itemId: field.envelopeItemId,
          recipientId: field.recipientId,
        })),
    };
  }
  async uploadTemplate(
    principal: Principal,
    connectionId: string,
    raw: unknown,
    files: FileInput[],
  ) {
    this.admin(principal);
    const input = z
      .object({ uploadId: z.uuid(), title: z.string().trim().min(1).max(200) })
      .strict()
      .parse(raw);
    const connection = await this.connection(connectionId, principal.clientId);
    if (connection.scope !== 'company') throw new BridgeError('COMPANY_TEMPLATES_ONLY', 403);
    if (
      !files.length ||
      files.length > 10 ||
      files.some(
        (file) =>
          !file.name.toLowerCase().endsWith('.pdf') ||
          file.bytes.length > 25 * 1024 * 1024 ||
          Buffer.from(file.bytes.subarray(0, 5)).toString() !== '%PDF-',
      ) ||
      files.reduce((n, file) => n + file.bytes.length, 0) > 100 * 1024 * 1024
    )
      throw new BridgeError('INVALID_PDF_UPLOAD', 400);
    const hash = sha256(
      canonical({
        input,
        connectionId,
        files: files.map((file) => ({ name: file.name, hash: sha256(file.bytes) })),
      }),
    );
    const externalId = `company-template:${input.uploadId}`;
    await this.store.query(
      'INSERT INTO signing.template_uploads(id,client_id,connection_id,actor_agent_id,request_hash,external_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
      [input.uploadId, principal.clientId, connectionId, principal.agentId, hash, externalId],
    );
    return this.lease(input.uploadId, async () => {
      const [row] = await this.store.query<{
        request_hash: string;
        provider_id: string | null;
        state: string;
      }>(
        'SELECT * FROM signing.template_uploads WHERE id=$1 AND client_id=$2 AND connection_id=$3',
        [input.uploadId, principal.clientId, connectionId],
      );
      if (!row || row.request_hash !== hash) throw new BridgeError('IDEMPOTENCY_KEY_REUSED', 409);
      const provider = this.provider(connection);
      let nativeId = row.provider_id;
      if (!nativeId && ['creating', 'unknown'].includes(row.state)) {
        const matches: string[] = [];
        for (let page = 1; page <= 10; page++) {
          const result = await provider.list({ type: 'TEMPLATE', query: externalId, page });
          matches.push(
            ...result.data.filter((item) => item.externalId === externalId).map((item) => item.id),
          );
          if (page >= result.totalPages) break;
        }
        if (matches.length !== 1) throw new BridgeError('CREATE_OUTCOME_UNKNOWN', 409);
        nativeId = matches[0];
      }
      if (!nativeId) {
        if (row.state === 'failed') throw new BridgeError('TEMPLATE_UPLOAD_FAILED', 409);
        await this.store.query(
          "UPDATE signing.template_uploads SET state='creating',updated_at=NOW() WHERE id=$1",
          [input.uploadId],
        );
        try {
          nativeId = await provider.create(
            {
              title: input.title,
              type: 'TEMPLATE',
              visibility: 'ADMIN',
              delegatedDocumentOwner: connection.native_email,
              externalId,
              recipients: [],
              meta: { distributionMethod: 'EMAIL', timezone: 'America/New_York' },
            },
            files,
          );
        } catch (error) {
          await this.store.query(
            'UPDATE signing.template_uploads SET state=$2,last_error=$3,updated_at=NOW() WHERE id=$1',
            [
              input.uploadId,
              error instanceof ProviderError && !error.uncertain ? 'failed' : 'unknown',
              error instanceof ProviderError ? error.code : 'TEMPLATE_UPLOAD_OUTCOME_UNKNOWN',
            ],
          );
          throw error;
        }
      }
      // Persist a known creation result before GET so a transient read failure
      // never causes another template to be created on retry.
      await this.store.query(
        'UPDATE signing.template_uploads SET provider_id=$2,updated_at=NOW() WHERE id=$1',
        [input.uploadId, nativeId],
      );
      const document = await provider.get(nativeId);
      assertNativeOwner(document, connection, 'TEMPLATE');
      if (document.type !== 'TEMPLATE' || document.externalId !== externalId || document.deletedAt)
        throw new BridgeError('TEMPLATE_ACCESS_MISMATCH', 409);
      await this.store.query(
        "UPDATE signing.template_uploads SET state='ready',last_error=NULL,updated_at=NOW() WHERE id=$1",
        [input.uploadId],
      );
      return { id: document.id, title: document.title, editorUrl: provider.editorUrl(document) };
    });
  }
  async publish(principal: Principal, raw: unknown) {
    this.admin(principal);
    const input = publishInput.parse(raw);
    if (isCustomerPackage(input.scenario) && input.parts.length !== 1)
      throw new BridgeError('STANDARD_PACKAGE_SINGLE_ENVELOPE', 400);
    const [connection] = await this.store.query<Connection>(
      "SELECT * FROM signing.connections WHERE client_id=$1 AND scope='company' AND company_key=$2 AND revoked_at IS NULL",
      [principal.clientId, input.companyKey],
    );
    if (!connection) throw new BridgeError('COMPANY_SIGNING_NOT_CONFIGURED', 409);
    const applicableCompanies = input.applicableCompanyKeys || [input.companyKey];
    const configuredCompanies = await this.store.query<{ company_key: string }>(
      "SELECT company_key FROM signing.connections WHERE client_id=$1 AND scope='company' AND revoked_at IS NULL AND company_key=ANY($2::text[])",
      [principal.clientId, applicableCompanies],
    );
    if (configuredCompanies.length !== applicableCompanies.length)
      throw new BridgeError('COMPANY_SIGNING_NOT_CONFIGURED', 409);
    const definition: PublishedPart[] = [];
    const sharedFieldFormats = new Map<string, string>();
    for (const part of input.parts) {
      const { document, files } = await readTemplate(this.provider(connection), part, connection);
      if (
        ['onboarding', 'team_leader'].includes(input.scenario) &&
        (!part.roles.some((r) => r.actor === 'owner') ||
          part.roles.some((r) => r.actor === 'customer') ||
          part.roles.some(
            (r) =>
              ['owner', 'company'].includes(r.actor) &&
              document.recipients.find((recipient) => recipient.id === r.templateRecipientId)
                ?.role !== 'SIGNER',
          ))
      )
        throw new BridgeError('INVALID_HR_RECIPIENT_ROLES', 400);
      definition.push({
        ...part,
        prefill: part.prefill.map((prefill) => {
          const field = document.fields.find((f) => f.id === prefill.templateFieldId)!;
          const options = Array.isArray(field.fieldMeta?.values)
            ? (field.fieldMeta.values as Array<{ value: string }>).map((v) => v.value)
            : [];
          const format = canonical({ type: field.type, options });
          if (sharedFieldFormats.has(prefill.key) && sharedFieldFormats.get(prefill.key) !== format)
            throw new BridgeError('SHARED_PREFILL_FORMAT_MISMATCH', 400);
          sharedFieldFormats.set(prefill.key, format);
          return {
            ...prefill,
            recipientKey: part.roles.find((role) => role.templateRecipientId === field.recipientId)!
              .key,
            valueType: field.type,
            options,
          };
        }),
        connectionId: connection.id,
        fingerprint: templateFingerprint(
          document,
          files.map((f) => sha256(f.bytes)),
        ),
        files: files.map((f) => ({ title: f.name, hash: sha256(f.bytes) })),
      });
    }
    const id = randomUUID();
    await this.store.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO signing.packages(id,client_id,package_key,version,title,scenario,company_key,selectors,definition,published_by,applicable_company_keys) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          principal.clientId,
          input.packageKey,
          input.version,
          input.title,
          input.scenario,
          input.companyKey,
          input.selectors,
          JSON.stringify(definition),
          principal.agentId,
          applicableCompanies,
        ],
      );
      await tx.query(
        'INSERT INTO signing.events(client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4)',
        [
          principal.clientId,
          principal.agentId,
          'package.published',
          { packageId: id, key: input.packageKey, version: input.version },
        ],
      );
    });
    return { id, ...input, parts: definition };
  }
  async retirePackage(principal: Principal, id: string) {
    this.admin(principal);
    const rows = await this.store.query(
      'UPDATE signing.packages SET retired_at=COALESCE(retired_at,NOW()) WHERE id=$1 AND client_id=$2 RETURNING id',
      [id, principal.clientId],
    );
    if (!rows.length) throw new BridgeError('NOT_FOUND', 404);
  }
  async prepare(
    principal: Principal,
    input: CreateInput,
    files: FileInput[],
    requestId: string,
  ): Promise<PreparedPart[]> {
    if (input.ownerAgentId !== principal.agentId)
      throw new BridgeError('OWNER_MUST_BE_CURRENT_AGENT', 403);
    const target = await this.targetConnection(principal, input);
    // Customer recipients stay on the native completion/download page, which
    // does not require an agent's Portal session.
    const redirectUrl = isCustomerPackage(input.scenario)
      ? null
      : `${principal.portalOrigin}${input.scenario === 'onboarding' ? '/pending' : input.scenario === 'team_leader' ? '/team-workspace' : `/signing/${requestId}`}`;
    if (input.scenario === 'custom') {
      if (!files.length || files.length > 10) throw new BridgeError('UPLOAD_PDF_FILES', 400);
      if (
        files.reduce((size, f) => size + f.bytes.length, 0) > 100 * 1024 * 1024 ||
        files.some(
          (f) =>
            f.bytes.length > 25 * 1024 * 1024 ||
            Buffer.from(f.bytes.subarray(0, 5)).toString() !== '%PDF-',
        )
      )
        throw new BridgeError('INVALID_PDF_UPLOAD', 400);
      return [
        {
          connection: target,
          files,
          bindings: [],
          payload: {
            title: input.title,
            type: 'DOCUMENT',
            visibility: 'ADMIN',
            delegatedDocumentOwner: target.native_email,
            recipients: input.recipients.map((r) => ({
              email: r.email,
              name: r.name,
              role: 'SIGNER',
            })),
            meta: {
              redirectUrl,
              distributionMethod: 'EMAIL',
              timezone: 'America/New_York',
            },
          },
        },
      ];
    }
    if (files.length) throw new BridgeError('PUBLISHED_PACKAGE_FILES_CANNOT_BE_REPLACED', 400);
    const [packageRow] = await this.store.query<PackageRow>(
      'SELECT * FROM signing.packages WHERE id=$1 AND client_id=$2 AND retired_at IS NULL',
      [input.packageId, principal.clientId],
    );
    if (
      !packageRow ||
      packageRow.scenario !== input.scenario ||
      !packageCompanyKeys(packageRow).includes(input.companyKey)
    )
      throw new BridgeError('PACKAGE_NOT_AVAILABLE', 409);
    const roleKeys = new Set(packageRow.definition.flatMap((p) => p.roles.map((r) => r.key)));
    if (input.recipients.some((r) => !roleKeys.has(r.key)))
      throw new BridgeError('UNEXPECTED_RECIPIENT', 400);
    const parts = [];
    for (const part of packageRow.definition) {
      const source = await this.connection(part.connectionId, principal.clientId);
      if (
        source.scope !== 'company' ||
        source.company_key !== packageRow.company_key ||
        (source.id !== target.id &&
          (!isCustomerPackage(input.scenario) ||
            !packageCompanyKeys(packageRow).includes(target.company_key!)))
      )
        throw new BridgeError('PACKAGE_COMPANY_MISMATCH', 409);
      const { document, files: templateFiles } = await readTemplate(
        this.provider(source),
        part,
        source,
      );
      assertTemplateVersion(
        document,
        part,
        templateFiles.map((file) => sha256(file.bytes)),
      );
      for (const role of part.roles) {
        const recipient = input.recipients.find((r) => r.key === role.key);
        if (
          role.actor === 'owner' &&
          (!recipient || !principal.verifiedEmails.includes(recipient.email))
        )
          throw new BridgeError('OWNER_RECIPIENT_NOT_VERIFIED', 403);
        if (role.actor === 'company' && recipient?.email !== target.native_email)
          throw new BridgeError('COMPANY_RECIPIENT_NOT_VERIFIED', 403);
      }
      parts.push(compileTemplate(document, templateFiles, part, input, target, redirectUrl));
    }
    return parts;
  }
  async preview(principal: Principal, raw: unknown) {
    const input = createInput.parse(raw);
    if (input.scenario === 'custom')
      throw new BridgeError('USE_NATIVE_EDITOR_FOR_CUSTOM_DOCUMENTS', 400);
    const parts = await this.prepare(principal, input, [], randomUUID());
    return {
      title: input.title,
      parts: parts.map((part) => ({
        title: part.payload.title,
        files: part.files.map((file) => ({
          name: file.name,
          sha256: sha256(file.bytes),
        })),
        recipients: part.bindings,
      })),
    };
  }
  async create(principal: Principal, raw: unknown, files: FileInput[] = []) {
    const input = createInput.parse(raw);
    assertNewSigningScenario(principal, input.scenario, input.companyKey);
    if (input.ownerAgentId !== principal.agentId)
      throw new BridgeError('OWNER_MUST_BE_CURRENT_AGENT', 403);
    const hash = sha256(
      canonical({
        input,
        files: files.map((f) => ({ name: f.name, hash: sha256(f.bytes) })),
      }),
    );
    const [existing] = await this.store.query<RequestRow>(
      'SELECT * FROM signing.requests WHERE client_id=$1 AND owner_agent_id=$2 AND idempotency_key=$3',
      [principal.clientId, principal.agentId, input.idempotencyKey],
    );
    if (existing) {
      if (existing.request_hash !== hash) throw new BridgeError('IDEMPOTENCY_KEY_REUSED', 409);
      await this.processRequest(existing.id, principal.clientId);
      return this.detail(principal, existing.id);
    }
    if (input.predecessorRequestId) {
      if (!isCustomerPackage(input.scenario) || !input.reissueReason)
        throw new BridgeError('REISSUE_REASON_REQUIRED', 400);
      const previous = await this.reissueSeed(principal, input.predecessorRequestId);
      if (previous.companyKey !== input.companyKey || previous.scenario !== input.scenario)
        throw new BridgeError('PACKAGE_COMPANY_MISMATCH', 403);
    }
    const id = randomUUID(),
      prepared = await this.prepare(principal, input, files, id);
    const savedId = await this.store.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${principal.clientId}:${principal.agentId}:${input.idempotencyKey}`,
      ]);
      const {
        rows: [repeat],
      } = await tx.query<RequestRow>(
        'SELECT * FROM signing.requests WHERE client_id=$1 AND owner_agent_id=$2 AND idempotency_key=$3',
        [principal.clientId, principal.agentId, input.idempotencyKey],
      );
      if (repeat) {
        if (repeat.request_hash !== hash) throw new BridgeError('IDEMPOTENCY_KEY_REUSED', 409);
        return repeat.id;
      }
      await tx.query(
        'INSERT INTO signing.requests(id,client_id,owner_agent_id,idempotency_key,request_hash,external_reference,scenario,package_id,title,business,input_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          principal.clientId,
          principal.agentId,
          input.idempotencyKey,
          hash,
          input.externalReference,
          input.scenario,
          input.packageId ?? null,
          input.title,
          input.business,
          input,
        ],
      );
      for (const [index, part] of prepared.entries()) {
        const partId = randomUUID();
        const payload = { ...part.payload, externalId: `homix:${partId}` };
        await tx.query(
          'INSERT INTO signing.request_parts(id,request_id,part_index,connection_id,external_id,snapshot,recipients) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            partId,
            id,
            index,
            part.connection.id,
            `homix:${partId}`,
            payload,
            JSON.stringify(part.bindings),
          ],
        );
        for (const [fileIndex, file] of part.files.entries())
          await tx.query(
            'INSERT INTO signing.request_uploads(part_id,file_index,name,sha256,content_ciphertext) VALUES($1,$2,$3,$4,$5)',
            [
              partId,
              fileIndex,
              file.name,
              sha256(file.bytes),
              this.store.encrypt(Buffer.from(file.bytes).toString('base64')),
            ],
          );
      }
      await tx.query(
        'INSERT INTO signing.events(request_id,client_id,actor_agent_id,event) VALUES($1,$2,$3,$4)',
        [id, principal.clientId, principal.agentId, 'request.prepared'],
      );
      if (input.predecessorRequestId)
        await tx.query(
          'INSERT INTO signing.events(request_id,client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4,$5)',
          [
            id,
            principal.clientId,
            principal.agentId,
            'request.reprepared',
            { predecessorRequestId: input.predecessorRequestId, reason: input.reissueReason },
          ],
        );
      return id;
    });
    await this.processRequest(savedId, principal.clientId);
    return this.detail(principal, savedId);
  }
  async request(principal: Principal, id: string) {
    const [request] = await this.store.query<RequestRow>(
      'SELECT * FROM signing.requests WHERE id=$1 AND client_id=$2',
      [id, principal.clientId],
    );
    if (!request || (!principal.admin && request.owner_agent_id !== principal.agentId))
      throw new BridgeError('NOT_FOUND', 404);
    return request;
  }
  async list(
    principal: Principal,
    input: { query?: string; category?: string; page?: number; hr?: boolean },
  ) {
    if (input.hr) this.admin(principal);
    const page = input.page ?? 1;
    const [result] = await this.store.query<{ count: number; ids: string[] }>(requestListQuery, [
      principal.clientId,
      principal.agentId,
      `%${(input.query || '').replace(/[\\%_]/g, '\\$&')}%`,
      Boolean(input.hr),
      input.category ?? null,
      principal.verifiedEmails,
      principal.admin,
      (page - 1) * 30,
    ]);
    const items = await Promise.all(result.ids.map((id) => this.detail(principal, id, false)));
    return { items, page, count: result.count, truncated: false };
  }

  async detail(principal: Principal, id: string, withEvents = true) {
    const request = await this.request(principal, id);
    const parts = await this.store.query<PartRow>(
      'SELECT * FROM signing.request_parts WHERE request_id=$1 ORDER BY part_index',
      [id],
    );
    const projected = parts.map((part) => ({
      id: part.id,
      index: part.part_index,
      operationState: part.operation_state,
      error: part.last_error,
      lastSyncedAt: part.last_synced_at,
      canEdit: false,
      document: part.projection
        ? {
            ...part.projection,
            recipients: part.projection.recipients.map((recipient) => ({
              ...recipient,
              canSign:
                Boolean(part.projection && recipientIsCurrent(part.projection, recipient.id)) &&
                principal.verifiedEmails.includes(recipient.email.toLowerCase()) &&
                (request.scenario === 'custom' ||
                  (recipient.actor === 'owner'
                    ? request.owner_agent_id === principal.agentId
                    : recipient.actor === 'company' && principal.admin)),
            })),
          }
        : null,
    }));
    const hasError = parts.some(
      (p) =>
        p.last_error ||
        ['unknown', 'failed', 'discarded'].includes(p.operation_state) ||
        p.projection?.expired ||
        ['CANCELLED', 'REJECTED'].includes(p.projection?.status ?? ''),
    );
    const category = hasError
      ? 'attention'
      : parts.every((p) => p.projection?.status === 'COMPLETED')
        ? 'completed'
        : parts.some((p) => p.projection?.status === 'DRAFT' || !p.projection)
          ? 'draft'
          : projected.some((p) => p.document?.recipients.some((r) => r.canSign))
            ? 'mine'
            : 'waiting';
    const events = withEvents
      ? await this.store.query(
          'SELECT event,actor_agent_id AS "actorAgentId",detail,created_at AS "createdAt" FROM signing.events WHERE request_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
          [id],
        )
      : [];
    return {
      id: request.id,
      title: request.title,
      scenario: request.scenario,
      business: request.business,
      ownerAgentId: request.owner_agent_id,
      predecessorRequestId: request.input_snapshot.predecessorRequestId ?? null,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      category,
      parts: projected,
      events,
    };
  }
  private async lease<T>(id: string, fn: () => Promise<T>) {
    const client = await this.store.pool.connect();
    const lockKey = `signing-request:${id}`;
    let locked = false;
    try {
      const {
        rows: [row],
      } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [lockKey],
      );
      locked = row.locked;
      if (!locked) throw new BridgeError('REQUEST_BUSY', 409);
      return await fn();
    } finally {
      if (locked)
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
      client.release();
    }
  }
  private async readLease<T>(id: string, fn: () => Promise<T>) {
    // Read-only previews/downloads may briefly overlap a status refresh. Wait
    // without holding a pool connection; mutation calls retain fail-fast locks.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return await this.lease(id, fn);
      } catch (error) {
        if (
          !(error instanceof BridgeError && error.code === 'REQUEST_BUSY') ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  private async event(
    requestId: string,
    clientId: string,
    event: string,
    actor: number | null,
    detail: Record<string, unknown> = {},
  ) {
    await this.store.query(
      'INSERT INTO signing.events(request_id,client_id,actor_agent_id,event,detail) VALUES($1,$2,$3,$4,$5)',
      [requestId, clientId, actor, event, detail],
    );
  }
  private async syncPart(part: PartRow, clientId: string) {
    if (!part.provider_id) throw new BridgeError('DOCUMENT_NOT_LINKED', 409);
    const connection = await this.connection(part.connection_id, clientId);
    const document = await this.provider(connection).get(part.provider_id);
    assertNativeOwner(document, connection);
    if (document.externalId !== part.external_id)
      throw new BridgeError('DOCUMENT_REFERENCE_CHANGED', 409);
    let bindings = part.recipients;
    if (bindings.length && bindings.some((r) => r.nativeId === undefined))
      bindings = bindRecipients(document, bindings);
    // HR identity must not silently change after a native administrator edit.
    if (
      connection.scope === 'company' &&
      (document.recipients.length !== bindings.length ||
        bindings.some(
          (binding) =>
            !document.recipients.some(
              (r) =>
                r.id === binding.nativeId &&
                r.email.toLowerCase() === binding.email &&
                r.name === binding.name &&
                r.role === binding.role,
            ),
        ))
    )
      throw new BridgeError('HR_RECIPIENT_CHANGED', 409);
    const projection = projectEnvelope(document, bindings);
    const oldProjection = part.projection;
    await this.store.transaction(async (tx) => {
      await tx.query(
        "UPDATE signing.request_parts SET operation_state='linked',projection=$2,recipients=$3,last_error=CASE WHEN delivery_state IN ('unknown','sending') AND $4='DRAFT' THEN 'SEND_OUTCOME_UNKNOWN' ELSE NULL END,delivery_state=CASE WHEN $4<>'DRAFT' THEN 'sent' ELSE delivery_state END,last_synced_at=NOW(),updated_at=NOW() WHERE id=$1",
        [part.id, projection, JSON.stringify(bindings), document.status],
      );
      await tx.query('DELETE FROM signing.request_uploads WHERE part_id=$1', [part.id]);
      if (canonical(oldProjection) !== canonical(projection)) {
        await tx.query(
          "INSERT INTO signing.portal_outbox(id,request_id,client_id,owner_agent_id,scenario) SELECT $1,id,client_id,owner_agent_id,scenario FROM signing.requests WHERE id=$2 AND scenario IN ('onboarding','team_leader')",
          [randomUUID(), part.request_id],
        );
        await tx.query('UPDATE signing.requests SET updated_at=NOW() WHERE id=$1', [
          part.request_id,
        ]);
        await tx.query(
          'INSERT INTO signing.events(request_id,client_id,event,detail) VALUES($1,$2,$3,$4)',
          [
            part.request_id,
            clientId,
            'provider.state_refreshed',
            {
              partId: part.id,
              status: projection.status,
              recipients: projection.recipients.map(({ id, signingStatus, signedAt }) => ({
                id,
                signingStatus,
                signedAt,
              })),
            },
          ],
        );
      }
    });
    return { document, connection, bindings };
  }
  private async recover(part: PartRow, clientId: string) {
    const connection = await this.connection(part.connection_id, clientId),
      provider = this.provider(connection);
    const matches = [];
    let page = 1;
    while (page <= 10) {
      const result = await provider.list({
        query: part.external_id,
        page,
        folderId: part.folder_id ?? undefined,
      });
      matches.push(...result.data.filter((document) => document.externalId === part.external_id));
      if (page >= result.totalPages) break;
      page++;
    }
    if (matches.length > 1) throw new BridgeError('DUPLICATE_PROVIDER_DOCUMENTS', 409);
    if (!matches.length) throw new BridgeError('CREATE_OUTCOME_UNKNOWN', 409);
    const document = await provider.get(matches[0].id);
    assertNativeOwner(document, connection);
    await this.store.query(
      "UPDATE signing.request_parts SET provider_id=$2,operation_state='linked',updated_at=NOW() WHERE id=$1 AND provider_id IS NULL",
      [part.id, document.id],
    );
    return {
      ...part,
      provider_id: document.id,
      operation_state: 'linked' as const,
    };
  }
  async processRequest(id: string, clientId: string) {
    return this.lease(id, async () => {
      // A previous process can have died after the POST. A released session lock
      // permits reconciliation, never a second create after 'creating'.
      const parts = await this.store.query<PartRow>(
        'SELECT p.* FROM signing.request_parts p JOIN signing.requests r ON r.id=p.request_id WHERE p.request_id=$1 AND r.client_id=$2 ORDER BY part_index',
        [id, clientId],
      );
      for (let part of parts) {
        if (part.operation_state === 'discarded' || part.operation_state === 'failed') continue;
        try {
          if (!part.provider_id && ['creating', 'unknown'].includes(part.operation_state))
            part = await this.recover(part, clientId);
          if (!part.provider_id && part.operation_state === 'prepared') {
            const connection = await this.connection(part.connection_id, clientId);
            const uploads = await this.store.query<{
              name: string;
              sha256: string;
              content_ciphertext: string;
            }>(
              'SELECT name,sha256,content_ciphertext FROM signing.request_uploads WHERE part_id=$1 ORDER BY file_index',
              [part.id],
            );
            const files = uploads.map((upload) => ({
              name: upload.name,
              bytes: Buffer.from(this.store.decrypt(upload.content_ciphertext), 'base64'),
            }));
            if (
              !files.length ||
              files.some((file, index) => sha256(file.bytes) !== uploads[index].sha256)
            )
              throw new BridgeError('PREPARED_FILES_UNAVAILABLE', 409);
            await this.store.query(
              "UPDATE signing.request_parts SET operation_state='creating',create_started_at=NOW(),updated_at=NOW() WHERE id=$1 AND operation_state='prepared'",
              [part.id],
            );
            try {
              const providerId = await this.provider(connection).create(part.snapshot, files);
              // Durable ID save is deliberately before GET and ownership checks.
              await this.store.query(
                "UPDATE signing.request_parts SET provider_id=$2,operation_state='linked',updated_at=NOW() WHERE id=$1",
                [part.id, providerId],
              );
              part = {
                ...part,
                provider_id: providerId,
                operation_state: 'linked',
              };
            } catch (error) {
              // Parsing a successful response or persisting its ID can fail too.
              // Only a definite provider 4xx can establish rejection.
              const definite =
                error instanceof ProviderError &&
                !error.uncertain &&
                error.status >= 400 &&
                error.status < 500;
              await this.store.query(
                'UPDATE signing.request_parts SET operation_state=$2,last_error=$3,updated_at=NOW() WHERE id=$1 AND provider_id IS NULL',
                [
                  part.id,
                  definite ? 'failed' : 'unknown',
                  definite ? 'PROVIDER_CREATE_REJECTED' : 'CREATE_OUTCOME_UNKNOWN',
                ],
              );
              throw error;
            }
          }
          if (part.provider_id) await this.syncPart(part, clientId);
        } catch (error) {
          const code =
            error instanceof BridgeError || error instanceof ProviderError
              ? error.code
              : 'SIGNING_SYNC_FAILED';
          await this.store.query(
            'UPDATE signing.request_parts SET last_error=$2,updated_at=NOW() WHERE id=$1',
            [part.id, code],
          );
        }
      }
    });
  }
  async refresh(principal: Principal, id: string) {
    await this.request(principal, id);
    await this.processRequest(id, principal.clientId);
    return this.detail(principal, id);
  }
  async command(
    principal: Principal,
    id: string,
    action: 'send' | 'remind' | 'cancel' | 'discard' | 'close',
    reason?: string,
    recipientActor?: 'owner' | 'company',
    reviewHash?: string,
  ) {
    const request = await this.request(principal, id);
    if (isCustomerPackage(request.scenario))
      assertCompanyAccess(principal, request.input_snapshot.companyKey);
    const hr = ['onboarding', 'team_leader'].includes(request.scenario);
    if (
      hr &&
      !principal.admin &&
      (['cancel', 'discard', 'close'].includes(action) ||
        (action === 'remind' && recipientActor !== 'owner'))
    )
      throw new BridgeError('ADMIN_REQUIRED', 403);
    await this.lease(id, async () => {
      const parts = await this.store.query<PartRow>(
        'SELECT * FROM signing.request_parts WHERE request_id=$1 ORDER BY part_index',
        [id],
      );
      let reminders = 0;
      for (const part of parts) {
        if (part.operation_state === 'discarded') continue;
        if (
          ['discard', 'close'].includes(action) &&
          !part.provider_id &&
          ['prepared', 'failed'].includes(part.operation_state)
        ) {
          if (!reason || reason.trim().length < 5) throw new BridgeError('REASON_REQUIRED', 400);
          await this.store.query(
            "UPDATE signing.request_parts SET operation_state='discarded',last_error=NULL,updated_at=NOW() WHERE id=$1",
            [part.id],
          );
          await this.store.query('DELETE FROM signing.request_uploads WHERE part_id=$1', [part.id]);
          await this.event(
            id,
            principal.clientId,
            'request.local_draft_discarded',
            principal.agentId,
            { partId: part.id, reason },
          );
          continue;
        }
        if (part.operation_state !== 'linked' || !part.provider_id)
          throw new BridgeError('DOCUMENT_NOT_READY', 409);
        const { document, connection } = await this.syncPart(part, principal.clientId),
          provider = this.provider(connection);
        if (action === 'send') {
          if (document.status === 'PENDING' || document.status === 'COMPLETED') continue;
          if (document.status !== 'DRAFT') throw new BridgeError('DOCUMENT_CANNOT_BE_SENT', 409);
          // A failed first sync can leave the cached projection null or stale.
          // Gate the actual native draft, never the cached status, before sending.
          if (isCustomerPackage(request.scenario) && reviewHash !== this.reviewHash(request, parts))
            throw new BridgeError('REVIEW_REQUIRED', 409);
          if (part.delivery_state !== 'idle') throw new BridgeError('SEND_OUTCOME_UNKNOWN', 409);
          if (hr || isCustomerPackage(request.scenario)) {
            assertHrDraft(document, part.snapshot);
            const [published] = await this.store.query<PackageRow>(
              'SELECT p.* FROM signing.packages p JOIN signing.requests r ON r.package_id=p.id WHERE r.id=$1',
              [request.id],
            );
            const expectedFiles = published?.definition[part.part_index]?.files;
            if (isCustomerPackage(request.scenario) && published?.retired_at)
              throw new BridgeError('PACKAGE_RETIRED', 409);
            if (!expectedFiles || expectedFiles.length !== document.envelopeItems.length)
              throw new BridgeError('HR_DRAFT_CHANGED', 409);
            for (const [index, file] of document.envelopeItems.entries())
              if (
                sha256(await provider.document(document.id, file.id, 'original')) !==
                expectedFiles[index].hash
              )
                throw new BridgeError('HR_DRAFT_CHANGED', 409);
          }
          await this.store.query(
            "UPDATE signing.request_parts SET delivery_state='sending',updated_at=NOW() WHERE id=$1",
            [part.id],
          );
          try {
            await provider.distribute(document.id);
          } catch (error) {
            const definite =
              error instanceof ProviderError &&
              !error.uncertain &&
              error.status >= 400 &&
              error.status < 500;
            await this.store.query(
              'UPDATE signing.request_parts SET delivery_state=$2,last_error=$3 WHERE id=$1',
              [
                part.id,
                definite ? 'idle' : 'unknown',
                definite ? 'SEND_REJECTED' : 'SEND_OUTCOME_UNKNOWN',
              ],
            );
            throw error;
          }
          await this.store.query(
            "UPDATE signing.request_parts SET delivery_state='sent' WHERE id=$1",
            [part.id],
          );
        } else if (action === 'remind') {
          if (document.status !== 'PENDING') continue;
          const unsigned = document.recipients.filter(
            (r) => r.signingStatus === 'NOT_SIGNED' && r.role !== 'CC',
          );
          const order =
            document.documentMeta?.signingOrder === 'SEQUENTIAL'
              ? Math.min(...unsigned.map((r) => r.signingOrder ?? 1))
              : null;
          const recipients = unsigned
            .filter(
              (r) =>
                (order === null || (r.signingOrder ?? 1) === order) &&
                (!recipientActor ||
                  part.recipients.some(
                    (binding) => binding.nativeId === r.id && binding.actor === recipientActor,
                  )),
            )
            .map((r) => r.id);
          if (!recipients.length) continue;
          const rows = await this.store.query(
            "UPDATE signing.request_parts SET reminder_requested_at=NOW() WHERE id=$1 AND (reminder_requested_at IS NULL OR reminder_requested_at < NOW()-INTERVAL '5 minutes') RETURNING id",
            [part.id],
          );
          if (!rows.length) throw new BridgeError('REMINDER_RECENTLY_REQUESTED', 429);
          await provider.remind(document.id, recipients);
          reminders += recipients.length;
        } else if (action === 'cancel' || action === 'close') {
          if (!reason || reason.trim().length < 5) throw new BridgeError('REASON_REQUIRED', 400);
          if (document.status === 'COMPLETED' || document.status === 'REJECTED') continue;
          if (document.status === 'DRAFT') {
            if (action !== 'close') throw new BridgeError('DISCARD_DRAFT_EXPLICITLY', 409);
            await provider.deleteDraft(document.id);
            await this.store.query(
              "UPDATE signing.request_parts SET operation_state='discarded',last_error=NULL,updated_at=NOW() WHERE id=$1",
              [part.id],
            );
            await this.event(id, principal.clientId, 'request.draft_closed', principal.agentId, {
              partId: part.id,
              reason,
            });
            continue;
          }
          if (document.status !== 'CANCELLED') await provider.cancel(document.id, reason);
        } else {
          if (!reason || reason.trim().length < 5) throw new BridgeError('REASON_REQUIRED', 400);
          await provider.deleteDraft(document.id);
          await this.store.query(
            "UPDATE signing.request_parts SET operation_state='discarded',last_error=NULL,updated_at=NOW() WHERE id=$1",
            [part.id],
          );
          await this.store.query('DELETE FROM signing.request_uploads WHERE part_id=$1', [part.id]);
        }
        await this.event(id, principal.clientId, `request.${action}_requested`, principal.agentId, {
          partId: part.id,
          reason,
        });
        if (action !== 'discard') await this.syncPart(part, principal.clientId);
      }
      if (action === 'remind' && !reminders)
        throw new BridgeError('NO_CURRENT_UNSIGNED_RECIPIENT', 409);
    });
    return this.detail(principal, id);
  }
  async access(
    principal: Principal,
    requestId: string,
    partId: string,
    kind: 'editor' | 'signer',
    recipientId?: number,
  ) {
    const request = await this.request(principal, requestId);
    if (kind === 'editor') throw new BridgeError('PERSONAL_SIGNING_UNAVAILABLE', 403);
    if (isCustomerPackage(request.scenario))
      assertCompanyAccess(principal, request.input_snapshot.companyKey);
    const [part] = await this.store.query<PartRow>(
      'SELECT * FROM signing.request_parts WHERE id=$1 AND request_id=$2',
      [partId, requestId],
    );
    if (!part || part.operation_state !== 'linked') throw new BridgeError('NOT_FOUND', 404);
    return this.lease(requestId, async () => {
      const { document, connection, bindings } = await this.syncPart(part, principal.clientId),
        provider = this.provider(connection);
      if (document.status !== 'PENDING')
        throw new BridgeError('DOCUMENT_NOT_AWAITING_SIGNATURE', 409);
      const recipient = document.recipients.find(
        (r) => r.id === recipientId && principal.verifiedEmails.includes(r.email.toLowerCase()),
      );
      if (
        !recipient ||
        !recipientIsCurrent(projectEnvelope(document, bindings), recipient.id) ||
        recipient.role === 'CC' ||
        recipient.signingStatus !== 'NOT_SIGNED'
      )
        throw new BridgeError('SIGNER_ACCESS_DENIED', 403);
      if (recipient.expiresAt && Date.parse(recipient.expiresAt) <= Date.now())
        throw new BridgeError('SIGNING_LINK_EXPIRED', 409);
      if (connection.scope === 'company' || isCustomerPackage(request.scenario)) {
        const binding = bindings.find((b) => b.nativeId === recipient.id);
        if (
          !binding ||
          (binding.actor === 'owner'
            ? request.owner_agent_id !== principal.agentId
            : binding.actor !== 'company' || !principal.admin)
        )
          throw new BridgeError('SIGNER_ACCESS_DENIED', 403);
      }
      // Return the real native resume URL; no custom signing session is created.
      return { url: provider.signingUrl(recipient) };
    });
  }
  async download(
    principal: Principal,
    requestId: string,
    partId: string,
    kind: 'original' | 'signed' | 'audit-log' | 'certificate',
    itemId?: string,
  ) {
    await this.request(principal, requestId);
    const [part] = await this.store.query<PartRow>(
      'SELECT * FROM signing.request_parts WHERE id=$1 AND request_id=$2',
      [partId, requestId],
    );
    if (!part || part.operation_state !== 'linked') throw new BridgeError('NOT_FOUND', 404);
    return this.readLease(requestId, async () => {
      const { document, connection } = await this.syncPart(part, principal.clientId),
        provider = this.provider(connection);
      if (kind === 'audit-log' || kind === 'certificate')
        return provider.certificate(document.id, kind);
      if (!itemId) throw new BridgeError('DOCUMENT_ITEM_REQUIRED', 400);
      return provider.document(document.id, itemId, kind);
    });
  }
  private reviewHash(request: RequestRow, parts: PartRow[]) {
    return sha256(
      canonical({
        request: request.request_hash,
        parts: parts.map((p) => ({ id: p.id, providerId: p.provider_id, snapshot: p.snapshot })),
      }),
    );
  }
  async review(principal: Principal, id: string) {
    const request = await this.request(principal, id);
    if (!isCustomerPackage(request.scenario))
      throw new BridgeError('STANDARD_PACKAGE_REQUIRED', 400);
    assertCompanyAccess(principal, request.input_snapshot.companyKey);
    return this.readLease(id, async () => {
      const parts = await this.store.query<PartRow>(
        'SELECT * FROM signing.request_parts WHERE request_id=$1 ORDER BY part_index',
        [id],
      );
      const files = [];
      for (const part of parts) {
        if (part.operation_state !== 'linked') throw new BridgeError('DOCUMENT_NOT_READY', 409);
        const { document } = await this.syncPart(part, principal.clientId);
        if (document.status !== 'DRAFT') throw new BridgeError('DOCUMENT_CANNOT_BE_SENT', 409);
        assertHrDraft(document, part.snapshot);
        for (const file of document.envelopeItems)
          files.push({
            partId: part.id,
            id: file.id,
            title: file.title,
            fields: document.fields
              .filter((f) => f.envelopeItemId === file.id)
              .map((f) => previewField(f, document)),
          });
      }
      return { reviewHash: this.reviewHash(request, parts), files };
    });
  }
  async reissueSeed(principal: Principal, id: string) {
    const request = await this.request(principal, id);
    if (!isCustomerPackage(request.scenario))
      throw new BridgeError('STANDARD_PACKAGE_REQUIRED', 400);
    assertCompanyAccess(principal, request.input_snapshot.companyKey);
    await this.processRequest(id, principal.clientId);
    const parts = await this.store.query<PartRow>(
      'SELECT * FROM signing.request_parts WHERE request_id=$1',
      [id],
    );
    if (
      !parts.length ||
      parts.some(
        (p) =>
          p.operation_state !== 'discarded' &&
          (p.operation_state !== 'linked' ||
            p.delivery_state === 'unknown' ||
            !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(p.projection?.status ?? '')),
      )
    )
      throw new BridgeError('PREVIOUS_REQUEST_STILL_OPEN', 409);
    const {
      idempotencyKey: _key,
      externalReference: _ref,
      reissueReason: _reason,
      ...input
    } = request.input_snapshot;
    return { ...input, predecessorRequestId: id };
  }
  async bundle(principal: Principal, id: string) {
    const request = await this.request(principal, id);
    return this.readLease(id, async () => {
      const parts = await this.store.query<PartRow>(
        'SELECT * FROM signing.request_parts WHERE request_id=$1 ORDER BY part_index',
        [id],
      );
      if (!parts.length) throw new BridgeError('SIGNED_PDF_NOT_READY', 409);
      const entries: Record<string, Uint8Array> = {};
      const manifest: Array<{ path: string; sha256: string; bytes: number }> = [];
      let total = 0;
      const add = (path: string, bytes: Uint8Array) => {
        total += bytes.length;
        if (total > 200 * 1024 * 1024) throw new BridgeError('BUNDLE_TOO_LARGE', 413);
        entries[path] = bytes;
        manifest.push({ path, sha256: sha256(bytes), bytes: bytes.length });
      };
      for (const part of parts) {
        const { document, connection } = await this.syncPart(part, principal.clientId);
        if (document.status !== 'COMPLETED') throw new BridgeError('SIGNED_PDF_NOT_READY', 409);
        const provider = this.provider(connection),
          folder = String(part.part_index + 1).padStart(2, '0');
        for (const [index, file] of document.envelopeItems.entries())
          add(
            `${folder}/${String(index + 1).padStart(2, '0')}-${safeFilename(file.title)}.pdf`,
            await provider.document(document.id, file.id, 'signed'),
          );
        for (const kind of ['certificate', 'audit-log'] as const)
          add(`${folder}/${kind}.pdf`, await provider.certificate(document.id, kind));
      }
      entries['manifest.json'] = strToU8(
        JSON.stringify({ requestId: id, title: request.title, files: manifest }, null, 2),
      );
      return {
        name: `${safeFilename(request.title)}.zip`,
        bytes: Buffer.from(zipSync(entries, { level: 0 })),
      };
    });
  }
  async receiveWebhook(connectionId: string, raw: unknown) {
    const input = z
      .object({
        event: z.string().min(1).max(100),
        payload: z
          .object({
            envelopeId: z.string().min(1),
            externalId: z.string().nullable().optional(),
            teamId: z.number().int(),
            userId: z.number().int(),
          })
          .passthrough(),
      })
      .parse(raw);
    const [connection] = await this.store.query<Connection>(
      'SELECT * FROM signing.connections WHERE id=$1 AND revoked_at IS NULL',
      [connectionId],
    );
    if (
      !connection ||
      input.payload.teamId !== connection.team_id ||
      input.payload.userId !== connection.native_user_id
    )
      throw new BridgeError('WEBHOOK_SCOPE_MISMATCH', 403);
    if (!input.event.startsWith('DOCUMENT_') && input.event !== 'RECIPIENT_EXPIRED') return;
    const [part] = await this.store.query<PartRow>(
      'SELECT * FROM signing.request_parts WHERE connection_id=$1 AND (provider_id=$2 OR external_id=$3)',
      [connectionId, input.payload.envelopeId, input.payload.externalId ?? null],
    );
    if (!part) return; // Native documents outside Portal are not adopted implicitly.
    if (part.provider_id && part.provider_id !== input.payload.envelopeId)
      throw new BridgeError('WEBHOOK_DOCUMENT_CONFLICT', 409);
    const digest = sha256(canonical({ connectionId, event: input.event, payload: input.payload }));
    // Only routing information is retained. Raw payload contains signer tokens.
    await this.store.query(
      'INSERT INTO signing.webhook_inbox(digest,connection_id,event,provider_id,external_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(digest) DO NOTHING',
      [
        digest,
        connectionId,
        input.event,
        input.payload.envelopeId,
        input.payload.externalId ?? null,
      ],
    );
  }
  async deliverPortalEvents() {
    const messages = await this.store.transaction(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        request_id: string;
        client_id: string;
        owner_agent_id: number;
        scenario: string;
        created_at: Date;
        attempts: number;
      }>(
        'SELECT * FROM signing.portal_outbox WHERE delivered_at IS NULL AND next_attempt_at <= NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20',
      );
      for (const row of rows)
        await tx.query(
          "UPDATE signing.portal_outbox SET attempts=attempts+1,next_attempt_at=NOW()+INTERVAL '5 minutes' WHERE id=$1",
          [row.id],
        );
      return rows;
    });
    await Promise.all(
      messages.map(async (message) => {
        const client = this.config.clients.find((c) => c.id === message.client_id);
        let error = 'PORTAL_CALLBACK_NOT_CONFIGURED';
        if (client?.callbackSecret) {
          const body = JSON.stringify({
            id: message.id,
            event: 'signing.changed',
            requestId: message.request_id,
            ownerAgentId: message.owner_agent_id,
            scenario: message.scenario,
            occurredAt: message.created_at.toISOString(),
          });
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = createHmac('sha256', client.callbackSecret)
            .update(`${timestamp}.${body}`)
            .digest('hex');
          try {
            const response = await fetch(`${client.portalOrigin}/api/signing/events`, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
              headers: {
                'Content-Type': 'application/json',
                'X-ESign-Timestamp': timestamp,
                'X-ESign-Signature': signature,
              },
              body,
            });
            if (response.ok) {
              await this.store.query(
                'UPDATE signing.portal_outbox SET delivered_at=NOW(),last_error=NULL WHERE id=$1',
                [message.id],
              );
              return;
            }
            error = `PORTAL_CALLBACK_HTTP_${response.status}`;
          } catch {
            error = 'PORTAL_CALLBACK_UNAVAILABLE';
          }
        }
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(message.attempts, 7));
        await this.store.query(
          "UPDATE signing.portal_outbox SET last_error=$2,next_attempt_at=NOW()+($3 * INTERVAL '1 second') WHERE id=$1",
          [message.id, error, delaySeconds],
        );
      }),
    );
  }
  async reconcile() {
    const inbox = await this.store.query<{
      digest: string;
      connection_id: string;
      provider_id: string;
      external_id: string | null;
      client_id: string;
    }>(
      'SELECT w.*,c.client_id FROM signing.webhook_inbox w JOIN signing.connections c ON c.id=w.connection_id WHERE w.processed_at IS NULL AND w.next_attempt_at <= NOW() AND c.revoked_at IS NULL ORDER BY w.next_attempt_at,w.received_at,w.digest LIMIT 100',
    );
    for (const message of inbox) {
      try {
        const [part] = await this.store.query<PartRow>(
          'SELECT * FROM signing.request_parts WHERE connection_id=$1 AND (provider_id=$2 OR external_id=$3)',
          [message.connection_id, message.provider_id, message.external_id],
        );
        if (part && part.operation_state !== 'discarded') {
          await this.lease(part.request_id, async () => {
            if (part.provider_id && part.provider_id !== message.provider_id)
              throw new BridgeError('WEBHOOK_DOCUMENT_CONFLICT', 409);
            const connection = await this.connection(part.connection_id, message.client_id),
              document = await this.provider(connection).get(message.provider_id);
            assertNativeOwner(document, connection);
            if (document.externalId !== part.external_id)
              throw new BridgeError('WEBHOOK_DOCUMENT_CONFLICT', 409);
            await this.store.query(
              "UPDATE signing.request_parts SET provider_id=$2,operation_state='linked' WHERE id=$1",
              [part.id, document.id],
            );
            await this.syncPart({ ...part, provider_id: document.id }, message.client_id);
          });
        }
        await this.store.query(
          'UPDATE signing.webhook_inbox SET processed_at=NOW(),attempts=attempts+1,last_error=NULL WHERE digest=$1',
          [message.digest],
        );
      } catch (error) {
        await this.store.query(
          'UPDATE signing.webhook_inbox SET attempts=attempts+1,last_error=$2,next_attempt_at=NOW()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::int) WHERE digest=$1',
          [
            message.digest,
            error instanceof BridgeError || error instanceof ProviderError
              ? error.code
              : 'WEBHOOK_RECONCILE_FAILED',
          ],
        );
      }
    }
    const pending = await this.store.query<{
      request_id: string;
      client_id: string;
    }>(
      "SELECT p.request_id,r.client_id FROM signing.request_parts p JOIN signing.requests r ON r.id=p.request_id JOIN signing.connections c ON c.id=p.connection_id WHERE c.revoked_at IS NULL AND p.next_reconcile_at <= NOW() AND p.operation_state NOT IN ('failed','discarded') AND (p.last_synced_at IS NULL OR p.last_synced_at < NOW()-INTERVAL '2 minutes') AND (p.projection IS NULL OR p.projection->>'status' NOT IN ('COMPLETED','CANCELLED','REJECTED') OR p.last_error IS NOT NULL) GROUP BY p.request_id,r.client_id ORDER BY MIN(p.next_reconcile_at),p.request_id LIMIT 30",
    );
    for (const row of pending) {
      await this.store.query(
        'UPDATE signing.request_parts SET reconcile_attempts=reconcile_attempts+1,next_reconcile_at=NOW()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(reconcile_attempts,7)))::int) WHERE request_id=$1',
        [row.request_id],
      );
      try {
        await this.processRequest(row.request_id, row.client_id);
      } catch (error) {
        if (!(error instanceof BridgeError && error.code === 'REQUEST_BUSY'))
          await this.store.query(
            'UPDATE signing.request_parts SET last_error=$2 WHERE request_id=$1 AND operation_state<>$3',
            [
              row.request_id,
              error instanceof BridgeError || error instanceof ProviderError
                ? error.code
                : 'RECONCILE_FAILED',
              'discarded',
            ],
          );
      }
    }
    await this.store.query(
      "UPDATE signing.request_parts SET reconcile_attempts=0,next_reconcile_at=last_synced_at+INTERVAL '2 minutes' WHERE reconcile_attempts>0 AND last_error IS NULL AND last_synced_at > NOW()-INTERVAL '2 minutes'",
    );
    await this.deliverPortalEvents();
  }
}
