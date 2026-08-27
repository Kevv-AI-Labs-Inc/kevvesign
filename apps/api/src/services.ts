import { randomUUID } from 'node:crypto';
import type {
  ApplicationClient,
  BusinessDomain,
  CreateApplicationClientInput,
  CreateEnvelopeInput,
  CreateIntegrationSessionInput,
  CreateTemplateInput,
  CreateTransactionInput,
  Envelope,
  InvitationDelivery,
  IntegrationSessionExchange,
  PlatformState,
  Recipient,
  SaveSigningProgress,
  SigningContext,
  StaffPrincipal,
  Template,
  TemplateDocument,
  TemplateVersion,
  Transaction,
  UpdateTemplateDraftInput,
} from '@esign/contracts';
import {
  DomainError,
  appendAudit,
  applyMergeData,
  assertIdempotency,
  canonicalJson,
  createSecret,
  findEnvelope,
  findSession,
  findTemplate,
  findTransaction,
  newId,
  recordIdempotency,
  requirePermission,
  requireWorkspace,
  safeSecretEqual,
  sha256,
  transitionEnvelope,
  validateRecipientCompletion,
  validateTemplateForPublication,
  type Clock,
  type EmailPort,
  type EvidenceFinalizer,
  type FileScanner,
  type ObjectStore,
  type PlatformRepository,
  type SigningEngine,
  type SigningEngineEnvelope,
} from '@esign/domain';
import { inspectPdf } from '@esign/infrastructure';

const DISCLOSURE = {
  version: 'ESIGN-UETA-2026-08-01',
  title: 'Consent to electronic records and signatures',
  body: 'By selecting I agree, you consent to receive, review, and sign these records electronically. You may request a paper copy or withdraw consent before finishing by contacting the sender. Your typed or drawn signature and your selection of Finish are intended to sign the assigned records.',
};

type ApplicationClientView = Omit<ApplicationClient, 'secretHash'>;

function actorType(principal: StaffPrincipal): 'staff' | 'application' | 'integration' | 'portal' {
  return principal.actorType ?? 'staff';
}

function auditActor(principal: StaffPrincipal) {
  return {
    actorType: actorType(principal),
    actorId: principal.id,
    ...(principal.sourceApplicationClientId
      ? { sourceApplicationClientId: principal.sourceApplicationClientId }
      : {}),
  };
}

const ALL_BUSINESS_DOMAINS: readonly BusinessDomain[] = ['REAL_ESTATE', 'HR'];

function allowedBusinessDomains(principal: StaffPrincipal): readonly BusinessDomain[] {
  return actorType(principal) === 'staff'
    ? ALL_BUSINESS_DOMAINS
    : (principal.businessDomains ?? []);
}

function canAccessBusinessDomain(principal: StaffPrincipal, domain: BusinessDomain): boolean {
  return allowedBusinessDomains(principal).includes(domain);
}

function requireBusinessDomain(
  principal: StaffPrincipal,
  domain: BusinessDomain,
  conceal = false,
): void {
  if (canAccessBusinessDomain(principal, domain)) return;
  throw new DomainError(
    conceal ? 'not_found' : 'business_domain_forbidden',
    conceal ? 'Resource not found.' : 'Application credential cannot access this business domain.',
    conceal ? 404 : 403,
  );
}

function transactionBusinessDomain(kind: Transaction['kind']): BusinessDomain {
  return kind === 'HR_PACKET' ? 'HR' : 'REAL_ESTATE';
}

function templateBusinessDomain(template: Template): BusinessDomain | undefined {
  const domains = new Set(template.versions.map((version) => version.businessDomain));
  return domains.size === 1 ? [...domains][0] : undefined;
}

function requireTemplateAccess(principal: StaffPrincipal, template: Template): BusinessDomain {
  const domain = templateBusinessDomain(template);
  if (!domain) throw new DomainError('not_found', 'Resource not found.', 404);
  requireBusinessDomain(principal, domain, true);
  return domain;
}

function visibleTemplate(principal: StaffPrincipal, template: Template): Template | undefined {
  const domain = templateBusinessDomain(template);
  if (!domain || !canAccessBusinessDomain(principal, domain)) return undefined;
  if (
    actorType(principal) === 'staff' ||
    (actorType(principal) !== 'staff' && principal.delegatedScopes?.includes('templates:write'))
  )
    return structuredClone(template);
  const active = template.versions.find(
    (version) => version.id === template.activeVersionId && version.status === 'PUBLISHED',
  );
  return active ? { ...structuredClone(template), versions: [structuredClone(active)] } : undefined;
}

interface SigningEngineWebhookRecipient {
  id?: string | number | undefined;
  email: string;
  readStatus?: string | undefined;
  signingStatus?: string | undefined;
  signedAt?: string | null | undefined;
}

interface SigningEngineWebhookPayload {
  envelopeId: string;
  externalId?: string | null | undefined;
  status?: string | undefined;
  completedAt?: string | null | undefined;
  recipients?: SigningEngineWebhookRecipient[] | undefined;
}

function signingEngineWebhookMappingNotFound(): never {
  // Keep every identifier mismatch indistinguishable from a missing mapping. Webhooks are an
  // external trust boundary and must not reveal whether another local envelope or recipient exists.
  throw new DomainError('not_found', 'Envelope mapping was not found.', 404);
}

function resolveSigningEngineWebhookEnvelope(
  state: Readonly<PlatformState>,
  connectionId: string,
  payload: SigningEngineWebhookPayload,
  expectedLocalEnvelopeId?: string,
  allowExternalIdFallback = true,
): { envelope: Envelope; usedExternalIdFallback: boolean } {
  // A provider envelope ID is authoritative after it has been bound. Never let an externalId
  // override that binding, even if both values independently point at local envelopes.
  const providerMatches = state.envelopes.filter(
    (candidate) =>
      candidate.signingProviderConnectionId === connectionId &&
      candidate.signingEngineEnvelopeId === payload.envelopeId,
  );
  if (providerMatches.length > 1) signingEngineWebhookMappingNotFound();

  let envelope = providerMatches[0];
  let usedExternalIdFallback = false;
  if (envelope) {
    if (
      payload.externalId !== undefined &&
      payload.externalId !== null &&
      payload.externalId !== envelope.id
    ) {
      signingEngineWebhookMappingNotFound();
    }
  } else {
    if (!allowExternalIdFallback || !payload.externalId) signingEngineWebhookMappingNotFound();
    const fallbackMatches = state.envelopes.filter(
      (candidate) =>
        candidate.signingProviderConnectionId === connectionId &&
        candidate.signingEngineEnvelopeId === undefined &&
        candidate.signingEngineStatus === 'SYNCING' &&
        candidate.id === payload.externalId,
    );
    if (fallbackMatches.length !== 1) signingEngineWebhookMappingNotFound();
    envelope = fallbackMatches[0];
    usedExternalIdFallback = true;
  }

  if (!envelope || (expectedLocalEnvelopeId && envelope.id !== expectedLocalEnvelopeId)) {
    signingEngineWebhookMappingNotFound();
  }
  return { envelope, usedExternalIdFallback };
}

function validateSigningEngineWebhookRemoteEnvelope(
  remote: SigningEngineEnvelope,
  payload: SigningEngineWebhookPayload,
  localEnvelopeId: string,
): void {
  if (remote.id !== payload.envelopeId || remote.externalId !== localEnvelopeId) {
    throw new DomainError(
      'signing_engine_invalid_response',
      'Signing engine response identifiers are invalid.',
      502,
    );
  }
}

function signingEngineRecipientIdEqual(
  left: string | number | undefined,
  right: string | number | undefined,
): boolean {
  return left !== undefined && right !== undefined && String(left) === String(right);
}

function resolveSigningEngineWebhookRecipients(
  envelope: Envelope,
  remotes: readonly SigningEngineWebhookRecipient[],
): Array<{
  recipient: Recipient;
  remote: SigningEngineWebhookRecipient & { id: string | number };
  bindProviderRecipientId: boolean;
}> {
  const resolved: Array<{
    recipient: Recipient;
    remote: SigningEngineWebhookRecipient & { id: string | number };
    bindProviderRecipientId: boolean;
  }> = [];
  const claimedRecipientIds = new Set<string>();

  for (const remote of remotes) {
    const remoteId = remote.id;
    if (remoteId === undefined || String(remoteId).length === 0) {
      signingEngineWebhookMappingNotFound();
    }
    const normalizedEmail = remote.email.trim().toLowerCase();
    const providerMatches = envelope.recipients.filter((candidate) =>
      signingEngineRecipientIdEqual(candidate.signingEngineRecipientId, remoteId),
    );
    if (providerMatches.length > 1) signingEngineWebhookMappingNotFound();

    let recipient = providerMatches[0];
    let bindProviderRecipientId = false;
    if (recipient) {
      if (recipient.email.trim().toLowerCase() !== normalizedEmail) {
        signingEngineWebhookMappingNotFound();
      }
    } else {
      const emailMatches = envelope.recipients.filter(
        (candidate) =>
          candidate.signingEngineRecipientId === undefined &&
          candidate.email.trim().toLowerCase() === normalizedEmail,
      );
      if (emailMatches.length !== 1) signingEngineWebhookMappingNotFound();
      recipient = emailMatches[0];
      bindProviderRecipientId = true;
    }

    if (!recipient || claimedRecipientIds.has(recipient.id)) signingEngineWebhookMappingNotFound();
    claimedRecipientIds.add(recipient.id);
    resolved.push({
      recipient,
      remote: { ...remote, id: remoteId },
      bindProviderRecipientId,
    });
  }
  return resolved;
}

export interface RequestContext {
  requestId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

export class ESignService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly objects: ObjectStore,
    private readonly email: EmailPort,
    private readonly finalizer: EvidenceFinalizer,
    private readonly scanner: FileScanner,
    private readonly publicBaseUrl: string,
    private readonly clock: Clock,
    private readonly launchSessionTtlSeconds = 5 * 60,
    private readonly staffSessionTtlSeconds = 60 * 60,
    private readonly signingEngines: ReadonlyMap<string, SigningEngine> = new Map(),
  ) {}

  private signingConnection(
    state: Readonly<import('@esign/contracts').PlatformState>,
    workspaceId: string,
    frozenConnectionId?: string,
    hasProviderEnvelopeBinding = false,
  ): { connectionId: string; engine: SigningEngine } | undefined {
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new DomainError('not_found', 'Workspace not found.', 404);
    if (hasProviderEnvelopeBinding && !frozenConnectionId) {
      throw new DomainError(
        'signing_provider_unavailable',
        'The envelope signing provider connection is unavailable.',
        503,
      );
    }
    const connectionId = frozenConnectionId ?? workspace.signingProviderConnectionId;
    if (!connectionId) return undefined;
    const engine = this.signingEngines.get(connectionId);
    if (!engine) {
      throw new DomainError(
        'signing_provider_unavailable',
        'The workspace signing provider is unavailable.',
        503,
      );
    }
    return { connectionId, engine };
  }

  listApplicationClients(principal: StaffPrincipal): Promise<ApplicationClientView[]> {
    requirePermission(principal, 'workspace.manage');
    return this.repository.read((state) =>
      (state.applicationClients ?? [])
        .filter((client) => client.workspaceId === principal.workspaceId)
        .map(({ secretHash: _secretHash, ...client }) => structuredClone(client)),
    );
  }

  createApplicationClient(
    principal: StaffPrincipal,
    input: CreateApplicationClientInput,
    context: RequestContext,
  ): Promise<{ client: ApplicationClientView; credential: string }> {
    requirePermission(principal, 'workspace.manage');
    if (input.expiresAt && new Date(input.expiresAt) <= this.clock.now()) {
      throw new DomainError(
        'invalid_expiration',
        'Credential expiration must be in the future.',
        422,
      );
    }
    for (const returnUrl of input.allowedReturnUrls) {
      const parsed = new URL(returnUrl);
      if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        throw new DomainError(
          'invalid_return_url',
          'Integration return URLs must use HTTPS outside local development.',
          422,
        );
      }
    }
    const businessDomains = [...new Set(input.businessDomains)];
    if (businessDomains.length !== 1) {
      throw new DomainError(
        'business_domain_required',
        'Each application credential must belong to exactly one business domain.',
        422,
      );
    }
    const id = newId();
    const secret = createSecret(32);
    const now = this.clock.now().toISOString();
    const client: ApplicationClient = {
      id,
      workspaceId: principal.workspaceId,
      name: input.name,
      connectorKey: input.connectorKey ?? `client-${id}`,
      secretHash: sha256(secret),
      scopes: [...new Set(input.scopes)],
      businessDomains,
      allowedReturnUrls: [
        ...new Set(input.allowedReturnUrls.map((returnUrl) => new URL(returnUrl).toString())),
      ],
      status: 'ACTIVE',
      createdAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    return this.repository.write((state) => {
      state.applicationClients ??= [];
      if (
        state.applicationClients.some(
          (candidate) =>
            candidate.workspaceId === principal.workspaceId &&
            candidate.connectorKey === client.connectorKey &&
            candidate.status === 'ACTIVE',
        )
      ) {
        throw new DomainError(
          'connector_key_conflict',
          'An active integration already uses this connector key.',
          409,
        );
      }
      state.applicationClients.push(client);
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'application_client.created',
        occurredAt: now,
        requestId: context.requestId,
        payload: {
          clientId: id,
          scopes: client.scopes,
          businessDomains: client.businessDomains,
        },
      });
      const { secretHash: _secretHash, ...view } = client;
      return { client: structuredClone(view), credential: `${id}.${secret}` };
    });
  }

  rotateApplicationClient(
    principal: StaffPrincipal,
    clientId: string,
    context: RequestContext,
  ): Promise<{ client: ApplicationClientView; credential: string }> {
    requirePermission(principal, 'workspace.manage');
    const secret = createSecret(32);
    return this.repository.write((state) => {
      const client = (state.applicationClients ?? []).find(
        (candidate) => candidate.id === clientId && candidate.workspaceId === principal.workspaceId,
      );
      if (!client) throw new DomainError('not_found', 'Resource not found.', 404);
      if (client.status !== 'ACTIVE') {
        throw new DomainError('client_revoked', 'Revoked credentials cannot be rotated.', 409);
      }
      const now = this.clock.now().toISOString();
      client.secretHash = sha256(secret);
      client.rotatedAt = now;
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'application_client.rotated',
        occurredAt: now,
        requestId: context.requestId,
        payload: { clientId },
      });
      const { secretHash: _secretHash, ...view } = client;
      return { client: structuredClone(view), credential: `${client.id}.${secret}` };
    });
  }

  revokeApplicationClient(
    principal: StaffPrincipal,
    clientId: string,
    context: RequestContext,
  ): Promise<ApplicationClientView> {
    requirePermission(principal, 'workspace.manage');
    return this.repository.write((state) => {
      const client = (state.applicationClients ?? []).find(
        (candidate) => candidate.id === clientId && candidate.workspaceId === principal.workspaceId,
      );
      if (!client) throw new DomainError('not_found', 'Resource not found.', 404);
      client.status = 'REVOKED';
      const now = this.clock.now().toISOString();
      for (const session of state.staffSessions.filter(
        (candidate) => candidate.applicationClientId === clientId && !candidate.revokedAt,
      ))
        session.revokedAt = now;
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'application_client.revoked',
        occurredAt: now,
        requestId: context.requestId,
        payload: { clientId },
      });
      const { secretHash: _secretHash, ...view } = client;
      return structuredClone(view);
    });
  }

  createIntegrationSession(
    principal: StaffPrincipal,
    input: CreateIntegrationSessionInput,
    context: RequestContext,
  ): Promise<{ launchUrl: string; expiresAt: string }> {
    if (actorType(principal) !== 'application' || !principal.sourceApplicationClientId) {
      throw new DomainError(
        'application_auth_required',
        'Integration sessions must be created by an application.',
        403,
      );
    }
    const ticket = createSecret(32);
    return this.repository.write((state) => {
      const client = state.applicationClients.find(
        (candidate) =>
          candidate.id === principal.sourceApplicationClientId &&
          candidate.workspaceId === principal.workspaceId,
      );
      const normalizedReturnUrl = new URL(input.returnUrl).toString();
      if (
        !client ||
        client.businessDomains?.length !== 1 ||
        !client.allowedReturnUrls?.includes(normalizedReturnUrl)
      ) {
        throw new DomainError(
          'return_url_not_allowed',
          'Integration return URL is not registered for this application.',
          422,
        );
      }
      if (input.intent.kind === 'edit-template') {
        const template = visibleTemplate(
          principal,
          findTemplate(state, principal.workspaceId, input.intent.templateId),
        );
        if (!template) throw new DomainError('not_found', 'Resource not found.', 404);
      }
      if (input.intent.kind === 'prepare-envelope' && input.intent.templateId) {
        const template = findTemplate(state, principal.workspaceId, input.intent.templateId);
        const visible = visibleTemplate(principal, template);
        if (!visible) throw new DomainError('not_found', 'Resource not found.', 404);
        const active = visible.versions.find(
          (version) => version.id === visible.activeVersionId && version.status === 'PUBLISHED',
        );
        if (!active) {
          throw new DomainError(
            'template_unavailable',
            'Template has no active published version.',
            409,
          );
        }
      }
      if (input.intent.kind === 'view-envelope') {
        const envelope = findEnvelope(state, principal.workspaceId, input.intent.envelopeId);
        requireBusinessDomain(principal, envelope.businessDomain, true);
      }
      const now = this.clock.now();
      const expiresAt = new Date(now.getTime() + this.launchSessionTtlSeconds * 1000).toISOString();
      state.integrationLaunchSessions.push({
        id: newId(),
        ticketHash: sha256(ticket),
        workspaceId: principal.workspaceId,
        applicationClientId: client.id,
        actor: structuredClone(input.actor),
        intent: structuredClone(input.intent),
        returnUrl: normalizedReturnUrl,
        createdAt: now.toISOString(),
        expiresAt,
      });
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'integration_session.issued',
        occurredAt: now.toISOString(),
        requestId: context.requestId,
        payload: { delegatedSubject: input.actor.subject, intent: input.intent.kind },
      });
      return {
        launchUrl: `${this.publicBaseUrl.replace(/\/$/, '')}/integration/launch#ticket=${encodeURIComponent(ticket)}`,
        expiresAt,
      };
    });
  }

  exchangeIntegrationSession(
    ticket: string,
    context: RequestContext,
  ): Promise<{ sessionSecret: string; exchange: IntegrationSessionExchange }> {
    return this.repository.write((state) => {
      const launch = state.integrationLaunchSessions.find((candidate) =>
        safeSecretEqual(ticket, candidate.ticketHash),
      );
      const now = this.clock.now();
      const client = launch
        ? state.applicationClients.find(
            (candidate) =>
              candidate.id === launch.applicationClientId &&
              candidate.workspaceId === launch.workspaceId,
          )
        : undefined;
      if (
        !launch ||
        launch.usedAt ||
        new Date(launch.expiresAt) <= now ||
        !client ||
        client.status !== 'ACTIVE' ||
        client.businessDomains?.length !== 1 ||
        (client.expiresAt && new Date(client.expiresAt) <= now)
      ) {
        throw new DomainError(
          'integration_session_unavailable',
          'This integration launch session is unavailable.',
          410,
        );
      }
      launch.usedAt = now.toISOString();
      const sessionSecret = createSecret(32);
      const csrfToken = createSecret(24);
      const clientExpiration = client.expiresAt
        ? new Date(client.expiresAt).getTime()
        : Number.POSITIVE_INFINITY;
      const expiresAt = new Date(
        Math.min(now.getTime() + this.staffSessionTtlSeconds * 1000, clientExpiration),
      ).toISOString();
      state.staffSessions.push({
        id: newId(),
        sessionHash: sha256(sessionSecret),
        csrfHash: sha256(csrfToken),
        workspaceId: launch.workspaceId,
        applicationClientId: client.id,
        actor: structuredClone(launch.actor),
        intent: structuredClone(launch.intent),
        returnUrl: launch.returnUrl,
        scopes: structuredClone(client.scopes),
        createdAt: now.toISOString(),
        expiresAt,
      });
      const principal: StaffPrincipal = {
        id: launch.actor.subject,
        email: launch.actor.email,
        displayName: launch.actor.displayName,
        role: launch.actor.role,
        workspaceId: launch.workspaceId,
        actorType: 'integration',
        sourceApplicationClientId: client.id,
        sourceApplicationName: client.name,
        delegatedScopes: structuredClone(client.scopes),
        businessDomains: structuredClone(client.businessDomains),
        returnUrl: launch.returnUrl,
      };
      appendAudit(state, {
        workspaceId: launch.workspaceId,
        ...auditActor(principal),
        type: 'integration_session.exchanged',
        occurredAt: now.toISOString(),
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        payload: { intent: launch.intent.kind },
      });
      return {
        sessionSecret,
        exchange: {
          principal,
          csrfToken,
          destination: this.integrationDestination(launch.intent),
          returnUrl: launch.returnUrl,
          expiresAt,
        },
      };
    });
  }

  logoutIntegrationSession(
    principal: StaffPrincipal,
    sessionSecret: string,
    context: RequestContext,
  ): Promise<{ returnUrl: string }> {
    if (!['integration', 'portal'].includes(actorType(principal))) {
      throw new DomainError(
        'integration_session_required',
        'Integration session is required.',
        409,
      );
    }
    return this.repository.write((state) => {
      const session = state.staffSessions.find((candidate) =>
        safeSecretEqual(sessionSecret, candidate.sessionHash),
      );
      if (!session || session.revokedAt) {
        throw new DomainError('staff_session_invalid', 'Staff session is unavailable.', 401);
      }
      const now = this.clock.now().toISOString();
      session.revokedAt = now;
      appendAudit(state, {
        workspaceId: session.workspaceId,
        ...auditActor(principal),
        type: 'integration_session.ended',
        occurredAt: now,
        requestId: context.requestId,
        payload: {},
      });
      return { returnUrl: session.returnUrl };
    });
  }

  private integrationDestination(intent: CreateIntegrationSessionInput['intent']): string {
    switch (intent.kind) {
      case 'edit-template':
        return `/templates/${intent.templateId}/edit`;
      case 'view-envelope':
        return `/envelopes/${intent.envelopeId}`;
      case 'prepare-envelope':
        return intent.templateId
          ? `/envelopes/new?templateId=${encodeURIComponent(intent.templateId)}`
          : '/envelopes/new';
      default:
        return '/';
    }
  }

  listTemplates(principal: StaffPrincipal): Promise<Template[]> {
    requirePermission(principal, 'template.read');
    return this.repository.read((state) =>
      state.templates
        .filter((template) => template.workspaceId === principal.workspaceId)
        .map((template) => visibleTemplate(principal, template))
        .filter((template): template is Template => Boolean(template)),
    );
  }

  getTemplate(principal: StaffPrincipal, templateId: string): Promise<Template> {
    requirePermission(principal, 'template.read');
    return this.repository.read((state) => {
      const template = visibleTemplate(
        principal,
        findTemplate(state, principal.workspaceId, templateId),
      );
      if (!template) throw new DomainError('not_found', 'Resource not found.', 404);
      return template;
    });
  }

  async createTemplate(
    principal: StaffPrincipal,
    input: CreateTemplateInput,
    file: { bytes: Uint8Array; filename: string; mimetype: string },
    context: RequestContext,
  ): Promise<Template> {
    requirePermission(principal, 'template.manage');
    requireBusinessDomain(principal, input.businessDomain);
    if (file.bytes.byteLength > 30 * 1024 * 1024)
      throw new DomainError('file_too_large', 'PDF exceeds the 30 MB limit.', 413);
    if (file.mimetype !== 'application/pdf' || !file.filename.toLowerCase().endsWith('.pdf')) {
      throw new DomainError('invalid_file_type', 'Only PDF files are accepted.', 422);
    }
    await this.scanner.scan(file.bytes);
    const metadata = await inspectPdf(file.bytes);
    const templateId = newId();
    const versionId = newId();
    const documentId = newId();
    const objectKey = `templates/${principal.workspaceId}/${templateId}/${versionId}/${documentId}.pdf`;
    const digest = sha256(file.bytes);
    await this.objects.put(objectKey, file.bytes, 'application/pdf');
    const now = this.clock.now().toISOString();
    const document: TemplateDocument = {
      id: documentId,
      name: file.filename.replace(/[\\/]/g, '_').slice(0, 180),
      objectKey,
      sha256: digest,
      pageCount: metadata.pageCount,
      order: 0,
      retentionClass: input.retentionPolicyId,
      detectedMime: 'application/pdf',
    };
    const defaultRoleId = newId();
    const version: TemplateVersion = {
      id: versionId,
      version: 1,
      status: 'DRAFT',
      createdAt: now,
      sourceName: input.sourceName,
      licenseOwner: input.licenseOwner,
      edition: input.edition,
      effectiveDate: input.effectiveDate,
      jurisdiction: input.jurisdiction,
      businessDomain: input.businessDomain,
      approvalRequired: input.approvalRequired,
      retentionPolicyId: input.retentionPolicyId,
      documents: [document],
      roles: [
        {
          id: defaultRoleId,
          name: input.businessDomain === 'HR' ? 'Employee' : 'Signer 1',
          kind: 'signer',
          routingOrder: 1,
        },
      ],
      fields: [],
    };
    const template: Template = {
      id: templateId,
      workspaceId: principal.workspaceId,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      versions: [version],
    };
    return this.repository.write((state) => {
      state.templates.push(template);
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'template.created',
        occurredAt: now,
        requestId: context.requestId,
        payload: { templateId, versionId, documentSha256: digest, pageCount: metadata.pageCount },
      });
      return structuredClone(template);
    });
  }

  updateDraft(
    principal: StaffPrincipal,
    templateId: string,
    versionId: string,
    input: UpdateTemplateDraftInput,
    context: RequestContext,
  ): Promise<TemplateVersion> {
    requirePermission(principal, 'template.manage');
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const version = template.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, version.businessDomain, true);
      if (version.status !== 'DRAFT')
        throw new DomainError(
          'immutable_version',
          'Published template versions cannot be edited.',
          409,
        );
      version.roles = structuredClone(input.roles);
      version.fields = structuredClone(input.fields);
      template.updatedAt = this.clock.now().toISOString();
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'template.draft.updated',
        occurredAt: template.updatedAt,
        requestId: context.requestId,
        payload: {
          templateId,
          versionId,
          roleCount: version.roles.length,
          fieldCount: version.fields.length,
        },
      });
      return structuredClone(version);
    });
  }

  async addTemplateDocument(
    principal: StaffPrincipal,
    templateId: string,
    versionId: string,
    file: { bytes: Uint8Array; filename: string; mimetype: string },
    retentionClass: string,
    context: RequestContext,
  ): Promise<TemplateDocument> {
    requirePermission(principal, 'template.manage');
    await this.repository.read((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const version = template.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, version.businessDomain, true);
      if (version.status !== 'DRAFT') {
        throw new DomainError(
          'immutable_version',
          'Published template versions cannot be edited.',
          409,
        );
      }
    });
    if (file.bytes.byteLength > 30 * 1024 * 1024) {
      throw new DomainError('file_too_large', 'PDF exceeds the 30 MB limit.', 413);
    }
    if (file.mimetype !== 'application/pdf' || !file.filename.toLowerCase().endsWith('.pdf')) {
      throw new DomainError('invalid_file_type', 'Only PDF files are accepted.', 422);
    }
    await this.scanner.scan(file.bytes);
    const metadata = await inspectPdf(file.bytes);
    const documentId = newId();
    const objectKey = `templates/${principal.workspaceId}/${templateId}/${versionId}/${documentId}.pdf`;
    const digest = sha256(file.bytes);
    await this.objects.put(objectKey, file.bytes, 'application/pdf');
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const version = template.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, version.businessDomain, true);
      if (version.status !== 'DRAFT') {
        throw new DomainError(
          'immutable_version',
          'Published template versions cannot be edited.',
          409,
        );
      }
      const document: TemplateDocument = {
        id: documentId,
        name: file.filename.replace(/[\\/]/g, '_').slice(0, 180),
        objectKey,
        sha256: digest,
        pageCount: metadata.pageCount,
        order: version.documents.length,
        retentionClass: retentionClass.slice(0, 80),
        detectedMime: 'application/pdf',
      };
      version.documents.push(document);
      template.updatedAt = this.clock.now().toISOString();
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'template.document.added',
        occurredAt: template.updatedAt,
        requestId: context.requestId,
        payload: {
          templateId,
          versionId,
          documentId,
          documentSha256: digest,
          pageCount: metadata.pageCount,
        },
      });
      return structuredClone(document);
    });
  }

  publishTemplate(
    principal: StaffPrincipal,
    templateId: string,
    versionId: string,
    context: RequestContext,
  ): Promise<TemplateVersion> {
    requirePermission(principal, 'template.manage');
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const version = template.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, version.businessDomain, true);
      if (version.status !== 'DRAFT')
        throw new DomainError('invalid_template_state', 'Only a draft can be published.', 409);
      validateTemplateForPublication(version);
      const now = this.clock.now().toISOString();
      version.schemaHash = sha256(
        JSON.stringify({
          documents: version.documents,
          roles: version.roles,
          fields: version.fields,
        }),
      );
      version.status = 'PUBLISHED';
      version.publishedAt = now;
      template.activeVersionId = version.id;
      template.updatedAt = now;
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'template.published',
        occurredAt: now,
        requestId: context.requestId,
        payload: { templateId, versionId, schemaHash: version.schemaHash },
      });
      return structuredClone(version);
    });
  }

  cloneTemplateVersion(
    principal: StaffPrincipal,
    templateId: string,
    sourceVersionId: string,
  ): Promise<TemplateVersion> {
    requirePermission(principal, 'template.manage');
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const source = template.versions.find((candidate) => candidate.id === sourceVersionId);
      if (!source) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, source.businessDomain, true);
      const now = this.clock.now().toISOString();
      const version: TemplateVersion = {
        ...structuredClone(source),
        id: newId(),
        version: Math.max(...template.versions.map((candidate) => candidate.version)) + 1,
        status: 'DRAFT',
        createdAt: now,
      };
      delete version.publishedAt;
      delete version.retiredAt;
      delete version.schemaHash;
      template.versions.push(version);
      template.updatedAt = now;
      return structuredClone(version);
    });
  }

  retireTemplateVersion(
    principal: StaffPrincipal,
    templateId: string,
    versionId: string,
  ): Promise<TemplateVersion> {
    requirePermission(principal, 'template.manage');
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      requireTemplateAccess(principal, template);
      const version = template.versions.find((candidate) => candidate.id === versionId);
      if (!version) throw new DomainError('not_found', 'Template version not found.', 404);
      requireBusinessDomain(principal, version.businessDomain, true);
      if (version.status !== 'PUBLISHED')
        throw new DomainError(
          'invalid_template_state',
          'Only a published version can be retired.',
          409,
        );
      version.status = 'RETIRED';
      version.retiredAt = this.clock.now().toISOString();
      if (template.activeVersionId === version.id) delete template.activeVersionId;
      return structuredClone(version);
    });
  }

  async templateDocument(
    principal: StaffPrincipal,
    templateId: string,
    documentId: string,
  ): Promise<Uint8Array> {
    requirePermission(principal, 'template.read');
    const key = await this.repository.read((state) => {
      const template = findTemplate(state, principal.workspaceId, templateId);
      const visible = visibleTemplate(principal, template);
      if (!visible) throw new DomainError('not_found', 'Resource not found.', 404);
      const document = visible.versions
        .flatMap((version) => version.documents)
        .find((candidate) => candidate.id === documentId);
      if (!document) throw new DomainError('not_found', 'Document not found.', 404);
      return document.objectKey;
    });
    return this.objects.get(key);
  }

  listTransactions(principal: StaffPrincipal): Promise<Transaction[]> {
    requirePermission(principal, 'transaction.read');
    return this.repository.read((state) =>
      state.transactions.filter(
        (item) =>
          item.workspaceId === principal.workspaceId &&
          canAccessBusinessDomain(principal, transactionBusinessDomain(item.kind)),
      ),
    );
  }

  createTransaction(
    principal: StaffPrincipal,
    input: CreateTransactionInput,
    context: RequestContext,
  ): Promise<Transaction> {
    requirePermission(principal, 'transaction.manage');
    requireBusinessDomain(principal, transactionBusinessDomain(input.kind));
    const now = this.clock.now().toISOString();
    const transaction: Transaction = {
      id: newId(),
      workspaceId: principal.workspaceId,
      kind: input.kind,
      name: input.name,
      jurisdiction: input.jurisdiction,
      envelopeIds: [],
      createdAt: now,
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.propertyAddress ? { propertyAddress: input.propertyAddress } : {}),
    };
    return this.repository.write((state) => {
      if (
        transaction.externalReference &&
        state.transactions.some(
          (item) =>
            item.workspaceId === principal.workspaceId &&
            transactionBusinessDomain(item.kind) === transactionBusinessDomain(transaction.kind) &&
            item.externalReference === transaction.externalReference,
        )
      ) {
        throw new DomainError(
          'external_reference_conflict',
          'External reference is already in use.',
          409,
        );
      }
      state.transactions.push(transaction);
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        ...auditActor(principal),
        type: 'transaction.created',
        occurredAt: now,
        requestId: context.requestId,
        payload: { transactionId: transaction.id, kind: transaction.kind },
      });
      return structuredClone(transaction);
    });
  }

  listEnvelopes(principal: StaffPrincipal): Promise<Envelope[]> {
    requirePermission(principal, 'envelope.read');
    return this.repository.read((state) =>
      state.envelopes.filter(
        (envelope) =>
          envelope.workspaceId === principal.workspaceId &&
          canAccessBusinessDomain(principal, envelope.businessDomain),
      ),
    );
  }

  getEnvelope(principal: StaffPrincipal, envelopeId: string): Promise<Envelope> {
    requirePermission(principal, 'envelope.read');
    return this.repository.read((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      return structuredClone(envelope);
    });
  }

  createEnvelope(
    principal: StaffPrincipal,
    input: CreateEnvelopeInput,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<Envelope> {
    requirePermission(principal, 'envelope.manage');
    if (!idempotencyKey)
      throw new DomainError('idempotency_required', 'Idempotency-Key is required.', 400);
    return this.repository.write((state) => {
      const template = findTemplate(state, principal.workspaceId, input.templateId);
      const version = template.versions.find(
        (candidate) => candidate.id === template.activeVersionId,
      );
      if (!version || version.status !== 'PUBLISHED') {
        throw new DomainError(
          'template_unavailable',
          'Template has no active published version.',
          409,
        );
      }
      if (input.expectedTemplateVersionId && input.expectedTemplateVersionId !== version.id) {
        throw new DomainError(
          'template_version_mismatch',
          'The active template version does not match the expected version.',
          409,
        );
      }
      if (
        input.expectedTemplateSchemaHash &&
        input.expectedTemplateSchemaHash !== version.schemaHash
      ) {
        throw new DomainError(
          'template_schema_mismatch',
          'The active template schema does not match the expected schema.',
          409,
        );
      }
      const templateDomain = templateBusinessDomain(template);
      if (!templateDomain || templateDomain !== version.businessDomain) {
        throw new DomainError('not_found', 'Resource not found.', 404);
      }
      requireBusinessDomain(principal, version.businessDomain);
      const idempotencyOperation = `create-envelope:${version.businessDomain}`;
      const replay = assertIdempotency(
        state,
        principal.workspaceId,
        idempotencyOperation,
        idempotencyKey,
        input,
      );
      if (replay) {
        const envelope = findEnvelope(state, principal.workspaceId, (replay as { id: string }).id);
        requireBusinessDomain(principal, envelope.businessDomain, true);
        return structuredClone(envelope);
      }
      if (input.transactionId) {
        const transaction = findTransaction(state, principal.workspaceId, input.transactionId);
        const transactionDomain = transactionBusinessDomain(transaction.kind);
        requireBusinessDomain(principal, transactionDomain, true);
        if (transactionDomain !== version.businessDomain) {
          throw new DomainError(
            'business_domain_mismatch',
            'Transaction and template must use the same business domain.',
            422,
          );
        }
      }
      if (
        input.externalReference &&
        state.envelopes.some(
          (candidate) =>
            candidate.workspaceId === principal.workspaceId &&
            candidate.businessDomain === version.businessDomain &&
            candidate.externalReference === input.externalReference,
        )
      ) {
        throw new DomainError(
          'external_reference_conflict',
          'External reference is already in use.',
          409,
        );
      }
      const roleMap = new Map(version.roles.map((role) => [role.id, role]));
      const suppliedRoleIds = input.recipients.map((recipient) => recipient.roleId);
      if (new Set(suppliedRoleIds).size !== suppliedRoleIds.length) {
        throw new DomainError(
          'duplicate_role',
          'Each template role must be assigned to exactly one recipient.',
          422,
        );
      }
      const missingRoles = version.roles.filter((role) => !suppliedRoleIds.includes(role.id));
      if (missingRoles.length > 0) {
        throw new DomainError(
          'missing_role',
          'Every template role must be assigned to a recipient.',
          422,
        );
      }
      const mergeValues = applyMergeData(version.fields, input.mergeData);
      const recipients: Recipient[] = input.recipients.map((candidate) => {
        const role = roleMap.get(candidate.roleId);
        if (!role)
          throw new DomainError(
            'invalid_role',
            'A recipient role is not part of the template.',
            422,
          );
        return {
          id: newId(),
          roleId: role.id,
          name: candidate.name,
          email: candidate.email.toLowerCase(),
          kind: role.kind,
          routingOrder: role.routingOrder,
          status: 'PENDING',
          assuranceMethod: candidate.accessCode ? 'access_code' : 'email_invitation',
          accessCodeFailures: 0,
          values: structuredClone(mergeValues),
          ...(candidate.accessCode ? { accessCodeHash: sha256(candidate.accessCode) } : {}),
        };
      });
      const now = this.clock.now().toISOString();
      const envelope: Envelope = {
        id: newId(),
        workspaceId: principal.workspaceId,
        templateId: template.id,
        templateVersionId: version.id,
        subject: input.subject,
        message: input.message,
        status: 'PREPARED',
        jurisdiction: version.jurisdiction,
        businessDomain: version.businessDomain,
        approvalRequired: version.approvalRequired,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
        version: 1,
        documents: version.documents.map((document) => ({
          ...structuredClone(document),
          sourceSha256: document.sha256,
        })),
        fields: structuredClone(version.fields),
        recipients,
        retentionPolicyId: version.retentionPolicyId,
        ...(input.transactionId ? { transactionId: input.transactionId } : {}),
        ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      };
      state.envelopes.push(envelope);
      if (input.transactionId)
        findTransaction(state, principal.workspaceId, input.transactionId).envelopeIds.push(
          envelope.id,
        );
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        envelopeId: envelope.id,
        ...auditActor(principal),
        type: 'envelope.created',
        occurredAt: now,
        requestId: context.requestId,
        payload: {
          templateId: template.id,
          templateVersionId: version.id,
          recipientCount: recipients.length,
        },
      });
      recordIdempotency(
        state,
        principal.workspaceId,
        idempotencyOperation,
        idempotencyKey,
        input,
        { id: envelope.id },
        now,
      );
      return structuredClone(envelope);
    });
  }

  approveEnvelope(
    principal: StaffPrincipal,
    envelopeId: string,
    context: RequestContext,
  ): Promise<Envelope> {
    requirePermission(principal, 'envelope.approve');
    return this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      if (envelope.status !== 'APPROVAL_PENDING') {
        throw new DomainError('invalid_transition', 'Envelope is not awaiting approval.', 409);
      }
      const now = this.clock.now().toISOString();
      envelope.approvedAt = now;
      envelope.approvedBy = principal.id;
      transitionEnvelope(envelope, 'READY_TO_SEND', now);
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        envelopeId,
        ...auditActor(principal),
        type: 'envelope.approved',
        occurredAt: now,
        requestId: context.requestId,
        payload: {},
      });
      return structuredClone(envelope);
    });
  }

  async sendEnvelope(
    principal: StaffPrincipal,
    envelopeId: string,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<{ envelope: Envelope; replayed: boolean; invitationUrls: string[] }> {
    requirePermission(principal, 'envelope.send');
    if (!idempotencyKey)
      throw new DomainError('idempotency_required', 'Idempotency-Key is required.', 400);
    const connection = await this.repository.read((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      return this.signingConnection(
        state,
        principal.workspaceId,
        envelope.signingProviderConnectionId,
        envelope.signingEngineEnvelopeId !== undefined,
      );
    });
    if (connection) {
      return this.sendWithSigningEngine(principal, envelopeId, idempotencyKey, context, connection);
    }
    const result = await this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      const replay = assertIdempotency(
        state,
        principal.workspaceId,
        `send:${envelopeId}`,
        idempotencyKey,
        { envelopeId },
      );
      if (replay)
        return {
          envelope: structuredClone(envelope),
          replayed: true,
          invitations: [] as InvitationDelivery[],
        };
      if (envelope.approvalRequired && !envelope.approvedAt) {
        if (envelope.status === 'PREPARED')
          transitionEnvelope(envelope, 'APPROVAL_PENDING', this.clock.now().toISOString());
        return {
          envelope: structuredClone(envelope),
          replayed: false,
          invitations: [] as InvitationDelivery[],
        };
      }
      if (envelope.status === 'PREPARED')
        transitionEnvelope(envelope, 'READY_TO_SEND', this.clock.now().toISOString());
      if (envelope.status !== 'READY_TO_SEND')
        throw new DomainError('invalid_transition', 'Envelope cannot be sent.', 409);
      const now = this.clock.now().toISOString();
      transitionEnvelope(envelope, 'SENT', now);
      const firstOrder = Math.min(
        ...envelope.recipients
          .filter((recipient) => !['copy', 'viewer'].includes(recipient.kind))
          .map((recipient) => recipient.routingOrder),
      );
      const invitations: InvitationDelivery[] = [];
      for (const recipient of envelope.recipients) {
        const token = createSecret(32);
        recipient.invitationHash = sha256(token);
        recipient.invitationExpiresAt = envelope.expiresAt;
        if (recipient.routingOrder === firstOrder && !['copy', 'viewer'].includes(recipient.kind))
          recipient.status = 'ACTIVE';
        if (recipient.status === 'ACTIVE') {
          invitations.push({
            recipientId: recipient.id,
            email: recipient.email,
            token,
            invitationUrl: `${this.publicBaseUrl}/sign/${token}`,
          });
        }
      }
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        envelopeId,
        ...auditActor(principal),
        type: 'envelope.sent',
        occurredAt: now,
        requestId: context.requestId,
        payload: { activeRecipientCount: invitations.length },
      });
      recordIdempotency(
        state,
        principal.workspaceId,
        `send:${envelopeId}`,
        idempotencyKey,
        { envelopeId },
        { id: envelope.id },
        now,
      );
      return { envelope: structuredClone(envelope), replayed: false, invitations };
    });
    for (const invitation of result.invitations)
      await this.deliverInvitation(result.envelope, invitation);
    return {
      envelope: result.envelope,
      replayed: result.replayed,
      invitationUrls: result.invitations.map((invitation) => invitation.invitationUrl),
    };
  }

  private async sendWithSigningEngine(
    principal: StaffPrincipal,
    envelopeId: string,
    idempotencyKey: string,
    context: RequestContext,
    connection: { connectionId: string; engine: SigningEngine },
  ): Promise<{ envelope: Envelope; replayed: boolean; invitationUrls: string[] }> {
    const { connectionId, engine } = connection;
    const prepared = await this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      if (
        envelope.signingProviderConnectionId &&
        envelope.signingProviderConnectionId !== connectionId
      ) {
        throw new DomainError(
          'signing_provider_mismatch',
          'Envelope is assigned to a different signing provider connection.',
          409,
        );
      }
      const replay = assertIdempotency(
        state,
        principal.workspaceId,
        `send:${envelopeId}`,
        idempotencyKey,
        { envelopeId },
      );
      if (replay) return { envelope: structuredClone(envelope), replayed: true, proceed: false };
      if (envelope.approvalRequired && !envelope.approvedAt) {
        if (envelope.status === 'PREPARED') {
          transitionEnvelope(envelope, 'APPROVAL_PENDING', this.clock.now().toISOString());
        }
        return { envelope: structuredClone(envelope), replayed: false, proceed: false };
      }
      if (envelope.status === 'PREPARED') {
        transitionEnvelope(envelope, 'READY_TO_SEND', this.clock.now().toISOString());
      }
      if (envelope.status !== 'READY_TO_SEND') {
        throw new DomainError('invalid_transition', 'Envelope cannot be sent.', 409);
      }
      const now = this.clock.now();
      if (
        envelope.signingEngineStatus === 'SYNCING' &&
        envelope.signingEngineSyncedAt &&
        now.getTime() - new Date(envelope.signingEngineSyncedAt).getTime() < 5 * 60 * 1000
      ) {
        throw new DomainError(
          'signing_engine_operation_in_progress',
          'Envelope is already being prepared by the signing engine.',
          409,
        );
      }
      envelope.signingProviderConnectionId = connectionId;
      envelope.signingEngine = engine.provider;
      envelope.signingEngineStatus = 'SYNCING';
      envelope.signingEngineSyncedAt = now.toISOString();
      return { envelope: structuredClone(envelope), replayed: false, proceed: true };
    });
    if (!prepared.proceed) {
      return { envelope: prepared.envelope, replayed: prepared.replayed, invitationUrls: [] };
    }

    try {
      let external = prepared.envelope.signingEngineEnvelopeId
        ? await engine.getEnvelope(prepared.envelope.signingEngineEnvelopeId)
        : await engine.findEnvelopeByExternalId(prepared.envelope.id);
      if (!external) {
        const documents = await Promise.all(
          prepared.envelope.documents.map(async (document) => ({
            id: document.id,
            name: document.name,
            order: document.order,
            bytes: await this.objects.get(document.objectKey),
          })),
        );
        external = await engine.createEnvelope(prepared.envelope, documents);
      }
      if (external.status === 'DRAFT') {
        external = await engine.distributeEnvelope(external.id);
      }
      const firstRoutingOrder = Math.min(
        ...prepared.envelope.recipients
          .filter((recipient) => !['copy', 'viewer'].includes(recipient.kind))
          .map((recipient) => recipient.routingOrder),
      );
      const updated = await this.repository.write((state) => {
        const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
        requireBusinessDomain(principal, envelope.businessDomain, true);
        if (envelope.signingProviderConnectionId !== connectionId) {
          throw new DomainError(
            'signing_provider_mismatch',
            'Envelope is assigned to a different signing provider connection.',
            409,
          );
        }
        envelope.signingEngine = engine.provider;
        envelope.signingEngineEnvelopeId = external.id;
        envelope.signingEngineStatus = external.status;
        envelope.signingEngineSyncedAt = this.clock.now().toISOString();
        if (envelope.status === 'READY_TO_SEND') {
          transitionEnvelope(envelope, 'SENT', this.clock.now().toISOString());
        }
        for (const [index, recipient] of envelope.recipients.entries()) {
          const remote =
            external.recipients[index] ??
            external.recipients.find(
              (candidate) => candidate.email.toLowerCase() === recipient.email.toLowerCase(),
            );
          if (!remote) continue;
          recipient.signingEngineRecipientId = remote.id;
          if (
            recipient.status === 'PENDING' &&
            remote.role !== 'CC' &&
            (remote.sendStatus === 'SENT' ||
              (remote.sendStatus === undefined && recipient.routingOrder === firstRoutingOrder))
          ) {
            recipient.status = 'ACTIVE';
          }
        }
        appendAudit(state, {
          workspaceId: principal.workspaceId,
          envelopeId,
          ...auditActor(principal),
          type: 'envelope.sent',
          occurredAt: envelope.sentAt ?? this.clock.now().toISOString(),
          requestId: context.requestId,
          payload: {
            signingEngine: engine.provider,
            signingProviderConnectionId: connectionId,
            externalEnvelopeId: external.id,
          },
        });
        recordIdempotency(
          state,
          principal.workspaceId,
          `send:${envelopeId}`,
          idempotencyKey,
          { envelopeId },
          { id: envelope.id },
          this.clock.now().toISOString(),
        );
        return structuredClone(envelope);
      });
      let reconciled = updated;
      if (external.status === 'COMPLETED' && updated.status !== 'COMPLETED') {
        await this.handleSigningEngineEvent(
          connectionId,
          {
            event: 'DOCUMENT_COMPLETED',
            createdAt: external.completedAt ?? this.clock.now().toISOString(),
            payload: {
              envelopeId: external.id,
              ...(external.externalId !== undefined ? { externalId: external.externalId } : {}),
              status: external.status,
              ...(external.completedAt !== undefined ? { completedAt: external.completedAt } : {}),
              recipients: external.recipients.map((recipient) => ({
                id: recipient.id,
                email: recipient.email,
                ...(recipient.readStatus !== undefined ? { readStatus: recipient.readStatus } : {}),
                ...(recipient.signingStatus !== undefined
                  ? { signingStatus: recipient.signingStatus }
                  : {}),
                ...(recipient.signedAt !== undefined ? { signedAt: recipient.signedAt } : {}),
              })),
            },
          },
          context,
        );
        reconciled = await this.repository.read((state) =>
          structuredClone(findEnvelope(state, principal.workspaceId, envelopeId)),
        );
      }
      return {
        envelope: reconciled,
        replayed: false,
        invitationUrls: external.recipients
          .map((recipient) => recipient.signingUrl)
          .filter((url): url is string => Boolean(url)),
      };
    } catch (error) {
      await this.repository.write((state) => {
        const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
        requireBusinessDomain(principal, envelope.businessDomain, true);
        if (envelope.signingProviderConnectionId !== connectionId) {
          throw new DomainError(
            'signing_provider_mismatch',
            'Envelope is assigned to a different signing provider connection.',
            409,
          );
        }
        envelope.signingEngineStatus = 'FAILED';
        envelope.signingEngineSyncedAt = this.clock.now().toISOString();
        appendAudit(state, {
          workspaceId: principal.workspaceId,
          envelopeId,
          ...auditActor(principal),
          type: 'signing_engine.sync_failed',
          occurredAt: this.clock.now().toISOString(),
          requestId: context.requestId,
          payload: {
            signingEngine: engine.provider,
            signingProviderConnectionId: connectionId,
          },
        });
      });
      throw error;
    }
  }

  private async deliverInvitation(
    envelope: Envelope,
    invitation: InvitationDelivery,
  ): Promise<void> {
    const delivery = await this.email.send({
      to: invitation.email,
      subject: `Signature requested: ${envelope.subject}`,
      text: `${envelope.message}\n\nReview and sign: ${invitation.invitationUrl}\n\nThis secure link is intended for the named recipient.`,
      html: `<p>${escapeHtml(envelope.message)}</p><p><a href="${invitation.invitationUrl}">Review &amp; Sign</a></p><p>This secure link is intended for the named recipient.</p>`,
      tags: { envelope: envelope.id, recipient: invitation.recipientId },
    });
    await this.repository.write((state) => {
      state.emailDeliveries.push({
        id: randomUUID(),
        envelopeId: envelope.id,
        recipientId: invitation.recipientId,
        kind: 'invitation',
        to: invitation.email,
        providerMessageId: delivery.messageId,
        status: 'SENT',
        createdAt: this.clock.now().toISOString(),
      });
    });
  }

  async resendEnvelope(
    principal: StaffPrincipal,
    envelopeId: string,
    recipientId: string,
  ): Promise<{ invitationUrl: string }> {
    requirePermission(principal, 'envelope.send');
    const external = await this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      const recipient = envelope.recipients.find((candidate) => candidate.id === recipientId);
      if (!recipient || !['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(recipient.status)) {
        throw new DomainError('recipient_unavailable', 'Recipient is not active.', 409);
      }
      if (!envelope.signingEngineEnvelopeId) {
        if (envelope.signingProviderConnectionId) {
          throw new DomainError(
            'signing_engine_not_ready',
            'External signing delivery has not completed.',
            409,
          );
        }
        return undefined;
      }
      const connection = this.signingConnection(
        state,
        principal.workspaceId,
        envelope.signingProviderConnectionId,
        true,
      );
      if (!connection) {
        throw new DomainError(
          'signing_provider_unavailable',
          'The envelope signing provider is unavailable.',
          503,
        );
      }
      return {
        connection,
        envelopeId: envelope.signingEngineEnvelopeId,
        recipientId: recipient.signingEngineRecipientId,
      };
    });
    if (external) {
      await external.connection.engine.redistributeEnvelope(
        external.envelopeId,
        external.recipientId,
      );
      return { invitationUrl: '' };
    }
    const invitation = await this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      const recipient = envelope.recipients.find((candidate) => candidate.id === recipientId);
      if (!recipient || !['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(recipient.status)) {
        throw new DomainError('recipient_unavailable', 'Recipient is not active.', 409);
      }
      const token = createSecret(32);
      recipient.invitationHash = sha256(token);
      for (const session of state.recipientSessions.filter(
        (candidate) => candidate.recipientId === recipient.id,
      )) {
        session.revokedAt = this.clock.now().toISOString();
      }
      return {
        recipientId: recipient.id,
        email: recipient.email,
        token,
        invitationUrl: `${this.publicBaseUrl}/sign/${token}`,
        envelope: structuredClone(envelope),
      };
    });
    await this.deliverInvitation(invitation.envelope, invitation);
    return { invitationUrl: invitation.invitationUrl };
  }

  async voidEnvelope(
    principal: StaffPrincipal,
    envelopeId: string,
    reason: string,
    context: RequestContext,
  ): Promise<Envelope> {
    requirePermission(principal, 'envelope.manage');
    if (reason.trim().length < 3)
      throw new DomainError('reason_required', 'A void reason is required.', 422);
    const external = await this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      if (
        ![
          'DRAFT',
          'PREPARED',
          'APPROVAL_PENDING',
          'READY_TO_SEND',
          'SENT',
          'IN_PROGRESS',
          'FAILED_FINALIZATION',
        ].includes(envelope.status)
      ) {
        throw new DomainError(
          'invalid_transition',
          `Envelope cannot transition from ${envelope.status} to VOIDED.`,
          409,
        );
      }
      if (!envelope.signingEngineEnvelopeId) return undefined;
      const connection = this.signingConnection(
        state,
        principal.workspaceId,
        envelope.signingProviderConnectionId,
        true,
      );
      if (!connection) {
        throw new DomainError(
          'signing_provider_unavailable',
          'The envelope signing provider is unavailable.',
          503,
        );
      }
      return { connection, envelopeId: envelope.signingEngineEnvelopeId };
    });
    if (external) {
      await external.connection.engine.cancelEnvelope(external.envelopeId);
    }
    return this.repository.write((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      if (external && envelope.signingProviderConnectionId !== external.connection.connectionId) {
        throw new DomainError(
          'signing_provider_mismatch',
          'Envelope is assigned to a different signing provider connection.',
          409,
        );
      }
      const now = this.clock.now().toISOString();
      transitionEnvelope(envelope, 'VOIDED', now);
      envelope.voidReason = reason.trim();
      for (const recipient of envelope.recipients) recipient.status = 'REVOKED';
      for (const session of state.recipientSessions.filter(
        (candidate) => candidate.envelopeId === envelopeId,
      ))
        session.revokedAt = now;
      appendAudit(state, {
        workspaceId: principal.workspaceId,
        envelopeId,
        ...auditActor(principal),
        type: 'envelope.voided',
        occurredAt: now,
        requestId: context.requestId,
        payload: { reason },
      });
      return structuredClone(envelope);
    });
  }

  invitationStatus(token: string): Promise<{ valid: boolean }> {
    return this.repository.read((state) => {
      const now = this.clock.now();
      const recipient = state.envelopes
        .flatMap((envelope) => envelope.recipients)
        .find(
          (candidate) =>
            candidate.invitationHash && safeSecretEqual(token, candidate.invitationHash),
        );
      return {
        valid: Boolean(
          recipient &&
          recipient.invitationExpiresAt &&
          new Date(recipient.invitationExpiresAt) > now &&
          ['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(recipient.status),
        ),
      };
    });
  }

  exchangeInvitation(
    token: string,
    accessCode: string | undefined,
    context: RequestContext,
  ): Promise<{ sessionSecret: string; csrfToken: string; context: SigningContext }> {
    return this.repository.write((state) => {
      const envelope = state.envelopes.find((candidate) =>
        candidate.recipients.some(
          (recipient) =>
            recipient.invitationHash && safeSecretEqual(token, recipient.invitationHash),
        ),
      );
      const recipient = envelope?.recipients.find(
        (candidate) => candidate.invitationHash && safeSecretEqual(token, candidate.invitationHash),
      );
      if (
        !envelope ||
        !recipient ||
        !recipient.invitationExpiresAt ||
        new Date(recipient.invitationExpiresAt) <= this.clock.now() ||
        !['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(recipient.status) ||
        !['SENT', 'IN_PROGRESS'].includes(envelope.status)
      ) {
        throw new DomainError(
          'invitation_unavailable',
          'This signing invitation is unavailable.',
          410,
        );
      }
      if (recipient.accessCodeHash) {
        if (!accessCode || !safeSecretEqual(accessCode, recipient.accessCodeHash)) {
          recipient.accessCodeFailures += 1;
          if (recipient.accessCodeFailures >= 5) recipient.status = 'REVOKED';
          throw new DomainError('access_code_invalid', 'Access code is invalid.', 401);
        }
        recipient.accessCodeFailures = 0;
      }
      const sessionSecret = createSecret(32);
      const csrfToken = createSecret(24);
      const now = this.clock.now();
      const expires = new Date(
        Math.min(now.getTime() + 60 * 60 * 1000, new Date(envelope.expiresAt).getTime()),
      );
      state.recipientSessions.push({
        id: newId(),
        sessionHash: sha256(sessionSecret),
        csrfHash: sha256(csrfToken),
        envelopeId: envelope.id,
        recipientId: recipient.id,
        expiresAt: expires.toISOString(),
        createdAt: now.toISOString(),
      });
      if (recipient.status === 'ACTIVE') recipient.status = 'VIEWED';
      recipient.viewedAt ??= now.toISOString();
      if (envelope.status === 'SENT')
        transitionEnvelope(envelope, 'IN_PROGRESS', now.toISOString());
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'recipient',
        actorId: recipient.id,
        type: 'recipient.session.created',
        occurredAt: now.toISOString(),
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        payload: { assuranceMethod: recipient.assuranceMethod },
      });
      return {
        sessionSecret,
        csrfToken,
        context: this.signingContext(envelope, recipient, csrfToken),
      };
    });
  }

  getSigningContext(sessionSecret: string, csrfToken: string): Promise<SigningContext> {
    return this.repository.read((state) => {
      const session = findSession(state, sessionSecret, this.clock.now());
      const envelope = state.envelopes.find((candidate) => candidate.id === session.envelopeId);
      const recipient = envelope?.recipients.find(
        (candidate) => candidate.id === session.recipientId,
      );
      if (!envelope || !recipient)
        throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
      return this.signingContext(envelope, recipient, csrfToken);
    });
  }

  private signingContext(
    envelope: Envelope,
    recipient: Recipient,
    csrfToken: string,
  ): SigningContext {
    return {
      envelope: {
        id: envelope.id,
        subject: envelope.subject,
        message: envelope.message,
        status: envelope.status,
        expiresAt: envelope.expiresAt,
        version: envelope.version,
        documents: envelope.documents,
      },
      recipient: {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email,
        status: recipient.status,
        values: recipient.values,
        ...(recipient.consentedAt ? { consentedAt: recipient.consentedAt } : {}),
        ...(recipient.signature ? { signature: recipient.signature } : {}),
      },
      fields: envelope.fields.filter(
        (field) => field.roleId === recipient.roleId || field.readOnly,
      ),
      csrfToken,
      disclosure: DISCLOSURE,
    };
  }

  private recipientMutation(
    sessionSecret: string,
    csrfToken: string,
    operation: (
      state: Parameters<PlatformRepository['write']>[0] extends (state: infer S) => unknown
        ? S
        : never,
      envelope: Envelope,
      recipient: Recipient,
    ) => void,
  ): Promise<SigningContext> {
    return this.repository.write((state) => {
      const session = findSession(state, sessionSecret, this.clock.now());
      if (!safeSecretEqual(csrfToken, session.csrfHash))
        throw new DomainError('csrf_invalid', 'Request verification failed.', 403);
      const envelope = state.envelopes.find((candidate) => candidate.id === session.envelopeId);
      const recipient = envelope?.recipients.find(
        (candidate) => candidate.id === session.recipientId,
      );
      if (!envelope || !recipient || !['SENT', 'IN_PROGRESS'].includes(envelope.status)) {
        throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
      }
      operation(state, envelope, recipient);
      return this.signingContext(envelope, recipient, csrfToken);
    });
  }

  consent(
    sessionSecret: string,
    csrfToken: string,
    disclosureVersion: string,
    context: RequestContext,
  ): Promise<SigningContext> {
    if (disclosureVersion !== DISCLOSURE.version)
      throw new DomainError(
        'disclosure_changed',
        'Disclosure version changed. Please review again.',
        409,
      );
    return this.recipientMutation(sessionSecret, csrfToken, (state, envelope, recipient) => {
      const now = this.clock.now().toISOString();
      recipient.consentedAt = now;
      recipient.disclosureVersion = disclosureVersion;
      if (recipient.status === 'VIEWED') recipient.status = 'IN_PROGRESS';
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'recipient',
        actorId: recipient.id,
        type: 'recipient.consent.accepted',
        occurredAt: now,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        payload: { disclosureVersion },
      });
    });
  }

  saveProgress(
    sessionSecret: string,
    csrfToken: string,
    input: SaveSigningProgress,
    context: RequestContext,
  ): Promise<SigningContext> {
    return this.recipientMutation(sessionSecret, csrfToken, (state, envelope, recipient) => {
      if (input.expectedEnvelopeVersion !== envelope.version) {
        throw new DomainError(
          'version_conflict',
          'The envelope changed. Refresh before continuing.',
          409,
        );
      }
      const allowedIds = new Set(
        envelope.fields
          .filter((field) => field.roleId === recipient.roleId && !field.readOnly)
          .map((field) => field.id),
      );
      for (const [fieldId, value] of Object.entries(input.values)) {
        if (!allowedIds.has(fieldId)) {
          const field = envelope.fields.find((candidate) => candidate.id === fieldId);
          const unchangedReadOnlyValue =
            field?.readOnly === true &&
            canonicalJson(value) === canonicalJson(recipient.values[fieldId]);
          if (unchangedReadOnlyValue) continue;
          throw new DomainError(
            'field_forbidden',
            'A field is not assigned to this recipient.',
            403,
          );
        }
        recipient.values[fieldId] = value;
      }
      if (input.signature) {
        recipient.signature = { ...input.signature, adoptedAt: this.clock.now().toISOString() };
      }
      if (recipient.status === 'VIEWED') recipient.status = 'IN_PROGRESS';
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'recipient',
        actorId: recipient.id,
        type: 'recipient.progress.saved',
        occurredAt: this.clock.now().toISOString(),
        requestId: context.requestId,
        payload: {
          changedFieldIds: Object.keys(input.values),
          signatureAdopted: Boolean(input.signature),
        },
      });
    });
  }

  async finish(
    sessionSecret: string,
    csrfToken: string,
    context: RequestContext,
  ): Promise<SigningContext> {
    const activation = await this.repository.write((state) => {
      const session = findSession(state, sessionSecret, this.clock.now());
      if (!safeSecretEqual(csrfToken, session.csrfHash))
        throw new DomainError('csrf_invalid', 'Request verification failed.', 403);
      const envelope = state.envelopes.find((candidate) => candidate.id === session.envelopeId);
      const recipient = envelope?.recipients.find(
        (candidate) => candidate.id === session.recipientId,
      );
      if (!envelope || !recipient)
        throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
      const details = validateRecipientCompletion(envelope.fields, recipient);
      if (details.length > 0)
        throw new DomainError(
          'signing_incomplete',
          'Required fields are incomplete.',
          422,
          details,
        );
      const now = this.clock.now().toISOString();
      recipient.status = 'COMPLETED';
      recipient.completedAt = now;
      session.revokedAt = now;
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'recipient',
        actorId: recipient.id,
        type: 'recipient.finished',
        occurredAt: now,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        payload: { documentHashes: envelope.documents.map((document) => document.sourceSha256) },
      });
      const required = envelope.recipients.filter(
        (candidate) => !['copy', 'viewer'].includes(candidate.kind),
      );
      const incomplete = required.filter((candidate) => candidate.status !== 'COMPLETED');
      const invitations: InvitationDelivery[] = [];
      let finalize = false;
      if (incomplete.length === 0) {
        transitionEnvelope(envelope, 'FINALIZING', now);
        finalize = true;
      } else {
        const active = incomplete.filter((candidate) =>
          ['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(candidate.status),
        );
        if (active.length === 0) {
          const nextOrder = Math.min(...incomplete.map((candidate) => candidate.routingOrder));
          for (const next of incomplete.filter(
            (candidate) => candidate.routingOrder === nextOrder,
          )) {
            next.status = 'ACTIVE';
            const token = createSecret(32);
            next.invitationHash = sha256(token);
            invitations.push({
              recipientId: next.id,
              email: next.email,
              token,
              invitationUrl: `${this.publicBaseUrl}/sign/${token}`,
            });
          }
        }
      }
      return {
        envelope: structuredClone(envelope),
        recipient: structuredClone(recipient),
        invitations,
        finalize,
      };
    });
    for (const invitation of activation.invitations)
      await this.deliverInvitation(activation.envelope, invitation);
    if (activation.finalize) {
      try {
        await this.finalizer.finalize(activation.envelope.id);
      } catch (error) {
        await this.repository.write((state) => {
          const envelope = findEnvelope(
            state,
            activation.envelope.workspaceId,
            activation.envelope.id,
          );
          if (envelope.status === 'FINALIZING')
            transitionEnvelope(envelope, 'FAILED_FINALIZATION', this.clock.now().toISOString());
        });
        throw error;
      }
      return this.repository.read((state) => {
        const envelope = findEnvelope(
          state,
          activation.envelope.workspaceId,
          activation.envelope.id,
        );
        const recipient = envelope.recipients.find(
          (candidate) => candidate.id === activation.recipient.id,
        );
        if (!recipient)
          throw new DomainError(
            'recipient_session_invalid',
            'Signing session is unavailable.',
            401,
          );
        return this.signingContext(envelope, recipient, csrfToken);
      });
    }
    return this.signingContext(activation.envelope, activation.recipient, csrfToken);
  }

  decline(
    sessionSecret: string,
    csrfToken: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    return this.repository.write((state) => {
      const session = findSession(state, sessionSecret, this.clock.now());
      if (!safeSecretEqual(csrfToken, session.csrfHash))
        throw new DomainError('csrf_invalid', 'Request verification failed.', 403);
      const envelope = state.envelopes.find((candidate) => candidate.id === session.envelopeId);
      const recipient = envelope?.recipients.find(
        (candidate) => candidate.id === session.recipientId,
      );
      if (!envelope || !recipient)
        throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
      const now = this.clock.now().toISOString();
      recipient.status = 'DECLINED';
      recipient.declineReason = reason.trim().slice(0, 500);
      session.revokedAt = now;
      transitionEnvelope(envelope, 'DECLINED', now);
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'recipient',
        actorId: recipient.id,
        type: 'recipient.declined',
        occurredAt: now,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        payload: { reasonProvided: Boolean(reason.trim()) },
      });
    });
  }

  async signingDocument(sessionSecret: string, documentId: string): Promise<Uint8Array> {
    const key = await this.repository.read((state) => {
      const session = findSession(state, sessionSecret, this.clock.now());
      const envelope = state.envelopes.find((candidate) => candidate.id === session.envelopeId);
      const document = envelope?.documents.find((candidate) => candidate.id === documentId);
      if (!document) throw new DomainError('not_found', 'Document not found.', 404);
      return document.objectKey;
    });
    return this.objects.get(key);
  }

  evidence(principal: StaffPrincipal, envelopeId: string) {
    requirePermission(principal, 'evidence.read');
    return this.repository.read((state) => {
      const envelope = findEnvelope(state, principal.workspaceId, envelopeId);
      requireBusinessDomain(principal, envelope.businessDomain, true);
      if (!envelope.evidencePackageId)
        throw new DomainError('evidence_pending', 'Evidence is not finalized.', 409);
      const evidence = state.evidencePackages.find(
        (candidate) => candidate.id === envelope.evidencePackageId,
      );
      if (!evidence) throw new DomainError('evidence_pending', 'Evidence is not finalized.', 409);
      return structuredClone(evidence);
    });
  }

  async evidenceFile(
    principal: StaffPrincipal,
    envelopeId: string,
    filename: string,
  ): Promise<Uint8Array> {
    const evidence = await this.evidence(principal, envelopeId);
    const file = evidence.files.find((candidate) => candidate.name === filename);
    const objectKey =
      file?.objectKey ?? (filename === 'manifest.json' ? evidence.manifestObjectKey : undefined);
    if (!objectKey) throw new DomainError('not_found', 'Evidence file not found.', 404);
    return this.objects.get(objectKey);
  }

  async signingEngineHealth(
    principal: StaffPrincipal,
  ): Promise<{ provider: string; reachable: boolean }> {
    const connection = await this.repository.read((state) =>
      this.signingConnection(state, principal.workspaceId),
    );
    if (!connection) return { provider: 'native', reachable: true };
    return connection.engine.health();
  }

  async handleSigningEngineEvent(
    connectionId: string,
    event: {
      event: string;
      createdAt: string;
      payload: {
        envelopeId: SigningEngineWebhookPayload['envelopeId'];
        externalId?: SigningEngineWebhookPayload['externalId'];
        status?: SigningEngineWebhookPayload['status'];
        completedAt?: SigningEngineWebhookPayload['completedAt'];
        recipients?: SigningEngineWebhookPayload['recipients'];
      };
    },
    context: RequestContext,
  ): Promise<{ accepted: true; replayed: boolean }> {
    const engine = this.signingEngines.get(connectionId);
    if (!engine) {
      throw new DomainError('signing_engine_disabled', 'External signing engine is disabled.', 404);
    }
    const eventKey = `signing-engine-event:${connectionId}:${sha256(JSON.stringify(event))}`;
    const local = await this.repository.read((state) => {
      if (state.idempotency[eventKey]) return { replayed: true as const };
      const resolved = resolveSigningEngineWebhookEnvelope(state, connectionId, event.payload);
      return {
        replayed: false as const,
        envelope: structuredClone(resolved.envelope),
        usedExternalIdFallback: resolved.usedExternalIdFallback,
      };
    });
    if (local.replayed) return { accepted: true, replayed: true };
    const isCompleted =
      event.event === 'DOCUMENT_COMPLETED' || event.payload.status === 'COMPLETED';

    let completedFiles:
      Array<{ documentId: string; objectKey: string; sha256: string }> | undefined;
    if (isCompleted && local.envelope.status !== 'COMPLETED') {
      const external = await engine.getEnvelope(event.payload.envelopeId);
      validateSigningEngineWebhookRemoteEnvelope(external, event.payload, local.envelope.id);
      const localDocuments = [...local.envelope.documents].sort(
        (left, right) => left.order - right.order,
      );
      const remoteItems = [...external.items].sort((left, right) => left.order - right.order);
      if (remoteItems.length < localDocuments.length) {
        throw new DomainError(
          'signing_engine_incomplete_package',
          'Signing engine completed package is missing a PDF.',
          502,
        );
      }
      completedFiles = await Promise.all(
        localDocuments.map(async (document, index) => {
          const bytes = await engine.downloadItem(remoteItems[index]!.id);
          const digest = sha256(bytes);
          const objectKey = `engine-completed/${local.envelope.workspaceId}/${local.envelope.id}/${document.order}-${document.name}`;
          await this.objects.put(objectKey, bytes, 'application/pdf');
          return { documentId: document.id, objectKey, sha256: digest };
        }),
      );
    }

    const shouldFinalize = await this.repository.write((state) => {
      if (state.idempotency[eventKey]) return false;
      const { envelope } = resolveSigningEngineWebhookEnvelope(
        state,
        connectionId,
        event.payload,
        local.envelope.id,
        local.usedExternalIdFallback,
      );
      // Resolve the complete recipient projection before mutating anything. This keeps in-memory
      // repositories fail-closed as well as transactional repositories when an identifier is
      // ambiguous or an email conflicts with an existing provider binding.
      const recipientUpdates = resolveSigningEngineWebhookRecipients(
        envelope,
        event.payload.recipients ?? [],
      );
      const now = this.clock.now().toISOString();
      envelope.signingEngine = engine.provider;
      envelope.signingEngineEnvelopeId = event.payload.envelopeId;
      envelope.signingEngineStatus = event.payload.status ?? event.event;
      envelope.signingEngineSyncedAt = now;
      for (const { recipient, remote, bindProviderRecipientId } of recipientUpdates) {
        if (bindProviderRecipientId) recipient.signingEngineRecipientId = remote.id;
        if (remote.signingStatus === 'SIGNED') {
          recipient.status = 'COMPLETED';
          recipient.completedAt = remote.signedAt ?? event.createdAt;
        } else if (remote.signingStatus === 'REJECTED') {
          recipient.status = 'DECLINED';
        } else if (remote.readStatus === 'OPENED' && recipient.status === 'ACTIVE') {
          recipient.status = 'VIEWED';
        }
      }
      const providerHasDistributed =
        isCompleted ||
        [
          'DOCUMENT_SENT',
          'DOCUMENT_OPENED',
          'DOCUMENT_SIGNED',
          'DOCUMENT_RECIPIENT_COMPLETED',
          'DOCUMENT_REJECTED',
          'DOCUMENT_CANCELLED',
        ].includes(event.event) ||
        ['PENDING', 'COMPLETED', 'REJECTED'].includes(event.payload.status ?? '');
      // A provider webhook can win the race against the local post-distribution commit. Catch the
      // projection up instead of discarding a valid lifecycle event while the local row is READY.
      if (envelope.status === 'READY_TO_SEND' && providerHasDistributed) {
        transitionEnvelope(envelope, 'SENT', now);
      }
      if (
        event.event === 'DOCUMENT_REJECTED' &&
        ['SENT', 'IN_PROGRESS'].includes(envelope.status)
      ) {
        transitionEnvelope(envelope, 'DECLINED', now);
      } else if (
        event.event === 'DOCUMENT_CANCELLED' &&
        ['SENT', 'IN_PROGRESS'].includes(envelope.status)
      ) {
        transitionEnvelope(envelope, 'VOIDED', now);
        envelope.voidReason = 'Cancelled in signing engine.';
        for (const recipient of envelope.recipients) recipient.status = 'REVOKED';
      } else if (
        !isCompleted &&
        envelope.status === 'SENT' &&
        ['DOCUMENT_OPENED', 'DOCUMENT_SIGNED', 'DOCUMENT_RECIPIENT_COMPLETED'].includes(event.event)
      ) {
        transitionEnvelope(envelope, 'IN_PROGRESS', now);
      }
      let finalize = false;
      if (isCompleted && envelope.status !== 'COMPLETED') {
        for (const completed of completedFiles ?? []) {
          const document = envelope.documents.find(
            (candidate) => candidate.id === completed.documentId,
          );
          if (document) {
            document.completedObjectKey = completed.objectKey;
            document.completedSha256 = completed.sha256;
          }
        }
        if (envelope.status === 'SENT') transitionEnvelope(envelope, 'IN_PROGRESS', now);
        if (envelope.status === 'IN_PROGRESS') transitionEnvelope(envelope, 'FINALIZING', now);
        if (envelope.status === 'FAILED_FINALIZATION') {
          transitionEnvelope(envelope, 'FINALIZING', now);
        }
        finalize = envelope.status === 'FINALIZING';
      }
      appendAudit(state, {
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        actorType: 'system',
        actorId: engine.provider,
        type: `signing_engine.${event.event.toLowerCase()}`,
        occurredAt: event.createdAt,
        requestId: context.requestId,
        payload: {
          externalEnvelopeId: event.payload.envelopeId,
          externalStatus: event.payload.status,
          signingProviderConnectionId: connectionId,
        },
      });
      if (!finalize) {
        state.idempotency[eventKey] = {
          requestHash: sha256(JSON.stringify(event)),
          response: { accepted: true },
          createdAt: now,
        };
      }
      return finalize;
    });
    if (shouldFinalize) {
      try {
        await this.finalizer.finalize(local.envelope.id);
        await this.repository.write((state) => {
          state.idempotency[eventKey] = {
            requestHash: sha256(JSON.stringify(event)),
            response: { accepted: true },
            createdAt: this.clock.now().toISOString(),
          };
        });
      } catch (error) {
        await this.repository.write((state) => {
          const envelope = state.envelopes.find((candidate) => candidate.id === local.envelope.id);
          if (envelope?.status === 'FINALIZING') {
            transitionEnvelope(envelope, 'FAILED_FINALIZATION', this.clock.now().toISOString());
          }
        });
        throw error;
      }
    }
    return { accepted: true, replayed: false };
  }

  dashboard(principal: StaffPrincipal) {
    requirePermission(principal, 'envelope.read');
    return this.repository.read((state) => {
      requireWorkspace(principal, principal.workspaceId);
      const envelopes = state.envelopes.filter(
        (candidate) =>
          candidate.workspaceId === principal.workspaceId &&
          canAccessBusinessDomain(principal, candidate.businessDomain),
      );
      const delegatedTemplateAccess = principal.delegatedScopes?.some((scope) =>
        ['templates:read', 'templates:write'].includes(scope),
      );
      const templateCount =
        actorType(principal) === 'staff' || delegatedTemplateAccess
          ? state.templates.filter(
              (candidate) =>
                candidate.workspaceId === principal.workspaceId &&
                visibleTemplate(principal, candidate) !== undefined,
            ).length
          : 0;
      const workspace = state.workspaces.find(
        (candidate) => candidate.id === principal.workspaceId,
      );
      const safeWorkspace = (() => {
        if (!workspace || actorType(principal) === 'staff') return structuredClone(workspace);
        const { members: _members, ...publicWorkspace } = workspace;
        return structuredClone(publicWorkspace);
      })();
      const auditEvents =
        actorType(principal) === 'staff'
          ? state.auditEvents.filter((candidate) => candidate.workspaceId === principal.workspaceId)
          : [];
      return {
        workspace: safeWorkspace,
        counts: {
          templates: templateCount,
          drafts: envelopes.filter((candidate) =>
            ['DRAFT', 'PREPARED', 'APPROVAL_PENDING', 'READY_TO_SEND'].includes(candidate.status),
          ).length,
          waiting: envelopes.filter((candidate) =>
            ['SENT', 'IN_PROGRESS', 'FINALIZING'].includes(candidate.status),
          ).length,
          completed: envelopes.filter((candidate) => candidate.status === 'COMPLETED').length,
        },
        recentEnvelopes: envelopes.slice(-8).reverse(),
        recentAudit: auditEvents.slice(-8).reverse(),
      };
    });
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ??
      character,
  );
}
