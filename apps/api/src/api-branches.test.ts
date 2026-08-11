import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { EmailMessage, EmailPort } from '@esign/domain';
import { InMemoryRepository, seedState } from '@esign/domain';
import { HmacManifestSigner, LocalFileScanner, LocalObjectStore } from '@esign/infrastructure';
import { StaffAuthenticator } from './auth';
import { loadConfig, type AppConfig } from './config';
import { buildServer } from './server';

class CapturingEmail implements EmailPort {
  messages: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.messages.push(message);
    return { messageId: `message-${this.messages.length}` };
  }
}

const baseConfig: AppConfig = {
  NODE_ENV: 'development',
  PORT: 4100,
  WEB_ORIGIN: 'http://localhost:5173',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  DATA_DIR: '.data-test',
  STORAGE_DRIVER: 'local',
  DATABASE_DRIVER: 'memory',
  EMAIL_DRIVER: 'local',
  SIGNING_DRIVER: 'local',
  SESSION_SECRET: 'test-secret-at-least-thirty-two-characters',
  PORTAL_LAUNCH_TTL_SECONDS: 300,
  STAFF_SESSION_TTL_SECONDS: 3600,
  LOCAL_STAFF_EMAIL: 'admin@example.test',
  LOCAL_STAFF_ROLE: 'platform_admin',
  AZURE_STORAGE_CONTAINER_PREFIX: 'esign',
  AZURE_MANIFEST_KEY_NAME: 'esign-manifest',
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: 3310,
};

async function syntheticPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return pdf.save();
}

function multipart(
  fields: Record<string, string>,
  file?: { bytes: Uint8Array; filename: string; contentType: string },
) {
  const boundary = `esign-${crypto.randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
      Buffer.from(file.bytes),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

describe('configuration and staff authentication', () => {
  it('loads safe local defaults and rejects invalid or incomplete production settings', () => {
    expect(loadConfig({}).DATABASE_DRIVER).toBe('file');
    expect(() => loadConfig({ PORT: '70000' })).toThrow('Invalid environment configuration');
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'Missing production configuration',
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AZURE_SQL_CONNECTION_STRING: 'Server=tcp:example;',
        AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
        AZURE_KEY_VAULT_URL: 'https://example.vault.azure.net',
        ACS_EMAIL_CONNECTION_STRING:
          'endpoint=https://example.communication.azure.com/;accesskey=x',
        ACS_EMAIL_SENDER: 'sender@example.test',
        ENTRA_TENANT_ID: 'tenant',
        ENTRA_CLIENT_ID: 'client',
        CLAMAV_HOST: 'scanner',
      }),
    ).toThrow('Production requires Azure SQL, Blob, and Communication Services drivers');
    expect(
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'azure-sql',
        STORAGE_DRIVER: 'azure',
        EMAIL_DRIVER: 'azure',
        SIGNING_DRIVER: 'azure',
        AZURE_SQL_CONNECTION_STRING: 'Server=tcp:example;',
        AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
        AZURE_KEY_VAULT_URL: 'https://example.vault.azure.net',
        ACS_EMAIL_CONNECTION_STRING:
          'endpoint=https://example.communication.azure.com/;accesskey=x',
        ACS_EMAIL_SENDER: 'sender@example.test',
        ENTRA_TENANT_ID: 'tenant',
        ENTRA_CLIENT_ID: 'client',
        CLAMAV_HOST: 'scanner',
      }).NODE_ENV,
    ).toBe('production');
  });

  it('uses a synthetic local principal and denies malformed production credentials', async () => {
    const repository = new InMemoryRepository(seedState());
    const local = new StaffAuthenticator(baseConfig, repository);
    await expect(local.authenticate({ headers: {} } as never)).resolves.toMatchObject({
      email: 'admin@example.test',
      role: 'platform_admin',
    });

    const production = new StaffAuthenticator(
      {
        ...baseConfig,
        NODE_ENV: 'production',
        ENTRA_TENANT_ID: '00000000-0000-4000-8000-000000000000',
        ENTRA_CLIENT_ID: '00000000-0000-4000-8000-000000000001',
      },
      repository,
    );
    await expect(production.authenticate({ headers: {} } as never)).rejects.toMatchObject({
      code: 'unauthorized',
      statusCode: 401,
    });
    await expect(
      production.authenticate({ headers: { authorization: 'Bearer malformed' } } as never),
    ).rejects.toMatchObject({ code: 'unauthorized', statusCode: 401 });
  });
});

describe('staff API and signing branches', () => {
  const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('covers template, transaction, approval, resend, signing, evidence, and void operations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-routes-'));
    const repository = new InMemoryRepository(seedState());
    const objects = new LocalObjectStore(path.join(root, 'objects'));
    const email = new CapturingEmail();
    const signer = new HmacManifestSigner(baseConfig.SESSION_SECRET);
    const server = await buildServer(baseConfig, {
      repository,
      objects,
      email,
      signer,
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/docs/openapi.json' })).statusCode).toBe(
      200,
    );
    expect((await server.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/v1/dashboard' })).statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/application-clients',
          payload: {
            name: 'Expired integration',
            scopes: ['templates:read'],
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        })
      ).statusCode,
    ).toBe(422);
    const clientResponse = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: {
        name: 'Listing application',
        scopes: ['templates:read', 'envelopes:read'],
      },
    });
    expect(clientResponse.statusCode).toBe(201);
    expect(clientResponse.headers['cache-control']).toBe('no-store');
    const applicationClient = clientResponse.json().data;
    expect(applicationClient.client).not.toHaveProperty('secretHash');
    expect(applicationClient.credential).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
    expect(
      (await server.inject({ method: 'GET', url: '/v1/application-clients' })).json().data,
    ).toHaveLength(1);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/templates',
          headers: { 'x-esign-key': applicationClient.credential },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: { 'x-esign-key': applicationClient.credential },
          payload: {
            kind: 'PROPERTY',
            name: 'Scope denial',
            jurisdiction: 'NY',
          },
        })
      ).statusCode,
    ).toBe(403);
    const rotatedResponse = await server.inject({
      method: 'POST',
      url: `/v1/application-clients/${applicationClient.client.id}/rotate`,
    });
    const rotatedCredential = rotatedResponse.json().data.credential;
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/templates',
          headers: { 'x-esign-key': applicationClient.credential },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/templates',
          headers: { 'x-esign-key': rotatedCredential },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/application-clients/${applicationClient.client.id}/revoke`,
        })
      ).json().data.status,
    ).toBe('REVOKED');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/templates',
          headers: { 'x-esign-key': rotatedCredential },
        })
      ).statusCode,
    ).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/v1/templates' })).json()).toEqual({
      data: [],
    });
    expect(
      (await server.inject({ method: 'GET', url: '/v1/templates/not-a-uuid' })).statusCode,
    ).toBe(422);

    const badMetadata = multipart(
      { metadata: '{broken' },
      {
        bytes: await syntheticPdf(),
        filename: 'form.pdf',
        contentType: 'application/pdf',
      },
    );
    expect(
      (await server.inject({ method: 'POST', url: '/v1/templates', ...badMetadata })).statusCode,
    ).toBe(422);
    const missingFile = multipart({ metadata: '{}' });
    expect(
      (await server.inject({ method: 'POST', url: '/v1/templates', ...missingFile })).statusCode,
    ).toBe(422);

    const metadata = {
      name: 'NY offer package',
      sourceName: 'Licensed synthetic fixture',
      licenseOwner: 'Example Brokerage',
      edition: '2026.1',
      effectiveDate: '2026-01-01',
      jurisdiction: 'NY',
      businessDomain: 'REAL_ESTATE',
      approvalRequired: true,
      retentionPolicyId: 'real-estate-7y',
    };
    const upload = multipart(
      { metadata: JSON.stringify(metadata) },
      {
        bytes: await syntheticPdf(),
        filename: 'licensed-fixture.pdf',
        contentType: 'application/pdf',
      },
    );
    const createdResponse = await server.inject({
      method: 'POST',
      url: '/v1/templates',
      ...upload,
    });
    expect(createdResponse.statusCode).toBe(201);
    const template = createdResponse.json().data;
    const version = template.versions[0];
    const role = version.roles[0];
    const document = version.documents[0];

    const additional = multipart(
      { retentionClass: 'real-estate-7y' },
      {
        bytes: await syntheticPdf(),
        filename: 'disclosure.pdf',
        contentType: 'application/pdf',
      },
    );
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/templates/${template.id}/versions/${version.id}/documents`,
          ...additional,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/v1/templates/${template.id}/documents/${document.id}`,
        })
      ).headers['content-type'],
    ).toContain('application/pdf');

    const nameFieldId = crypto.randomUUID();
    const signatureFieldId = crypto.randomUUID();
    const mergeFieldId = crypto.randomUUID();
    const draft = {
      roles: [role],
      fields: [
        {
          id: nameFieldId,
          documentId: document.id,
          page: 1,
          type: 'full_name',
          roleId: role.id,
          label: 'Legal name',
          required: true,
          readOnly: false,
          sensitive: false,
          tabIndex: 0,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.04, rotation: 0 },
        },
        {
          id: signatureFieldId,
          documentId: document.id,
          page: 1,
          type: 'signature',
          roleId: role.id,
          label: 'Buyer signature',
          required: true,
          readOnly: false,
          sensitive: false,
          tabIndex: 1,
          rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.05, rotation: 0 },
        },
        {
          id: mergeFieldId,
          documentId: document.id,
          page: 1,
          type: 'merge',
          roleId: null,
          label: 'Property address',
          required: false,
          readOnly: true,
          sensitive: false,
          tabIndex: 2,
          mergeKey: 'property.address',
          rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.04, rotation: 0 },
        },
      ],
    };
    expect(
      (
        await server.inject({
          method: 'PATCH',
          url: `/v1/templates/${template.id}/versions/${version.id}`,
          payload: draft,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/templates/${template.id}/versions/${version.id}/publish`,
        })
      ).statusCode,
    ).toBe(200);
    const cloneResponse = await server.inject({
      method: 'POST',
      url: `/v1/templates/${template.id}/versions/${version.id}/clone`,
    });
    expect(cloneResponse.statusCode).toBe(201);
    const clone = cloneResponse.json().data;

    const publishedReaderResponse = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: { name: 'Published template reader', scopes: ['templates:read'] },
    });
    const publishedReader = publishedReaderResponse.json().data.credential;
    const applicationTemplate = (
      await server.inject({
        method: 'GET',
        url: `/v1/templates/${template.id}`,
        headers: { 'x-esign-key': publishedReader },
      })
    ).json().data;
    expect(applicationTemplate.versions).toHaveLength(1);
    expect(applicationTemplate.versions[0].status).toBe('PUBLISHED');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/v1/templates/${template.id}/documents/${document.id}`,
          headers: { 'x-esign-key': publishedReader },
        })
      ).statusCode,
    ).toBe(200);

    const transactionInput = {
      kind: 'PROPERTY',
      name: '123 Main Street offer',
      jurisdiction: 'NY',
      externalReference: 'MLS-TEST-1',
      propertyAddress: '123 Main Street, New York, NY',
    };
    const transactionResponse = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      payload: transactionInput,
    });
    expect(transactionResponse.statusCode).toBe(201);
    const transaction = transactionResponse.json().data;
    expect(
      (await server.inject({ method: 'GET', url: '/v1/transactions' })).json().data,
    ).toHaveLength(1);
    expect(
      (await server.inject({ method: 'POST', url: '/v1/transactions', payload: transactionInput }))
        .statusCode,
    ).toBe(409);

    const envelopeInput = {
      templateId: template.id,
      transactionId: transaction.id,
      externalReference: 'OFFER-1',
      subject: 'Review and sign the offer',
      message: '<Review> & sign',
      expiresAt: '2027-01-01T00:00:00.000Z',
      recipients: [
        { roleId: role.id, name: 'Alex Buyer', email: 'ALEX@example.test', accessCode: '2468' },
      ],
      mergeData: { 'property.address': '123 Main Street' },
    };
    expect(
      (await server.inject({ method: 'POST', url: '/v1/envelopes', payload: envelopeInput }))
        .statusCode,
    ).toBe(400);
    const createEnvelopeResponse = await server.inject({
      method: 'POST',
      url: '/v1/envelopes',
      headers: { 'idempotency-key': 'create-offer-1' },
      payload: envelopeInput,
    });
    expect(createEnvelopeResponse.statusCode).toBe(201);
    const envelope = createEnvelopeResponse.json().data;
    const replay = await server.inject({
      method: 'POST',
      url: '/v1/envelopes',
      headers: { 'idempotency-key': 'create-offer-1' },
      payload: envelopeInput,
    });
    expect(replay.json().data.id).toBe(envelope.id);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/envelopes',
          headers: { 'idempotency-key': 'create-offer-1' },
          payload: { ...envelopeInput, subject: 'Different request' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await server.inject({ method: 'GET', url: '/v1/envelopes' })).json().data).toHaveLength(
      1,
    );
    expect(
      (await server.inject({ method: 'GET', url: `/v1/envelopes/${envelope.id}` })).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: 'GET', url: `/v1/envelopes/${envelope.id}/evidence` }))
        .statusCode,
    ).toBe(409);

    const approvalPending = await server.inject({
      method: 'POST',
      url: `/v1/envelopes/${envelope.id}/send`,
      headers: { 'idempotency-key': 'send-offer-1' },
    });
    expect(approvalPending.json().data.envelope.status).toBe('APPROVAL_PENDING');
    expect(
      (await server.inject({ method: 'POST', url: `/v1/envelopes/${envelope.id}/approve` })).json()
        .data.status,
    ).toBe('READY_TO_SEND');
    const sent = await server.inject({
      method: 'POST',
      url: `/v1/envelopes/${envelope.id}/send`,
      headers: { 'idempotency-key': 'send-offer-1' },
    });
    expect(sent.json().data.envelope.status).toBe('SENT');
    expect(sent.json().data.invitationUrls).toHaveLength(1);
    const oldToken = sent.json().data.invitationUrls[0].split('/').at(-1);
    const sendReplay = await server.inject({
      method: 'POST',
      url: `/v1/envelopes/${envelope.id}/send`,
      headers: { 'idempotency-key': 'send-offer-1' },
    });
    expect(sendReplay.json().data.replayed).toBe(true);
    expect(
      (await server.inject({ method: 'GET', url: `/v1/invitations/${oldToken}` })).json(),
    ).toEqual({ data: { valid: true } });

    const resend = await server.inject({
      method: 'POST',
      url: `/v1/envelopes/${envelope.id}/recipients/${envelope.recipients[0].id}/resend`,
    });
    const token = resend.json().data.invitationUrl.split('/').at(-1);
    expect(
      (await server.inject({ method: 'GET', url: `/v1/invitations/${oldToken}` })).json(),
    ).toEqual({ data: { valid: false } });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/session/exchange',
          payload: { token, accessCode: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/signing/session/exchange',
      payload: { token, accessCode: '2468' },
    });
    expect(exchange.statusCode).toBe(200);
    const cookies = cookieHeader(exchange.cookies);
    const csrf = exchange.cookies.find((cookie) => cookie.name === 'esign_csrf')!.value;
    const exchangeContext = exchange.json().data;
    expect((await server.inject({ method: 'GET', url: '/v1/signing/context' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/v1/signing/context',
          headers: { cookie: cookies },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/consent',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: { accepted: true, disclosureVersion: 'old-version' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/consent',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: { accepted: true, disclosureVersion: exchangeContext.disclosure.version },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/progress',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: {
            expectedEnvelopeVersion: exchangeContext.envelope.version + 100,
            values: {},
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/progress',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: {
            expectedEnvelopeVersion: exchangeContext.envelope.version,
            values: { [crypto.randomUUID()]: 'forbidden' },
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/progress',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: {
            expectedEnvelopeVersion: exchangeContext.envelope.version,
            values: { [nameFieldId]: 'Alex Buyer' },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/finish',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/signing/progress',
          headers: { cookie: cookies, 'x-csrf-token': csrf },
          payload: {
            expectedEnvelopeVersion: exchangeContext.envelope.version,
            values: {},
            signature: {
              kind: 'typed',
              value: 'Alex Buyer',
              intentText: 'I intend this mark to be my electronic signature.',
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    const completedResponse = await server.inject({
      method: 'POST',
      url: '/v1/signing/finish',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(completedResponse.statusCode).toBe(200);
    expect(completedResponse.json().data.envelope.status).toBe('COMPLETED');
    const evidenceResponse = await server.inject({
      method: 'GET',
      url: `/v1/envelopes/${envelope.id}/evidence`,
    });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.json().data.verificationStatus).toBe('VERIFIED');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/v1/envelopes/${envelope.id}/evidence/manifest.json`,
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await server.inject({
          method: 'PATCH',
          url: `/v1/templates/${template.id}/versions/${version.id}`,
          payload: draft,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/templates/${template.id}/versions/${version.id}/retire`,
        })
      ).json().data.status,
    ).toBe('RETIRED');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/templates/${template.id}/versions/${clone.id}/retire`,
        })
      ).statusCode,
    ).toBe(409);

    const secondTemplate = await server.inject({
      method: 'POST',
      url: `/v1/templates/${template.id}/versions/${clone.id}/publish`,
    });
    expect(secondTemplate.statusCode).toBe(200);
    const secondEnvelope = await server.inject({
      method: 'POST',
      url: '/v1/envelopes',
      headers: { 'idempotency-key': 'create-offer-2' },
      payload: {
        ...envelopeInput,
        externalReference: 'OFFER-2',
        subject: 'Second offer',
      },
    });
    const secondEnvelopeId = secondEnvelope.json().data.id;
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/v1/envelopes/${secondEnvelopeId}/void`,
          payload: { reason: 'Withdrawn by sender' },
        })
      ).json().data.status,
    ).toBe('VOIDED');
    expect(email.messages.length).toBeGreaterThanOrEqual(2);
  });
});
