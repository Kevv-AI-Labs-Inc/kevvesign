import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailMessage, EmailPort } from '@esign/domain';
import { InMemoryRepository, seedState } from '@esign/domain';
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

function cookies(response: { cookies: Array<{ name: string; value: string }> }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

describe('Portal delegated staff access', () => {
  const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('uses an exact return URL, a one-time fragment ticket, scoped CSRF, and dual attribution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-portal-'));
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
        name: 'Homix Portal',
        scopes: [
          'portal-sessions:create',
          'transactions:read',
          'transactions:write',
          'envelopes:read',
        ],
        allowedReturnUrls: ['https://portal.homixliving.com/esign/return'],
      },
    });
    expect(issued.statusCode).toBe(201);
    const client = issued.json().data;

    const invalidReturn = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions',
      headers: { 'x-esign-key': client.credential },
      payload: {
        actor: {
          subject: 'homix:user-42',
          email: 'agent@homixliving.com',
          displayName: 'Homix Agent',
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
      url: '/v1/portal-sessions',
      headers: { 'x-esign-key': client.credential },
      payload: {
        actor: {
          subject: 'homix:user-42',
          email: 'agent@homixliving.com',
          displayName: 'Homix Agent',
          role: 'preparer',
        },
        intent: { kind: 'dashboard' },
        returnUrl: 'https://portal.homixliving.com/esign/return',
      },
    });
    expect(launch.statusCode).toBe(201);
    const launchUrl = new URL(launch.json().data.launchUrl);
    expect(launchUrl.pathname).toBe('/portal/launch');
    expect(launchUrl.search).toBe('');
    const ticket = new URLSearchParams(launchUrl.hash.slice(1)).get('ticket');
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const exchange = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions/exchange',
      payload: { ticket },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['cache-control']).toBe('no-store');
    expect(exchange.json().data).toMatchObject({
      destination: '/',
      principal: {
        id: 'homix:user-42',
        actorType: 'portal',
        sourceApplicationName: 'Homix Portal',
      },
    });
    expect(exchange.cookies.find((cookie) => cookie.name === 'esign_staff')?.httpOnly).toBe(true);
    const cookie = cookies(exchange);
    const csrf = exchange.cookies.find((item) => item.name === 'esign_staff_csrf')?.value;
    expect(csrf).toBeTruthy();

    const replay = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions/exchange',
      payload: { ticket },
    });
    expect(replay.statusCode).toBe(410);

    const me = await server.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.returnUrl).toBe('https://portal.homixliving.com/esign/return');

    const noCsrf = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie },
      payload: { kind: 'PROPERTY', name: 'Portal-created transaction', jurisdiction: 'NY' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_invalid');

    const created = await server.inject({
      method: 'POST',
      url: '/v1/transactions',
      headers: { cookie, 'x-csrf-token': csrf! },
      payload: { kind: 'PROPERTY', name: 'Portal-created transaction', jurisdiction: 'NY' },
    });
    expect(created.statusCode).toBe(201);

    const snapshot = repository.snapshot();
    expect(snapshot.portalLaunchSessions).toHaveLength(1);
    expect(snapshot.staffSessions).toHaveLength(1);
    expect(
      snapshot.auditEvents.find((event) => event.type === 'portal_session.exchanged'),
    ).toMatchObject({
      actorType: 'portal',
      actorId: 'homix:user-42',
      sourceApplicationClientId: client.client.id,
    });
    expect(
      snapshot.auditEvents.find((event) => event.type === 'transaction.created'),
    ).toMatchObject({
      actorType: 'portal',
      actorId: 'homix:user-42',
      sourceApplicationClientId: client.client.id,
    });

    const logout = await server.inject({
      method: 'POST',
      url: '/v1/portal-sessions/logout',
      headers: { cookie, 'x-csrf-token': csrf! },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json().data.returnUrl).toBe('https://portal.homixliving.com/esign/return');
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
});
