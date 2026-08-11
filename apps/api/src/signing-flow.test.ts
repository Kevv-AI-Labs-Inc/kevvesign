import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { EmailMessage, EmailPort } from '@esign/domain';
import { InMemoryRepository, seedState, systemClock } from '@esign/domain';
import {
  HmacManifestSigner,
  LocalFileScanner,
  LocalObjectStore,
  PlatformEvidenceFinalizer,
} from '@esign/infrastructure';
import type { AppConfig } from './config';
import { ESignService } from './services';
import { buildServer } from './server';

class FakeEmail implements EmailPort {
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { messageId: crypto.randomUUID() };
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
  SIGNING_ENGINE_PROVIDER: 'native',
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
  DOCUMENSO_REQUEST_TIMEOUT_MS: 15_000,
};

describe('one-email signing journey', () => {
  const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('keeps scanner GET safe and completes a verifiable package', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-api-'));
    const repository = new InMemoryRepository(seedState());
    const objects = new LocalObjectStore(path.join(root, 'objects'));
    const email = new FakeEmail();
    const signer = new HmacManifestSigner(config.SESSION_SECRET);
    const finalizer = new PlatformEvidenceFinalizer(repository, objects, signer);
    const scanner = new LocalFileScanner();
    const service = new ESignService(
      repository,
      objects,
      email,
      finalizer,
      scanner,
      config.PUBLIC_BASE_URL,
      systemClock,
    );

    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    const template = await service.createTemplate(
      principal,
      {
        name: 'Synthetic NY Offer',
        sourceName: 'Synthetic test form',
        licenseOwner: 'Test fixture',
        edition: '1',
        effectiveDate: '2026-01-01',
        jurisdiction: 'NY',
        businessDomain: 'REAL_ESTATE',
        approvalRequired: false,
        retentionPolicyId: 'real-estate-7y',
      },
      { bytes, filename: 'synthetic-offer.pdf', mimetype: 'application/pdf' },
      { requestId: 'create-template', ip: '127.0.0.1', userAgent: 'test' },
    );
    const draft = template.versions[0]!;
    const role = draft.roles[0]!;
    const document = draft.documents[0]!;
    const fields = [
      {
        id: crypto.randomUUID(),
        documentId: document.id,
        page: 1,
        type: 'full_name' as const,
        roleId: role.id,
        label: 'Legal name',
        required: true,
        readOnly: false,
        sensitive: false,
        tabIndex: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.04, rotation: 0 as const },
      },
      {
        id: crypto.randomUUID(),
        documentId: document.id,
        page: 1,
        type: 'signature' as const,
        roleId: role.id,
        label: 'Buyer signature',
        required: true,
        readOnly: false,
        sensitive: false,
        tabIndex: 1,
        rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05, rotation: 0 as const },
      },
    ];
    await service.updateDraft(
      principal,
      template.id,
      draft.id,
      { roles: draft.roles, fields },
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
        subject: 'Please sign synthetic offer',
        message: 'Review the attached synthetic form.',
        expiresAt: '2027-01-01T00:00:00.000Z',
        recipients: [{ roleId: role.id, name: 'Alex Buyer', email: 'alex@example.test' }],
        mergeData: {},
      },
      'create-key',
      { requestId: 'create', ip: '127.0.0.1', userAgent: 'test' },
    );
    const send = await service.sendEnvelope(principal, envelope.id, 'send-key', {
      requestId: 'send',
      ip: '127.0.0.1',
      userAgent: 'test',
    });
    const token = send.invitationUrls[0]!.split('/').at(-1)!;

    const server = await buildServer(config, { repository, objects, email, signer, scanner });
    servers.push(server);

    const firstGet = await server.inject({ method: 'GET', url: `/v1/invitations/${token}` });
    const secondGet = await server.inject({ method: 'GET', url: `/v1/invitations/${token}` });
    expect(firstGet.statusCode).toBe(200);
    expect(secondGet.statusCode).toBe(200);
    const beforeExchange = repository.snapshot();
    expect(beforeExchange.recipientSessions).toHaveLength(0);
    expect(beforeExchange.envelopes[0]!.recipients[0]!.status).toBe('ACTIVE');
    expect(beforeExchange.auditEvents.some((event) => event.type.includes('consent'))).toBe(false);

    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/signing/session/exchange',
      payload: { token },
      headers: { origin: config.WEB_ORIGIN },
    });
    expect(exchange.statusCode).toBe(200);
    const exchangeBody = exchange.json() as {
      data: { envelope: { version: number }; disclosure: { version: string } };
    };
    const cookies = exchange.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const csrf = exchange.cookies.find((cookie) => cookie.name === 'esign_csrf')!.value;

    const consent = await server.inject({
      method: 'POST',
      url: '/v1/signing/consent',
      headers: { cookie: cookies, 'x-csrf-token': csrf, origin: config.WEB_ORIGIN },
      payload: { accepted: true, disclosureVersion: exchangeBody.data.disclosure.version },
    });
    expect(consent.statusCode).toBe(200);

    const progress = await server.inject({
      method: 'POST',
      url: '/v1/signing/progress',
      headers: { cookie: cookies, 'x-csrf-token': csrf, origin: config.WEB_ORIGIN },
      payload: {
        expectedEnvelopeVersion: exchangeBody.data.envelope.version,
        values: { [fields[0]!.id]: 'Alex Buyer' },
        signature: {
          kind: 'typed',
          value: 'Alex Buyer',
          intentText: 'I intend this mark to be my electronic signature.',
        },
      },
    });
    expect(progress.statusCode).toBe(200);

    const finish = await server.inject({
      method: 'POST',
      url: '/v1/signing/finish',
      headers: { cookie: cookies, 'x-csrf-token': csrf, origin: config.WEB_ORIGIN },
      payload: {},
    });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().data.envelope.status).toBe('COMPLETED');
    const completed = repository.snapshot();
    expect(completed.envelopes[0]!.status).toBe('COMPLETED');
    expect(completed.evidencePackages[0]!.verificationStatus).toBe('VERIFIED');
    expect(
      completed.evidencePackages[0]!.files.some((file) => file.contentType === 'application/pdf'),
    ).toBe(true);
  });
});
