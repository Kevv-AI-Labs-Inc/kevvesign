import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Envelope } from '@esign/contracts';
import type {
  EmailMessage,
  EmailPort,
  SigningEngine,
  SigningEngineDocumentInput,
  SigningEngineEnvelope,
} from '@esign/domain';
import { InMemoryRepository, seedState, systemClock } from '@esign/domain';
import {
  HmacManifestSigner,
  LocalFileScanner,
  LocalObjectStore,
  PlatformEvidenceFinalizer,
} from '@esign/infrastructure';
import type { AppConfig } from './config';
import { buildServer } from './server';
import { ESignService } from './services';

class RecordingEmail implements EmailPort {
  messages: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.messages.push(message);
    return { messageId: crypto.randomUUID() };
  }
}

class FakeSigningEngine implements SigningEngine {
  readonly provider = 'documenso' as const;
  status = 'DRAFT';
  created = 0;
  redistributed: Array<string | number | undefined> = [];
  cancelled = 0;
  private localId = '11111111-1111-4111-8111-111111111111';

  constructor(private readonly completedPdf: Uint8Array) {}

  private envelope(localId = this.localId): SigningEngineEnvelope {
    return {
      id: 'envelope_test123',
      externalId: localId,
      status: this.status,
      title: 'Synthetic agreement',
      recipients: [
        {
          id: 42,
          email: 'signer@example.test',
          name: 'Signer',
          role: 'SIGNER',
          sendStatus: this.status === 'DRAFT' ? 'NOT_SENT' : 'SENT',
          signingStatus: this.status === 'COMPLETED' ? 'SIGNED' : 'NOT_SIGNED',
        },
      ],
      items: [{ id: 'item_test123', title: 'agreement.pdf', order: 0 }],
    };
  }

  async health() {
    return { provider: this.provider, reachable: true };
  }

  async findEnvelopeByExternalId(_externalId: string) {
    return undefined;
  }

  async createEnvelope(envelope: Envelope, _documents: SigningEngineDocumentInput[]) {
    this.created += 1;
    this.localId = envelope.id;
    return this.envelope(envelope.id);
  }

  async distributeEnvelope(_envelopeId: string) {
    this.status = 'PENDING';
    return this.envelope();
  }

  async redistributeEnvelope(_envelopeId: string, recipientId?: string | number) {
    this.redistributed.push(recipientId);
    return this.envelope();
  }

  async cancelEnvelope(_envelopeId: string) {
    this.cancelled += 1;
  }

  async getEnvelope(_envelopeId: string) {
    return this.envelope();
  }

  async downloadItem(_itemId: string) {
    return this.completedPdf;
  }
}

const principal = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'admin@example.test',
  displayName: 'Demo Administrator',
  role: 'platform_admin' as const,
  workspaceId: '11111111-1111-4111-8111-111111111111',
};

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 4100,
  WEB_ORIGIN: 'http://localhost:5173',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  DATA_DIR: '.data-test',
  STORAGE_DRIVER: 'local',
  DATABASE_DRIVER: 'memory',
  EMAIL_DRIVER: 'local',
  SIGNING_DRIVER: 'local',
  SIGNING_ENGINE_PROVIDER: 'documenso',
  SIGNING_PROVIDER_CONNECTION_ID: 'default-signing-provider',
  SESSION_SECRET: 'test-secret-at-least-thirty-two-characters',
  LAUNCH_SESSION_TTL_SECONDS: 300,
  STAFF_SESSION_TTL_SECONDS: 3600,
  LOCAL_STAFF_EMAIL: 'admin@example.test',
  LOCAL_STAFF_ROLE: 'platform_admin',
  AZURE_STORAGE_CONTAINER_PREFIX: 'esign',
  AZURE_MANIFEST_KEY_NAME: 'esign-manifest',
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: 3310,
  OIDC_PROVIDERS_JSON: '[]',
  DOCUMENSO_BASE_URL: 'https://sign.example.test',
  DOCUMENSO_API_TOKEN: 'api_12345678901234567890',
  DOCUMENSO_WEBHOOK_SECRET: 'webhook-secret-at-least-thirty-two-characters',
  DOCUMENSO_REQUEST_TIMEOUT_MS: 15_000,
};

const requestContext = (requestId: string) => ({
  requestId,
  ip: '127.0.0.1',
  userAgent: 'provider-mapping-test',
});

async function providerFixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

async function createProviderHarness(
  repository: InMemoryRepository,
  engines: ReadonlyMap<string, SigningEngine>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'esign-provider-mapping-'));
  const objects = new LocalObjectStore(path.join(root, 'objects'));
  const email = new RecordingEmail();
  const signer = new HmacManifestSigner(config.SESSION_SECRET);
  const scanner = new LocalFileScanner();
  const service = new ESignService(
    repository,
    objects,
    email,
    new PlatformEvidenceFinalizer(repository, objects, signer),
    scanner,
    config.PUBLIC_BASE_URL,
    systemClock,
    config.LAUNCH_SESSION_TTL_SECONDS,
    config.STAFF_SESSION_TTL_SECONDS,
    engines,
  );
  return { service, objects, email, signer, scanner };
}

async function createReadyProviderEnvelope(
  service: ESignService,
  pdfBytes: Uint8Array,
  label: string,
) {
  const template = await service.createTemplate(
    principal,
    {
      name: `${label} agreement`,
      sourceName: `${label} fixture`,
      licenseOwner: 'Test',
      edition: '1',
      effectiveDate: '2026-01-01',
      jurisdiction: 'NY',
      businessDomain: 'REAL_ESTATE',
      approvalRequired: false,
      retentionPolicyId: 'real-estate-7y',
    },
    { bytes: pdfBytes, filename: `${label}.pdf`, mimetype: 'application/pdf' },
    requestContext(`${label}-create-template`),
  );
  const draft = template.versions[0]!;
  const role = draft.roles[0]!;
  const document = draft.documents[0]!;
  await service.updateDraft(
    principal,
    template.id,
    draft.id,
    {
      roles: draft.roles,
      fields: [
        {
          id: crypto.randomUUID(),
          documentId: document.id,
          page: 1,
          type: 'signature',
          roleId: role.id,
          label: 'Signature',
          required: true,
          readOnly: false,
          sensitive: false,
          tabIndex: 0,
          rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05, rotation: 0 },
        },
      ],
    },
    requestContext(`${label}-fields`),
  );
  await service.publishTemplate(
    principal,
    template.id,
    draft.id,
    requestContext(`${label}-publish`),
  );
  return service.createEnvelope(
    principal,
    {
      templateId: template.id,
      subject: `${label} agreement`,
      message: 'Please sign.',
      expiresAt: '2027-01-01T00:00:00.000Z',
      recipients: [{ roleId: role.id, name: 'Signer', email: 'signer@example.test' }],
      mergeData: {},
    },
    `${label}-create-envelope`,
    requestContext(`${label}-create-envelope`),
  );
}

describe('external signing engine lifecycle', () => {
  const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('delegates delivery, correlates recipients, and preserves completed provider PDFs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-engine-'));
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = config.SIGNING_PROVIDER_CONNECTION_ID;
    const repository = new InMemoryRepository(state);
    const objects = new LocalObjectStore(path.join(root, 'objects'));
    const email = new RecordingEmail();
    const signer = new HmacManifestSigner(config.SESSION_SECRET);
    const scanner = new LocalFileScanner();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const pdfBytes = await pdf.save();
    const engine = new FakeSigningEngine(pdfBytes);
    const service = new ESignService(
      repository,
      objects,
      email,
      new PlatformEvidenceFinalizer(repository, objects, signer),
      scanner,
      config.PUBLIC_BASE_URL,
      systemClock,
      config.LAUNCH_SESSION_TTL_SECONDS,
      config.STAFF_SESSION_TTL_SECONDS,
      new Map([[config.SIGNING_PROVIDER_CONNECTION_ID, engine]]),
    );

    const template = await service.createTemplate(
      principal,
      {
        name: 'Synthetic agreement',
        sourceName: 'Synthetic fixture',
        licenseOwner: 'Test',
        edition: '1',
        effectiveDate: '2026-01-01',
        jurisdiction: 'NY',
        businessDomain: 'REAL_ESTATE',
        approvalRequired: false,
        retentionPolicyId: 'real-estate-7y',
      },
      { bytes: pdfBytes, filename: 'agreement.pdf', mimetype: 'application/pdf' },
      { requestId: 'create-template', ip: '127.0.0.1', userAgent: 'test' },
    );
    const draft = template.versions[0]!;
    const role = draft.roles[0]!;
    const document = draft.documents[0]!;
    await service.updateDraft(
      principal,
      template.id,
      draft.id,
      {
        roles: draft.roles,
        fields: [
          {
            id: crypto.randomUUID(),
            documentId: document.id,
            page: 1,
            type: 'signature',
            roleId: role.id,
            label: 'Signature',
            required: true,
            readOnly: false,
            sensitive: false,
            tabIndex: 0,
            rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05, rotation: 0 },
          },
        ],
      },
      { requestId: 'fields', ip: '127.0.0.1', userAgent: 'test' },
    );
    await service.publishTemplate(principal, template.id, draft.id, {
      requestId: 'publish',
      ip: '127.0.0.1',
      userAgent: 'test',
    });
    const envelope = await service.createEnvelope(
      principal,
      {
        templateId: template.id,
        subject: 'Synthetic agreement',
        message: 'Please sign.',
        expiresAt: '2027-01-01T00:00:00.000Z',
        recipients: [{ roleId: role.id, name: 'Signer', email: 'signer@example.test' }],
        mergeData: {},
      },
      'create-engine-envelope',
      { requestId: 'create-envelope', ip: '127.0.0.1', userAgent: 'test' },
    );

    const sent = await service.sendEnvelope(principal, envelope.id, 'send-engine-envelope', {
      requestId: 'send',
      ip: '127.0.0.1',
      userAgent: 'test',
    });
    expect(sent.envelope).toMatchObject({
      status: 'SENT',
      signingEngine: 'documenso',
      signingEngineEnvelopeId: 'envelope_test123',
    });
    expect(sent.envelope.recipients[0]).toMatchObject({
      status: 'ACTIVE',
      signingEngineRecipientId: 42,
    });
    expect(sent.invitationUrls).toEqual([]);
    expect(email.messages).toHaveLength(0);
    expect(engine.created).toBe(1);

    await service.resendEnvelope(principal, envelope.id, sent.envelope.recipients[0]!.id);
    expect(engine.redistributed).toEqual([42]);
    expect(email.messages).toHaveLength(0);

    // Simulate a completion webhook winning the race against the local post-distribution commit.
    await repository.write((state) => {
      const projected = state.envelopes[0]!;
      projected.status = 'READY_TO_SEND';
      delete projected.sentAt;
      delete projected.signingEngineEnvelopeId;
      projected.signingEngineStatus = 'SYNCING';
    });
    engine.status = 'COMPLETED';
    const server = await buildServer(config, {
      repository,
      objects,
      email,
      signer,
      scanner,
      signingEngines: new Map([[config.SIGNING_PROVIDER_CONNECTION_ID, engine]]),
    });
    servers.push(server);
    const webhookPayload = {
      event: 'DOCUMENT_COMPLETED',
      createdAt: '2026-08-11T12:00:00.000Z',
      payload: {
        id: 'envelope_test123',
        externalId: envelope.id,
        status: 'COMPLETED',
        Recipient: [
          {
            id: 42,
            email: 'signer@example.test',
            signingStatus: 'SIGNED',
            signedAt: '2026-08-11T11:59:00.000Z',
          },
        ],
      },
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing-engine/webhooks/documenso',
          payload: webhookPayload,
        })
      ).statusCode,
    ).toBe(401);
    const completed = await server.inject({
      method: 'POST',
      url: '/v1/signing-engine/webhooks/documenso',
      headers: { 'x-documenso-secret': config.DOCUMENSO_WEBHOOK_SECRET! },
      payload: webhookPayload,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().data).toEqual({ accepted: true, replayed: false });
    const replay = await server.inject({
      method: 'POST',
      url: '/v1/signing-engine/webhooks/documenso',
      headers: { 'x-documenso-secret': config.DOCUMENSO_WEBHOOK_SECRET! },
      payload: webhookPayload,
    });
    expect(replay.json().data).toEqual({ accepted: true, replayed: true });

    const snapshot = repository.snapshot();
    expect(snapshot.envelopes[0]).toMatchObject({ status: 'COMPLETED' });
    expect(snapshot.envelopes[0]!.documents[0]!.completedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.evidencePackages[0]!.verificationStatus).toBe('VERIFIED');
    const completedObject = await objects.get(
      snapshot.envelopes[0]!.documents[0]!.completedObjectKey!,
    );
    expect(Buffer.from(completedObject).equals(Buffer.from(pdfBytes))).toBe(true);
  });
});

describe('workspace signing provider connections', () => {
  it('keeps an unmapped workspace on the native signer even when a Homix engine is registered', async () => {
    const repository = new InMemoryRepository(seedState());
    const pdfBytes = await providerFixturePdf();
    const homixEngine = new FakeSigningEngine(pdfBytes);
    const { service, email } = await createProviderHarness(
      repository,
      new Map([['homix-documenso', homixEngine]]),
    );
    const envelope = await createReadyProviderEnvelope(service, pdfBytes, 'native-unmapped');

    const sent = await service.sendEnvelope(
      principal,
      envelope.id,
      'native-unmapped-send',
      requestContext('native-unmapped-send'),
    );

    expect(sent.envelope).toMatchObject({ status: 'SENT' });
    expect(sent.envelope.signingProviderConnectionId).toBeUndefined();
    expect(sent.envelope.signingEngine).toBeUndefined();
    expect(sent.invitationUrls).toHaveLength(1);
    expect(homixEngine.created).toBe(0);
    expect(email.messages).toHaveLength(1);
  });

  it('routes two connections independently, freezes the chosen connection, and fails closed if it disappears', async () => {
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = 'homix-hr';
    const repository = new InMemoryRepository(state);
    const pdfBytes = await providerFixturePdf();
    const hrEngine = new FakeSigningEngine(pdfBytes);
    const realEstateEngine = new FakeSigningEngine(pdfBytes);
    const engines = new Map<string, SigningEngine>([
      ['homix-hr', hrEngine],
      ['homix-real-estate', realEstateEngine],
    ]);
    const { service } = await createProviderHarness(repository, engines);

    const hrEnvelope = await createReadyProviderEnvelope(service, pdfBytes, 'hr-route');
    const sentHr = await service.sendEnvelope(
      principal,
      hrEnvelope.id,
      'hr-route-send',
      requestContext('hr-route-send'),
    );
    expect(sentHr.envelope.signingProviderConnectionId).toBe('homix-hr');
    expect(hrEngine.created).toBe(1);
    expect(realEstateEngine.created).toBe(0);

    await repository.write((platform) => {
      platform.workspaces[0]!.signingProviderConnectionId = 'homix-real-estate';
    });
    await service.resendEnvelope(principal, hrEnvelope.id, sentHr.envelope.recipients[0]!.id);
    expect(hrEngine.redistributed).toEqual([42]);
    expect(realEstateEngine.redistributed).toEqual([]);

    const realEstateEnvelope = await createReadyProviderEnvelope(
      service,
      pdfBytes,
      'real-estate-route',
    );
    const sentRealEstate = await service.sendEnvelope(
      principal,
      realEstateEnvelope.id,
      'real-estate-route-send',
      requestContext('real-estate-route-send'),
    );
    expect(sentRealEstate.envelope.signingProviderConnectionId).toBe('homix-real-estate');
    expect(hrEngine.created).toBe(1);
    expect(realEstateEngine.created).toBe(1);

    engines.delete('homix-hr');
    await expect(
      service.resendEnvelope(principal, hrEnvelope.id, sentHr.envelope.recipients[0]!.id),
    ).rejects.toMatchObject({ code: 'signing_provider_unavailable', statusCode: 503 });
  });

  it('scopes webhook lookup and idempotency to the provider connection', async () => {
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = 'homix-hr';
    const repository = new InMemoryRepository(state);
    const pdfBytes = await providerFixturePdf();
    const hrEngine = new FakeSigningEngine(pdfBytes);
    const realEstateEngine = new FakeSigningEngine(pdfBytes);
    const { service } = await createProviderHarness(
      repository,
      new Map<string, SigningEngine>([
        ['homix-hr', hrEngine],
        ['homix-real-estate', realEstateEngine],
      ]),
    );

    const hrEnvelope = await createReadyProviderEnvelope(service, pdfBytes, 'hr-webhook');
    await service.sendEnvelope(
      principal,
      hrEnvelope.id,
      'hr-webhook-send',
      requestContext('hr-webhook-send'),
    );
    await repository.write((platform) => {
      platform.workspaces[0]!.signingProviderConnectionId = 'homix-real-estate';
    });
    const realEstateEnvelope = await createReadyProviderEnvelope(
      service,
      pdfBytes,
      'real-estate-webhook',
    );
    await service.sendEnvelope(
      principal,
      realEstateEnvelope.id,
      'real-estate-webhook-send',
      requestContext('real-estate-webhook-send'),
    );

    // The two fake provider accounts deliberately return the same provider envelope ID. The
    // connection identifier is therefore the only safe namespace for lookup and idempotency.
    const event = {
      event: 'DOCUMENT_OPENED',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: { envelopeId: 'envelope_test123', status: 'PENDING' },
    };
    expect(
      await service.handleSigningEngineEvent('homix-hr', event, requestContext('hr-webhook-event')),
    ).toEqual({ accepted: true, replayed: false });
    let snapshot = repository.snapshot();
    expect(snapshot.envelopes.find((candidate) => candidate.id === hrEnvelope.id)?.status).toBe(
      'IN_PROGRESS',
    );
    expect(
      snapshot.envelopes.find((candidate) => candidate.id === realEstateEnvelope.id)?.status,
    ).toBe('SENT');

    expect(
      await service.handleSigningEngineEvent(
        'homix-real-estate',
        event,
        requestContext('real-estate-webhook-event'),
      ),
    ).toEqual({ accepted: true, replayed: false });
    snapshot = repository.snapshot();
    expect(
      snapshot.envelopes.find((candidate) => candidate.id === realEstateEnvelope.id)?.status,
    ).toBe('IN_PROGRESS');
    expect(
      await service.handleSigningEngineEvent(
        'homix-real-estate',
        event,
        requestContext('real-estate-webhook-replay'),
      ),
    ).toEqual({ accepted: true, replayed: true });
  });

  it('rejects contradictory provider and external envelope identifiers on one connection', async () => {
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = 'homix-shared';
    const repository = new InMemoryRepository(state);
    const pdfBytes = await providerFixturePdf();
    const engine = new FakeSigningEngine(pdfBytes);
    const { service } = await createProviderHarness(
      repository,
      new Map<string, SigningEngine>([['homix-shared', engine]]),
    );
    const hrEnvelope = await createReadyProviderEnvelope(service, pdfBytes, 'hr-conflict');
    const realEstateEnvelope = await createReadyProviderEnvelope(
      service,
      pdfBytes,
      'real-estate-conflict',
    );
    await repository.write((platform) => {
      const hr = platform.envelopes.find((candidate) => candidate.id === hrEnvelope.id)!;
      hr.businessDomain = 'HR';
      hr.signingProviderConnectionId = 'homix-shared';
      hr.signingEngineEnvelopeId = 'provider-hr';
      hr.signingEngineStatus = 'PENDING';
      const realEstate = platform.envelopes.find(
        (candidate) => candidate.id === realEstateEnvelope.id,
      )!;
      realEstate.businessDomain = 'REAL_ESTATE';
      realEstate.signingProviderConnectionId = 'homix-shared';
      realEstate.signingEngineEnvelopeId = 'provider-real-estate';
      realEstate.signingEngineStatus = 'PENDING';
    });

    await expect(
      service.handleSigningEngineEvent(
        'homix-shared',
        {
          event: 'DOCUMENT_OPENED',
          createdAt: '2026-08-12T12:05:00.000Z',
          payload: {
            envelopeId: 'provider-hr',
            externalId: realEstateEnvelope.id,
            status: 'PENDING',
          },
        },
        requestContext('conflicting-webhook-identifiers'),
      ),
    ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });

    const snapshot = repository.snapshot();
    expect(snapshot.envelopes.find((candidate) => candidate.id === hrEnvelope.id)).toMatchObject({
      businessDomain: 'HR',
      signingEngineEnvelopeId: 'provider-hr',
    });
    expect(
      snapshot.envelopes.find((candidate) => candidate.id === realEstateEnvelope.id),
    ).toMatchObject({
      businessDomain: 'REAL_ESTATE',
      signingEngineEnvelopeId: 'provider-real-estate',
    });
  });

  it('rejects an ambiguous email fallback instead of binding a provider recipient', async () => {
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = 'homix-shared';
    const repository = new InMemoryRepository(state);
    const pdfBytes = await providerFixturePdf();
    const engine = new FakeSigningEngine(pdfBytes);
    const { service } = await createProviderHarness(
      repository,
      new Map<string, SigningEngine>([['homix-shared', engine]]),
    );
    const localEnvelope = await createReadyProviderEnvelope(service, pdfBytes, 'duplicate-email');
    await repository.write((platform) => {
      const envelope = platform.envelopes.find((candidate) => candidate.id === localEnvelope.id)!;
      envelope.signingProviderConnectionId = 'homix-shared';
      envelope.signingEngineStatus = 'SYNCING';
      const duplicate = structuredClone(envelope.recipients[0]!);
      duplicate.id = crypto.randomUUID();
      envelope.recipients.push(duplicate);
    });

    await expect(
      service.handleSigningEngineEvent(
        'homix-shared',
        {
          event: 'DOCUMENT_OPENED',
          createdAt: '2026-08-12T12:10:00.000Z',
          payload: {
            envelopeId: 'provider-duplicate-email',
            externalId: localEnvelope.id,
            status: 'PENDING',
            recipients: [
              {
                id: 55,
                email: 'signer@example.test',
                readStatus: 'OPENED',
              },
            ],
          },
        },
        requestContext('ambiguous-recipient-webhook'),
      ),
    ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });

    const snapshot = repository.snapshot();
    const envelope = snapshot.envelopes.find((candidate) => candidate.id === localEnvelope.id)!;
    expect(envelope.signingEngineEnvelopeId).toBeUndefined();
    expect(envelope.recipients).toHaveLength(2);
    expect(envelope.recipients.every((recipient) => !recipient.signingEngineRecipientId)).toBe(
      true,
    );
  });

  it('does not adopt a legacy provider envelope without a frozen connection after remapping', async () => {
    const state = seedState();
    state.workspaces[0]!.signingProviderConnectionId = 'homix-shared';
    const repository = new InMemoryRepository(state);
    const pdfBytes = await providerFixturePdf();
    const engine = new FakeSigningEngine(pdfBytes);
    const { service } = await createProviderHarness(
      repository,
      new Map<string, SigningEngine>([['homix-shared', engine]]),
    );
    const localEnvelope = await createReadyProviderEnvelope(service, pdfBytes, 'legacy-unfrozen');
    await repository.write((platform) => {
      const envelope = platform.envelopes.find((candidate) => candidate.id === localEnvelope.id)!;
      envelope.signingEngine = 'documenso';
      envelope.signingEngineEnvelopeId = 'provider-legacy';
      envelope.signingEngineStatus = 'PENDING';
      envelope.status = 'SENT';
      envelope.sentAt = '2026-08-12T12:00:00.000Z';
      envelope.recipients[0]!.status = 'ACTIVE';
      delete envelope.signingProviderConnectionId;
    });

    await expect(
      service.handleSigningEngineEvent(
        'homix-shared',
        {
          event: 'DOCUMENT_OPENED',
          createdAt: '2026-08-12T12:15:00.000Z',
          payload: {
            envelopeId: 'provider-legacy',
            externalId: localEnvelope.id,
            status: 'PENDING',
          },
        },
        requestContext('legacy-unfrozen-webhook'),
      ),
    ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });

    await expect(
      service.resendEnvelope(principal, localEnvelope.id, localEnvelope.recipients[0]!.id),
    ).rejects.toMatchObject({ code: 'signing_provider_unavailable', statusCode: 503 });
    await expect(
      service.voidEnvelope(
        principal,
        localEnvelope.id,
        'Legacy connection cannot be proven.',
        requestContext('legacy-unfrozen-void'),
      ),
    ).rejects.toMatchObject({ code: 'signing_provider_unavailable', statusCode: 503 });

    const snapshot = repository.snapshot();
    const envelope = snapshot.envelopes.find((candidate) => candidate.id === localEnvelope.id)!;
    expect(envelope.signingProviderConnectionId).toBeUndefined();
    expect(envelope.signingEngineEnvelopeId).toBe('provider-legacy');
  });
});
