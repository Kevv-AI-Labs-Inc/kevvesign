import { describe, expect, it } from 'vitest';
import {
  Documenso,
  envelopeSchema,
  ProviderError,
  sha256,
  templateFingerprint,
} from '../documenso.js';
import { authenticate, webhookSecret } from '../auth.js';
import { recipientIsCurrent } from '../recipient-access.js';
import { loadBridgeConfig } from '../config.js';
import { attachmentDisposition, previewField, safeFilename } from '../review.js';
import {
  assertNativeOwner,
  bindRecipients,
  createInput,
  projectEnvelope,
  publishInput,
  type Connection,
  type TemplatePart,
} from '../model.js';
import {
  assertTemplateVersion,
  assertHrDraft,
  compileTemplate,
  createMeta,
  prefillMeta,
  validateTemplate,
} from '../packages.js';

const at = '2026-09-12T12:00:00.000Z';
function document() {
  return envelopeSchema.parse({
    id: 'envelope_qa',
    secondaryId: 'QA',
    externalId: 'homix:qa',
    title: 'SYNTHETIC QA ONLY',
    type: 'TEMPLATE',
    status: 'DRAFT',
    userId: 7,
    teamId: 10,
    folderId: null,
    visibility: 'ADMIN',
    user: { id: 7, email: 'owner@example.invalid', name: 'Owner' },
    team: { id: 10, url: 'private-owner' },
    recipients: [1, 2].map((id) => ({
      id,
      email: `signer${id}@example.invalid`,
      name: `Signer ${id}`,
      token: `private-token-${id}`,
      role: 'SIGNER',
      signingOrder: id,
      signingStatus: 'NOT_SIGNED',
      sendStatus: 'NOT_SENT',
      readStatus: 'NOT_OPENED',
      signedAt: null,
      expiresAt: null,
    })),
    envelopeItems: [1, 2].map((id) => ({
      id: `file-${id}`,
      title: `Test ${id}.pdf`,
      order: id,
      documentDataId: `private-storage-${id}`,
    })),
    fields: [1, 2]
      .map((id) => ({
        id,
        recipientId: id,
        envelopeItemId: `file-${id}`,
        type: 'SIGNATURE',
        page: 1,
        positionX: 10,
        positionY: 70,
        width: 20,
        height: 5,
        fieldMeta: null,
        inserted: false,
      }))
      .concat([
        {
          id: 3,
          recipientId: 1,
          envelopeItemId: 'file-2',
          type: 'TEXT',
          page: 2,
          positionX: 10,
          positionY: 10,
          width: 20,
          height: 5,
          fieldMeta: null,
          inserted: false,
        },
      ]),
    documentMeta: {
      signingOrder: 'SEQUENTIAL',
      subject: null,
      message: null,
      typedSignatureEnabled: true,
    },
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    deletedAt: null,
  });
}
const connection: Connection = {
  id: '00000000-0000-4000-8000-000000000001',
  client_id: 'qa',
  scope: 'customer',
  owner_agent_id: 42,
  company_key: null,
  native_user_id: 7,
  native_email: 'owner@example.invalid',
  team_id: 10,
  team_url: 'private-owner',
  token_ciphertext: 'encrypted',
  revoked_at: null,
};
const part: TemplatePart = {
  title: 'Test package',
  templateId: 'envelope_qa',
  roles: [
    { key: 'buyer1', templateRecipientId: 1, actor: 'customer', label: 'Buyer 1' },
    { key: 'buyer2', templateRecipientId: 2, actor: 'customer', label: 'Buyer 2' },
  ],
  prefill: [{ key: 'address', templateFieldId: 3, required: true, label: 'Address' }],
};

describe('native mapping and published packages', () => {
  it('rejects ambiguous sequential ranks but permits fully parallel signing', () => {
    const native = document();
    native.recipients[1].signingOrder = native.recipients[0].signingOrder;
    expect(() => validateTemplate(native, part, connection)).toThrow(
      'SEQUENTIAL_ORDER_MUST_BE_DISTINCT',
    );
    native.recipients[1].signingOrder = null;
    expect(() => validateTemplate(native, part, connection)).toThrow(
      'SEQUENTIAL_ORDER_MUST_BE_DISTINCT',
    );
    native.documentMeta!.signingOrder = 'PARALLEL';
    expect(() => validateTemplate(native, part, connection)).not.toThrow();
  });
  it('keeps preview credentials private and international download names header-safe', () => {
    const native = document();
    const preview = JSON.stringify(previewField(native.fields[0], native));
    expect(preview).toContain('Signer 1');
    expect(preview).not.toContain('private-token');
    expect(preview).not.toContain('private-storage');
    const name = safeFilename('../买家\r\n包.pdf');
    expect(name).not.toMatch(/[\r\n/\\]/);
    expect(name).not.toMatch(/^\./);
    const header = attachmentDisposition(`${name}.pdf`);
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent('买家'));
    expect(header).not.toMatch(/[\r\n]/);
    expect(attachmentDisposition('完成件.zip')).toContain('signing-document.zip');
  });
  it('rejects changed HR draft fields, prefills and routing before sending', () => {
    const native = document();
    native.fields[2].fieldMeta = {
      type: 'text',
      readOnly: true,
      text: 'Approved address',
      fontSize: 12,
    };
    const snapshot = {
      meta: { signingOrder: 'SEQUENTIAL' },
      recipients: native.recipients.map((r) => ({
        email: r.email,
        name: r.name,
        role: r.role,
        signingOrder: r.signingOrder,
        fields: native.fields
          .filter((f) => f.recipientId === r.id)
          .map((f) => ({
            identifier: native.envelopeItems.findIndex((item) => item.id === f.envelopeItemId),
            type: f.type,
            page: f.page,
            positionX: f.positionX,
            positionY: f.positionY,
            width: f.width,
            height: f.height,
            fieldMeta: f.fieldMeta
              ? { type: 'text', readOnly: true, text: 'Approved address' }
              : undefined,
          })),
      })),
    };
    expect(() => assertHrDraft(native, snapshot)).not.toThrow();
    const changed = structuredClone(native);
    changed.fields[2].fieldMeta!.text = 'Another address';
    expect(() => assertHrDraft(changed, snapshot)).toThrow('HR_DRAFT_CHANGED');
    changed.fields[2].fieldMeta!.text = 'Approved address';
    changed.fields.pop();
    expect(() => assertHrDraft(changed, snapshot)).toThrow('HR_DRAFT_CHANGED');
    native.documentMeta!.signingOrder = 'PARALLEL';
    expect(() => assertHrDraft(native, snapshot)).toThrow('HR_DRAFT_CHANGED');
  });
  it('maps two buyers and two files by stable native identifiers and preserves readonly prefills', () => {
    const native = document();
    native.fields[2].fieldMeta = { type: 'text', readOnly: true };
    validateTemplate(native, part, connection);
    const published = {
      ...part,
      fingerprint: templateFingerprint(native, ['file-hash-1', 'file-hash-2']),
      files: [],
      connectionId: connection.id,
    };
    const input = createInput.parse({
      idempotencyKey: 'qa-1',
      externalReference: 'qa-1',
      title: 'QA',
      scenario: 'buyer',
      companyKey: 'qa',
      ownerAgentId: 42,
      packageId: connection.id,
      recipients: [
        { key: 'buyer1', name: 'First Buyer', email: 'first@example.invalid' },
        { key: 'buyer2', name: 'Second Buyer', email: 'second@example.invalid' },
      ],
      values: { address: 'Synthetic address' },
    });
    const compiled = compileTemplate(
      native,
      [],
      published,
      input,
      connection,
      'https://portal.example.invalid/signing/qa',
    );
    const recipients = compiled.payload.recipients as Array<{
      email: string;
      signingOrder: number;
      fields: Array<{ identifier: number; page: number; fieldMeta: Record<string, unknown> }>;
    }>;
    expect(recipients.map((r) => [r.email, r.signingOrder])).toEqual([
      ['first@example.invalid', 1],
      ['second@example.invalid', 2],
    ]);
    expect(recipients[0].fields[0].identifier).toBe(0);
    expect(recipients[1].fields[0].identifier).toBe(1);
    expect(recipients[0].fields[1]).toMatchObject({
      identifier: 1,
      page: 2,
      fieldMeta: { type: 'text', readOnly: true, text: 'Synthetic address' },
    });
    expect(compiled.payload).toMatchObject({
      visibility: 'ADMIN',
      delegatedDocumentOwner: 'owner@example.invalid',
    });
    assertTemplateVersion(native, published, ['file-hash-1', 'file-hash-2']);
    native.fields[0].positionX += 1;
    expect(() => assertTemplateVersion(native, published, ['file-hash-1', 'file-hash-2'])).toThrow(
      'PUBLISHED_TEMPLATE_CHANGED',
    );
  });
  it('refuses template mutation, incomplete role coverage and signature prefilling', () => {
    const native = document();
    expect(() =>
      validateTemplate(native, { ...part, roles: part.roles.slice(0, 1) }, connection),
    ).toThrow('EVERY_TEMPLATE_RECIPIENT');
    expect(() =>
      validateTemplate(
        native,
        { ...part, prefill: [{ ...part.prefill[0], templateFieldId: 1 }] },
        connection,
      ),
    ).toThrow('INVALID_PREFILL_FIELD');
    native.fields = native.fields.filter((f) => f.id !== 2);
    expect(() => validateTemplate(native, part, connection)).toThrow(
      'SIGNER_MISSING_SIGNATURE_FIELD',
    );
    expect(() => prefillMeta(document().fields[0], 'not-a-signature')).toThrow(
      'INVALID_PREFILL_FIELD',
    );
    expect(
      createMeta({
        subject: null,
        message: null,
        redirectUrl: 'https://example.invalid',
        emailSettings: null,
        unknownPrivateValue: 'secret',
      }),
    ).toEqual({ redirectUrl: 'https://example.invalid', emailSettings: null });
  });
  it('does not allow a shared role key to switch between the owner and company', () => {
    const input = {
      packageKey: 'qa',
      version: 1,
      title: 'QA',
      scenario: 'onboarding',
      companyKey: 'qa',
      parts: [part, { ...part, roles: [{ ...part.roles[0], actor: 'owner' }, part.roles[1]] }],
    };
    expect(publishInput.safeParse(input).success).toBe(false);
  });
  it('isolates native owners and refuses ambiguous signer slots', () => {
    const native = document();
    native.type = 'DOCUMENT';
    assertNativeOwner(native, connection);
    expect(() => assertNativeOwner({ ...native, visibility: 'EVERYONE' }, connection)).toThrow(
      'NATIVE_OWNERSHIP_MISMATCH',
    );
    expect(() => assertNativeOwner({ ...native, teamId: 11 }, connection)).toThrow(
      'NATIVE_OWNERSHIP_MISMATCH',
    );
    expect(() => assertNativeOwner({ ...native, userId: 8 }, connection)).toThrow(
      'NATIVE_OWNERSHIP_MISMATCH',
    );
    const binding = {
      key: 'first',
      name: native.recipients[0].name,
      email: native.recipients[0].email,
      role: 'SIGNER',
      actor: 'customer' as const,
    };
    expect(bindRecipients(native, [binding])[0].nativeId).toBe(1);
    native.recipients[1] = { ...native.recipients[0], id: 2 };
    expect(() => bindRecipients(native, [binding])).toThrow('RECIPIENT_MAPPING_MISMATCH');
  });
  it('never leaks signer tokens or storage IDs and never invents completion dates', () => {
    const native = document();
    native.status = 'PENDING';
    native.completedAt = at;
    const projection = projectEnvelope(native, []);
    expect(projection.completedAt).toBeNull();
    expect(projection.completionFilesReady).toBe(false);
    expect(JSON.stringify(projection)).not.toContain('private-');
  });
});

describe('official API boundary', () => {
  it('does not download a foreign item or an unfinished signed file', async () => {
    const calls: string[] = [];
    const provider = new Documenso('http://localhost:3469', 'secret', 1000, async (input) => {
      calls.push(String(input));
      return Response.json(document());
    });
    await expect(provider.document('envelope_qa', 'foreign-file', 'original')).rejects.toThrow(
      'DOCUMENT_ITEM_NOT_FOUND',
    );
    await expect(provider.document('envelope_qa', 'file-1', 'signed')).rejects.toThrow(
      'SIGNED_PDF_NOT_READY',
    );
    expect(calls.every((url) => url.endsWith('/envelope/envelope_qa'))).toBe(true);
  });
  it('returns exact sealed bytes and rejects non-PDF responses', async () => {
    const sealed = Buffer.from('%PDF-1.7\nSYNTHETIC SEALED BYTE FIXTURE\x00\xff', 'latin1');
    const provider = new Documenso('http://localhost:3469', 'secret', 1000, async (input) =>
      String(input).endsWith('/envelope/envelope_qa')
        ? Response.json({ ...document(), status: 'COMPLETED', completedAt: at })
        : new Response(sealed),
    );
    expect(await provider.document('envelope_qa', 'file-1', 'signed')).toEqual(sealed);
    const invalid = new Documenso(
      'http://localhost:3469',
      'secret',
      1000,
      async () => new Response('<html>Error</html>'),
    );
    await expect(invalid.pdf('/file')).rejects.toThrow('INVALID_PROVIDER_PDF');
  });
  it('classifies timed-out writes as uncertain and uses native redistribution', async () => {
    const offline = new Documenso('http://localhost:3469', 'secret', 1000, async () => {
      throw new TypeError('offline');
    });
    await expect(offline.create({}, [])).rejects.toMatchObject({ uncertain: true });
    await expect(offline.get('qa')).rejects.toMatchObject({ uncertain: false });
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = new Documenso('http://localhost:3469', 'secret', 1000, async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({});
    });
    await provider.remind('qa', [8]);
    expect(calls).toEqual([
      {
        url: 'http://localhost:3469/api/v2/envelope/redistribute',
        body: { envelopeId: 'qa', recipients: [8] },
      },
    ]);
    await expect(provider.remind('qa', [])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('trusted Portal identity', () => {
  it('requires both a recognized client key and a verified canonical identity', () => {
    const settings = loadBridgeConfig({
      NODE_ENV: 'test',
      DOCUMENSO_BASE_URL: 'http://localhost:3469',
      ESIGN_DATABASE_URL: 'postgres://localhost/qa',
      ESIGN_CREDENTIAL_KEY: '0'.repeat(64),
      ESIGN_WEBHOOK_SECRET: 'test'.repeat(10),
      ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
        { id: 'qa', keyHash: sha256('trusted-key'), portalOrigin: 'http://localhost:3000' },
      ]),
    });
    const actor = (verifiedEmails: string[]) =>
      Buffer.from(JSON.stringify({ agentId: 42, admin: false, verifiedEmails })).toString(
        'base64url',
      );
    expect(
      authenticate(
        { authorization: 'Bearer trusted-key', 'x-portal-actor': actor(['owner@example.invalid']) },
        settings,
      ).agentId,
    ).toBe(42);
    expect(() =>
      authenticate(
        { authorization: 'Bearer wrong-key', 'x-portal-actor': actor(['owner@example.invalid']) },
        settings,
      ),
    ).toThrow('UNAUTHORIZED');
    expect(() =>
      authenticate({ authorization: 'Bearer trusted-key', 'x-portal-actor': actor([]) }, settings),
    ).toThrow('INVALID_PORTAL_ACTOR');
  });
});

describe('recipient actions follow authoritative native order', () => {
  it('keeps company waiting until the owner signs, rejects expiry and completed tokens', () => {
    const native = document();
    native.status = 'PENDING';
    let projection = projectEnvelope(native, []);
    expect(recipientIsCurrent(projection, 1)).toBe(true);
    expect(recipientIsCurrent(projection, 2)).toBe(false);
    expect(recipientIsCurrent(projection, 99)).toBe(false);
    native.recipients[0].signingStatus = 'SIGNED';
    native.recipients[0].signedAt = at;
    projection = projectEnvelope(native, []);
    expect(recipientIsCurrent(projection, 1)).toBe(false);
    expect(recipientIsCurrent(projection, 2)).toBe(true);
    native.recipients[1].expiresAt = '2000-01-01T00:00:00.000Z';
    expect(recipientIsCurrent(projectEnvelope(native, []), 2)).toBe(false);
    native.status = 'COMPLETED';
    expect(recipientIsCurrent(projectEnvelope(native, []), 2)).toBe(false);
    native.status = 'PENDING';
    native.recipients[1].expiresAt = null;
    native.documentMeta!.signingOrder = 'PARALLEL';
    expect(recipientIsCurrent(projectEnvelope(native, []), 2)).toBe(true);
  });
  it('binds webhook authentication to a specific native connection', () => {
    const config = loadBridgeConfig({
      NODE_ENV: 'test',
      DOCUMENSO_BASE_URL: 'http://localhost:3469',
      ESIGN_DATABASE_URL: 'postgres://localhost/qa',
      ESIGN_CREDENTIAL_KEY: '0'.repeat(64),
      ESIGN_WEBHOOK_SECRET: 'synthetic-secret'.repeat(4),
      ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
        { id: 'qa', keyHash: sha256('key'), portalOrigin: 'http://localhost:3000' },
      ]),
    });
    expect(webhookSecret(config, 'connection-a')).toHaveLength(64);
    expect(webhookSecret(config, 'connection-a')).not.toBe(webhookSecret(config, 'connection-b'));
    expect(() => authenticate({}, config)).toThrow('UNAUTHORIZED');
    expect(() =>
      authenticate({ authorization: 'Bearer key', 'x-portal-actor': 'invalid-json' }, config),
    ).toThrow('INVALID_PORTAL_ACTOR');
  });
});
