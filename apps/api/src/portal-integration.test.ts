import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ApplicationClient,
  BusinessDomain,
  Envelope,
  PlatformState,
  Template,
  Transaction,
} from '@esign/contracts';
import type { EmailMessage, EmailPort } from '@esign/domain';
import { InMemoryRepository, seedState, sha256 } from '@esign/domain';
import { HmacManifestSigner, LocalFileScanner, LocalObjectStore } from '@esign/infrastructure';
import type { AppConfig } from './config';
import { buildServer } from './server';

class NoopEmail implements EmailPort {
  async send(_message: EmailMessage) {
    return { messageId: crypto.randomUUID() };
  }
}

const config: AppConfig = {
  NODE_ENV: 'development',
  PORT: 4100,
  WEB_ORIGIN: 'http://localhost:5173',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  DATA_DIR: '.data-test',
  STORAGE_DRIVER: 'local',
  DATABASE_DRIVER: 'memory',
  EMAIL_DRIVER: 'local',
  SIGNING_DRIVER: 'local',
  SIGNING_ENGINE_PROVIDER: 'native',
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
  DOCUMENSO_REQUEST_TIMEOUT_MS: 15_000,
};

function cookies(response: { cookies: Array<{ name: string; value: string }> }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_TIME = '2026-08-12T12:00:00.000Z';

function publishedTemplate(domain: BusinessDomain, name: string): Template {
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    activeVersionId: versionId,
    versions: [
      {
        id: versionId,
        version: 1,
        status: 'PUBLISHED',
        createdAt: FIXTURE_TIME,
        publishedAt: FIXTURE_TIME,
        sourceName: `${name} fixture`,
        licenseOwner: 'Test Brokerage',
        edition: '1',
        effectiveDate: '2026-08-12',
        jurisdiction: domain === 'HR' ? 'NONE' : 'NY',
        businessDomain: domain,
        approvalRequired: false,
        retentionPolicyId: domain === 'HR' ? 'hr-7y' : 'real-estate-7y',
        documents: [],
        roles: [],
        fields: [],
      },
    ],
  };
}

function preparedEnvelope(template: Template, domain: BusinessDomain, subject: string): Envelope {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    templateId: template.id,
    templateVersionId: template.activeVersionId!,
    subject,
    message: 'Synthetic domain-isolation fixture.',
    status: 'PREPARED',
    jurisdiction: domain === 'HR' ? 'NONE' : 'NY',
    businessDomain: domain,
    approvalRequired: false,
    expiresAt: '2027-08-12T12:00:00.000Z',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    version: 1,
    documents: [],
    fields: [],
    recipients: [],
    retentionPolicyId: domain === 'HR' ? 'hr-7y' : 'real-estate-7y',
  };
}

function transaction(domain: BusinessDomain, name: string): Transaction {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    kind: domain === 'HR' ? 'HR_PACKET' : 'PROPERTY',
    name,
    jurisdiction: domain === 'HR' ? 'NONE' : 'NY',
    envelopeIds: [],
    createdAt: FIXTURE_TIME,
  };
}

function domainFixtureState(): {
  state: PlatformState;
  hrTemplate: Template;
  realEstateTemplate: Template;
  hrEnvelope: Envelope;
  realEstateEnvelope: Envelope;
} {
  const state = seedState(FIXTURE_TIME);
  const hrTemplate = publishedTemplate('HR', 'Employee onboarding packet');
  const realEstateTemplate = publishedTemplate('REAL_ESTATE', 'NY listing agreement');
  const hrEnvelope = preparedEnvelope(hrTemplate, 'HR', 'Employee onboarding');
  const realEstateEnvelope = preparedEnvelope(
    realEstateTemplate,
    'REAL_ESTATE',
    'Listing agreement',
  );
  state.templates.push(hrTemplate, realEstateTemplate);
  state.envelopes.push(hrEnvelope, realEstateEnvelope);
  state.transactions.push(
    transaction('HR', 'Existing employee packet'),
    transaction('REAL_ESTATE', 'Existing listing transaction'),
  );
  return { state, hrTemplate, realEstateTemplate, hrEnvelope, realEstateEnvelope };
}

describe('pluggable delegated staff access', () => {
  const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('uses an exact return URL, a one-time fragment ticket, scoped CSRF, and dual attribution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-integration-'));
    const repository = new InMemoryRepository(seedState());
    const server = await buildServer(config, {
      repository,
      objects: new LocalObjectStore(path.join(root, 'objects')),
      email: new NoopEmail(),
      signer: new HmacManifestSigner(config.SESSION_SECRET),
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    const issued = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: {
        name: 'Acme CRM',
        connectorKey: 'acme-crm',
        scopes: [
          'integration-sessions:create',
          'transactions:read',
          'transactions:write',
          'envelopes:read',
        ],
        businessDomains: ['REAL_ESTATE'],
        allowedReturnUrls: ['https://crm.example.test/esign/return'],
      },
    });
    expect(issued.statusCode).toBe(201);
    const client = issued.json().data;
    expect(client.client.connectorKey).toBe('acme-crm');

    const duplicateConnector = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: {
        name: 'Duplicate CRM connector',
        connectorKey: 'acme-crm',
        scopes: ['integration-sessions:create'],
        businessDomains: ['REAL_ESTATE'],
        allowedReturnUrls: ['https://other.example.test/esign/return'],
      },
    });
    expect(duplicateConnector.statusCode).toBe(409);
    expect(duplicateConnector.json().error.code).toBe('connector_key_conflict');

    const invalidReturn = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': client.credential },
      payload: {
        actor: {
          subject: 'acme:user-42',
          email: 'agent@example.test',
          displayName: 'Acme Agent',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl: 'https://attacker.example/collect',
      },
    });
    expect(invalidReturn.statusCode).toBe(422);
    expect(invalidReturn.json().error.code).toBe('return_url_not_allowed');

    const launch = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': client.credential },
      payload: {
        actor: {
          subject: 'acme:user-42',
          email: 'agent@example.test',
          displayName: 'Acme Agent',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl: 'https://crm.example.test/esign/return',
      },
    });
    expect(launch.statusCode).toBe(201);
    const launchUrl = new URL(launch.json().data.launchUrl);
    expect(launchUrl.pathname).toBe('/integration/launch');
    expect(launchUrl.search).toBe('');
    const ticket = new URLSearchParams(launchUrl.hash.slice(1)).get('ticket');
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/exchange',
      payload: { ticket },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['cache-control']).toBe('no-store');
    expect(exchange.json().data).toMatchObject({
      destination: '/',
      principal: {
        id: 'acme:user-42',
        actorType: 'integration',
        sourceApplicationName: 'Acme CRM',
      },
    });
    expect(exchange.cookies.find((cookie) => cookie.name === 'esign_staff')?.httpOnly).toBe(true);
    const cookie = cookies(exchange);
    const csrf = exchange.cookies.find((item) => item.name === 'esign_staff_csrf')?.value;
    expect(csrf).toBeTruthy();

    const replay = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/exchange',
      payload: { ticket },
    });
    expect(replay.statusCode).toBe(410);

    const me = await server.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.returnUrl).toBe('https://crm.example.test/esign/return');

    const noCsrf = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie },
      payload: { kind: 'PROPERTY', name: 'CRM-created transaction', jurisdiction: 'NY' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_invalid');

    const created = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie, 'x-csrf-token': csrf! },
      payload: { kind: 'PROPERTY', name: 'CRM-created transaction', jurisdiction: 'NY' },
    });
    expect(created.statusCode).toBe(201);

    const snapshot = repository.snapshot();
    expect(snapshot.integrationLaunchSessions).toHaveLength(1);
    expect(snapshot.staffSessions).toHaveLength(1);
    expect(
      snapshot.auditEvents.find((event) => event.type === 'integration_session.exchanged'),
    ).toMatchObject({
      actorType: 'integration',
      actorId: 'acme:user-42',
      sourceApplicationClientId: client.client.id,
    });
    expect(
      snapshot.auditEvents.find((event) => event.type === 'transaction.created'),
    ).toMatchObject({
      actorType: 'integration',
      actorId: 'acme:user-42',
      sourceApplicationClientId: client.client.id,
    });

    const logout = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/logout',
      headers: { cookie, 'x-csrf-token': csrf! },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json().data.returnUrl).toBe('https://crm.example.test/esign/return');
    expect(
      (await server.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('invalidates an unused launch when its application credential is revoked', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-portal-revoke-'));
    const repository = new InMemoryRepository(seedState());
    const server = await buildServer(config, {
      repository,
      objects: new LocalObjectStore(path.join(root, 'objects')),
      email: new NoopEmail(),
      signer: new HmacManifestSigner(config.SESSION_SECRET),
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    const issued = (
      await server.inject({
        method: 'POST',
        url: '/v1/application-clients',
        payload: {
          name: 'Revocable Portal',
          scopes: ['portal-sessions:create'],
          businessDomains: ['HR'],
          allowedReturnUrls: ['https://portal.homixliving.com/esign/return'],
        },
      })
    ).json().data;
    const administratorClaim = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions',
      headers: { 'x-esign-key': issued.credential },
      payload: {
        actor: {
          subject: 'homix:hr-7',
          email: 'hr@homixliving.com',
          displayName: 'Homix HR',
          role: 'platform_admin',
        },
        intent: { kind: 'dashboard' },
        returnUrl: 'https://portal.homixliving.com/esign/return',
      },
    });
    expect(administratorClaim.statusCode).toBe(422);

    const firstLaunch = (
      await server.inject({
        method: 'POST',
        url: '/v1/portal-sessions',
        headers: { 'x-esign-key': issued.credential },
        payload: {
          actor: {
            subject: 'homix:hr-7',
            email: 'hr@homixliving.com',
            displayName: 'Homix HR',
            role: 'preparer',
          },
          intent: { kind: 'dashboard' },
          returnUrl: 'https://portal.homixliving.com/esign/return',
        },
      })
    ).json().data;
    const firstTicket = new URLSearchParams(new URL(firstLaunch.launchUrl).hash.slice(1)).get(
      'ticket',
    );
    const firstExchange = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions/exchange',
      payload: { ticket: firstTicket },
    });
    const firstCookie = cookies(firstExchange);
    const firstCsrf = firstExchange.cookies.find((item) => item.name === 'esign_staff_csrf')?.value;
    const scopeDenied = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie: firstCookie, 'x-csrf-token': firstCsrf! },
      payload: { kind: 'HR_PACKET', name: 'Blocked transaction', jurisdiction: 'NONE' },
    });
    expect(scopeDenied.statusCode).toBe(403);
    expect(scopeDenied.json().error.message).toContain('Delegated access');

    const launch = (
      await server.inject({
        method: 'POST',
        url: '/v1/portal-sessions',
        headers: { 'x-esign-key': issued.credential },
        payload: {
          actor: {
            subject: 'homix:hr-7',
            email: 'hr@homixliving.com',
            displayName: 'Homix HR',
            role: 'preparer',
          },
          intent: { kind: 'dashboard' },
          returnUrl: 'https://portal.homixliving.com/esign/return',
        },
      })
    ).json().data;
    await server.inject({
      method: 'POST',
      url: `/v1/application-clients/${issued.client.id}/revoke`,
    });
    const ticket = new URLSearchParams(new URL(launch.launchUrl).hash.slice(1)).get('ticket');
    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions/exchange',
      payload: { ticket },
    });
    expect(exchange.statusCode).toBe(410);
    expect(
      (await server.inject({ method: 'GET', url: '/v1/me', headers: { cookie: firstCookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('strictly isolates HR and real-estate credentials before and after delegation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-domain-isolation-'));
    const fixtures = domainFixtureState();
    const repository = new InMemoryRepository(fixtures.state);
    const server = await buildServer(config, {
      repository,
      objects: new LocalObjectStore(path.join(root, 'objects')),
      email: new NoopEmail(),
      signer: new HmacManifestSigner(config.SESSION_SECRET),
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    const scopes = [
      'templates:read',
      'transactions:read',
      'transactions:write',
      'envelopes:read',
      'envelopes:write',
      'envelopes:send',
      'evidence:read',
      'integration-sessions:create',
    ];
    const returnUrl = 'https://agents.homixny.com/esign/return';
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/application-clients',
          payload: { name: 'Unassigned client', scopes },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/application-clients',
          payload: {
            name: 'Over-broad client',
            scopes,
            businessDomains: ['HR', 'REAL_ESTATE'],
          },
        })
      ).statusCode,
    ).toBe(422);
    const issueCredential = async (name: string, domain: BusinessDomain) => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/application-clients',
        payload: {
          name,
          connectorKey: `homix-${domain.toLowerCase().replace('_', '-')}`,
          scopes,
          businessDomains: [domain],
          allowedReturnUrls: [returnUrl],
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.client.businessDomains).toEqual([domain]);
      return response.json().data as {
        credential: string;
        client: { id: string; businessDomains: BusinessDomain[] };
      };
    };
    const hr = await issueCredential('Homix HR', 'HR');
    const realEstate = await issueCredential('Homix Real Estate', 'REAL_ESTATE');

    const listIds = async (url: string, credential: string) => {
      const response = await server.inject({
        method: 'GET',
        url,
        headers: { 'x-esign-key': credential },
      });
      expect(response.statusCode).toBe(200);
      return response.json().data.map((item: { id: string }) => item.id) as string[];
    };
    expect(await listIds('/v1/templates', hr.credential)).toEqual([fixtures.hrTemplate.id]);
    expect(await listIds('/v1/templates', realEstate.credential)).toEqual([
      fixtures.realEstateTemplate.id,
    ]);
    expect(await listIds('/v1/transactions', hr.credential)).toHaveLength(1);
    expect(await listIds('/v1/transactions', realEstate.credential)).toHaveLength(1);
    expect(await listIds('/v1/envelopes', hr.credential)).toEqual([fixtures.hrEnvelope.id]);
    expect(await listIds('/v1/envelopes', realEstate.credential)).toEqual([
      fixtures.realEstateEnvelope.id,
    ]);

    for (const [credential, foreignTemplateId, foreignEnvelopeId] of [
      [hr.credential, fixtures.realEstateTemplate.id, fixtures.realEstateEnvelope.id],
      [realEstate.credential, fixtures.hrTemplate.id, fixtures.hrEnvelope.id],
    ]) {
      expect(
        (
          await server.inject({
            method: 'GET',
            url: `/v1/templates/${foreignTemplateId}`,
            headers: { 'x-esign-key': credential },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `/v1/envelopes/${foreignEnvelopeId}/send`,
            headers: { 'x-esign-key': credential, 'idempotency-key': crypto.randomUUID() },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `/v1/envelopes/${foreignEnvelopeId}/void`,
            headers: { 'x-esign-key': credential },
            payload: { reason: 'Cross-domain request must remain hidden.' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: `/v1/envelopes/${foreignEnvelopeId}/recipients/${crypto.randomUUID()}/resend`,
            headers: { 'x-esign-key': credential },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: `/v1/envelopes/${foreignEnvelopeId}/evidence`,
            headers: { 'x-esign-key': credential },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: `/v1/envelopes/${foreignEnvelopeId}`,
            headers: { 'x-esign-key': credential },
          })
        ).statusCode,
      ).toBe(404);
    }

    const hrCrossCreate = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { 'x-esign-key': hr.credential },
      payload: { kind: 'PROPERTY', name: 'Blocked listing', jurisdiction: 'NY' },
    });
    expect(hrCrossCreate.statusCode).toBe(403);
    expect(hrCrossCreate.json().error.code).toBe('business_domain_forbidden');
    const realEstateCrossCreate = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { 'x-esign-key': realEstate.credential },
      payload: { kind: 'HR_PACKET', name: 'Blocked onboarding', jurisdiction: 'NONE' },
    });
    expect(realEstateCrossCreate.statusCode).toBe(403);
    expect(realEstateCrossCreate.json().error.code).toBe('business_domain_forbidden');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: { 'x-esign-key': hr.credential },
          payload: { kind: 'HR_PACKET', name: 'Allowed onboarding', jurisdiction: 'NONE' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: { 'x-esign-key': realEstate.credential },
          payload: { kind: 'PROPERTY', name: 'Allowed listing', jurisdiction: 'NY' },
        })
      ).statusCode,
    ).toBe(201);

    const forbiddenIntent = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': hr.credential },
      payload: {
        actor: {
          subject: 'homix:hr-operator',
          email: 'hr@homixny.com',
          displayName: 'Homix HR',
          role: 'preparer',
        },
        intent: { kind: 'view-envelope', envelopeId: fixtures.realEstateEnvelope.id },
        returnUrl,
      },
    });
    expect(forbiddenIntent.statusCode).toBe(404);

    const launch = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': hr.credential },
      payload: {
        actor: {
          subject: 'homix:hr-operator',
          email: 'hr@homixny.com',
          displayName: 'Homix HR',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl,
      },
    });
    expect(launch.statusCode).toBe(201);
    const ticket = new URLSearchParams(new URL(launch.json().data.launchUrl).hash.slice(1)).get(
      'ticket',
    );
    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/exchange',
      payload: { ticket },
    });
    expect(exchange.statusCode).toBe(200);
    const cookie = cookies(exchange);
    const csrf = exchange.cookies.find((item) => item.name === 'esign_staff_csrf')?.value;
    expect(
      (await server.inject({ method: 'GET', url: '/v1/templates', headers: { cookie } }))
        .json()
        .data.map((item: { id: string }) => item.id),
    ).toEqual([fixtures.hrTemplate.id]);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: `/v1/envelopes/${fixtures.realEstateEnvelope.id}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    const delegatedDashboard = await server.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { cookie },
    });
    expect(delegatedDashboard.statusCode).toBe(200);
    expect(delegatedDashboard.json().data.counts).toMatchObject({
      templates: 1,
      drafts: 1,
    });
    expect(delegatedDashboard.json().data.workspace.members).toBeUndefined();
    expect(
      delegatedDashboard
        .json()
        .data.recentEnvelopes.map(
          (item: { businessDomain: BusinessDomain }) => item.businessDomain,
        ),
    ).toEqual(['HR']);
    expect(delegatedDashboard.json().data.recentAudit).toEqual([]);
    const delegatedCrossCreate = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie, 'x-csrf-token': csrf! },
      payload: { kind: 'PROPERTY', name: 'Delegated blocked listing', jurisdiction: 'NY' },
    });
    expect(delegatedCrossCreate.statusCode).toBe(403);
    expect(delegatedCrossCreate.json().error.code).toBe('business_domain_forbidden');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/transactions',
          headers: { cookie, 'x-csrf-token': csrf! },
          payload: {
            kind: 'HR_PACKET',
            name: 'Delegated allowed onboarding',
            jurisdiction: 'NONE',
          },
        })
      ).statusCode,
    ).toBe(201);
  });

  it('does not expose template or audit dashboard data without delegated scopes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-dashboard-scopes-'));
    const fixtures = domainFixtureState();
    const repository = new InMemoryRepository(fixtures.state);
    const server = await buildServer(config, {
      repository,
      objects: new LocalObjectStore(path.join(root, 'objects')),
      email: new NoopEmail(),
      signer: new HmacManifestSigner(config.SESSION_SECRET),
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    const returnUrl = 'https://agents.homixny.com/esign/return';
    const envelopeOnly = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: {
        name: 'Envelope-only dashboard',
        scopes: ['integration-sessions:create', 'envelopes:read'],
        businessDomains: ['HR'],
        allowedReturnUrls: [returnUrl],
      },
    });
    expect(envelopeOnly.statusCode).toBe(201);
    const launch = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': envelopeOnly.json().data.credential },
      payload: {
        actor: {
          subject: 'homix:dashboard-envelope-only',
          email: 'agent@homixny.com',
          displayName: 'Envelope-only Agent',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl,
      },
    });
    expect(launch.statusCode).toBe(201);
    const ticket = new URLSearchParams(new URL(launch.json().data.launchUrl).hash.slice(1)).get(
      'ticket',
    );
    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/exchange',
      payload: { ticket },
    });
    expect(exchange.statusCode).toBe(200);
    const dashboard = await server.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { cookie: cookies(exchange) },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data.counts.templates).toBe(0);
    expect(dashboard.json().data.recentAudit).toEqual([]);

    const templatesOnly = await server.inject({
      method: 'POST',
      url: '/v1/application-clients',
      payload: {
        name: 'Templates-only dashboard',
        scopes: ['integration-sessions:create', 'templates:read'],
        businessDomains: ['HR'],
        allowedReturnUrls: [returnUrl],
      },
    });
    expect(templatesOnly.statusCode).toBe(201);
    const forbiddenLaunch = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions',
      headers: { 'x-esign-key': templatesOnly.json().data.credential },
      payload: {
        actor: {
          subject: 'homix:dashboard-templates-only',
          email: 'hr@homixny.com',
          displayName: 'Templates-only HR',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl,
      },
    });
    expect(forbiddenLaunch.statusCode).toBe(201);
    const forbiddenTicket = new URLSearchParams(
      new URL(forbiddenLaunch.json().data.launchUrl).hash.slice(1),
    ).get('ticket');
    const forbiddenExchange = await server.inject({
      method: 'POST',
      url: '/v1/integration-sessions/exchange',
      payload: { ticket: forbiddenTicket },
    });
    expect(forbiddenExchange.statusCode).toBe(200);
    const forbiddenDashboard = await server.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { cookie: cookies(forbiddenExchange) },
    });
    expect(forbiddenDashboard.statusCode).toBe(403);
    expect(forbiddenDashboard.json().error.code).toBe('forbidden');

    const directDashboard = await server.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(directDashboard.statusCode).toBe(200);
    expect(directDashboard.json().data.counts.templates).toBe(2);
    expect(directDashboard.json().data.recentAudit.length).toBeGreaterThan(0);
  });

  it('fails closed for legacy application clients with missing or empty business domains', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-legacy-domain-'));
    const fixtures = domainFixtureState();
    const missingSecret = 'missing-domain-secret-at-least-thirty-two-characters';
    const emptySecret = 'empty-domain-secret-at-least-thirty-two-characters';
    const legacyClient = (name: string, secret: string): ApplicationClient => ({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      name,
      secretHash: sha256(secret),
      scopes: ['templates:read', 'transactions:write'],
      businessDomains: [],
      allowedReturnUrls: [],
      status: 'ACTIVE',
      createdAt: FIXTURE_TIME,
    });
    const missing = legacyClient('Missing legacy domain', missingSecret);
    delete (missing as Partial<ApplicationClient>).businessDomains;
    const empty = legacyClient('Empty legacy domain', emptySecret);
    fixtures.state.applicationClients.push(missing, empty);
    const repository = new InMemoryRepository(fixtures.state);
    const server = await buildServer(config, {
      repository,
      objects: new LocalObjectStore(path.join(root, 'objects')),
      email: new NoopEmail(),
      signer: new HmacManifestSigner(config.SESSION_SECRET),
      scanner: new LocalFileScanner(),
    });
    servers.push(server);

    for (const [client, secret] of [
      [missing, missingSecret],
      [empty, emptySecret],
    ] as const) {
      const credential = `${client.id}.${secret}`;
      const templates = await server.inject({
        method: 'GET',
        url: '/v1/templates',
        headers: { 'x-esign-key': credential },
      });
      expect(templates.statusCode).toBe(401);
      expect(templates.json().error.code).toBe('unauthorized');
      expect(
        (
          await server.inject({
            method: 'GET',
            url: `/v1/templates/${fixtures.hrTemplate.id}`,
            headers: { 'x-esign-key': credential },
          })
        ).statusCode,
      ).toBe(401);
      const create = await server.inject({
        method: 'POST',
        url: '/v1/transactions',
        headers: { 'x-esign-key': credential },
        payload: { kind: 'HR_PACKET', name: 'Blocked legacy create', jurisdiction: 'NONE' },
      });
      expect(create.statusCode).toBe(401);
      expect(create.json().error.code).toBe('unauthorized');
    }
  });
});
