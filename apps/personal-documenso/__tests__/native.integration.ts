// Run against an EMPTY disposable database with the patched upstream schema.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.PERSONAL_DOCUMENSO_SOURCE;
const url = new URL(process.env.NEXT_PRIVATE_DATABASE_URL || '');
if (
  !source ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/personal_signing_test'
) {
  throw new Error(
    'Refusing to run destructive fixtures outside the dedicated local personal_signing_test database',
  );
}
process.env.NODE_ENV = 'production';
process.env.NEXT_PUBLIC_WEBAPP_URL = 'https://documenso.kevv.ai';
process.env.PERSONAL_SIGNING_SERVICE_TOKEN = 'local-test-service-credential-not-for-deployment';
process.env.NEXT_PUBLIC_FEATURE_BILLING_ENABLED = 'false';
const load = async (file: string) => {
  const imported = await import(pathToFileURL(resolve(source, file)).href);
  return imported.default || imported;
};
const { prisma } = await load('packages/prisma/index.ts');
const { provisionPersonalGoogleUser, assertPersonalUserAccess, assertPersonalLoginMethod } =
  await load('packages/lib/server-only/personal-signing/users.ts');
const { createSession, validateSessionToken } = await load(
  'packages/auth/server/lib/session/session.ts',
);
const { sessionCookieOptions } = await load('packages/auth/server/lib/session/session-cookies.ts');
const { getApiTokenByToken } = await load(
  'packages/lib/server-only/public-api/get-api-token-by-token.ts',
);
const { hashString } = await load('packages/lib/server-only/auth/hash.ts');
const grants = new Map([
  [
    'google-a',
    {
      agentId: 910001,
      email: 'a@personal.example.test',
      name: 'Test A',
      grantId: '93a9e522-8f64-4e30-a67e-8d0154a2ea11',
    },
  ],
  [
    'google-b',
    {
      agentId: 910002,
      email: 'b@personal.example.test',
      name: 'Test B',
      grantId: 'a239556e-02db-4fb5-b164-5c623418d525',
    },
  ],
]);
const originalFetch = globalThis.fetch;
let unavailable = false;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'https://agents.homixny.com/api/personal-signing/authorize');
  if (unavailable) return new Response(null, { status: 503 });
  const { googleSubject, email } = JSON.parse(String(init?.body));
  const grant = grants.get(googleSubject);
  return grant && grant.email === email
    ? Response.json(grant)
    : new Response(null, { status: 403 });
};
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}
const identity = (googleSubject: string) => ({
  googleSubject,
  email: grants.get(googleSubject)!.email,
});
try {
  assert.equal(
    await prisma.user.count(),
    0,
    'Test DB must be empty; never clear a used database automatically',
  );
  await check('unapproved Google identity cannot create any user', async () => {
    await assert.rejects(
      provisionPersonalGoogleUser({ googleSubject: 'outsider', email: 'outsider@example.test' }),
    );
    assert.equal(await prisma.user.count(), 0);
  });
  const legacy = await prisma.user.create({
    data: {
      email: 'owner@example.test',
      name: 'Existing owner',
      emailVerified: new Date(),
      password: 'fixture-only-not-a-real-hash',
    },
  });
  await check('legacy account has no bypass and is never adopted by email alone', async () => {
    unavailable = true;
    await assert.rejects(assertPersonalUserAccess(legacy.id));
    unavailable = false;
    grants.set('owner-google', {
      agentId: 910003,
      email: legacy.email,
      name: 'Owner',
      grantId: '04ef33d5-ae53-41ef-ae81-f59c81dc7f70',
    });
    await assert.rejects(provisionPersonalGoogleUser(identity('owner-google')));
    assert.equal(await prisma.portalSigningIdentity.count({ where: { userId: legacy.id } }), 0);
    assert.equal(
      (await prisma.user.findUnique({ where: { id: legacy.id } })).password,
      'fixture-only-not-a-real-hash',
    );
  });
  let a: { userId: number; redirectPath: string };
  let b: { userId: number; redirectPath: string };
  await check('parallel first login creates exactly one account and workspace', async () => {
    const users = await Promise.all([
      provisionPersonalGoogleUser(identity('google-a')),
      provisionPersonalGoogleUser(identity('google-a')),
    ]);
    a = users[0];
    assert.equal(users[0].userId, users[1].userId);
    assert.equal(await prisma.user.count({ where: { email: identity('google-a').email } }), 1);
    assert.equal(await prisma.organisation.count({ where: { ownerUserId: a.userId } }), 1);
    const native = await prisma.user.findUnique({ where: { id: a.userId } });
    assert.equal(native.password, null);
    assert.deepEqual(native.roles, ['USER']);
  });
  await check('two Portal agents own separate teams with private defaults', async () => {
    b = await provisionPersonalGoogleUser(identity('google-b'));
    assert.notEqual(a.userId, b.userId);
    assert.notEqual(a.redirectPath, b.redirectPath);
    const organisations = await prisma.organisation.findMany({
      where: { ownerUserId: { in: [a.userId, b.userId] } },
      include: { members: true, teams: { include: { teamGlobalSettings: true } } },
    });
    for (const org of organisations) {
      assert.equal(org.members.length, 1);
      assert.equal(org.members[0].userId, org.ownerUserId);
      assert.equal(org.teams.length, 1);
      assert.equal(org.teams[0].teamGlobalSettings.documentVisibility, 'ADMIN');
      assert.equal(org.teams[0].teamGlobalSettings.delegateDocumentOwnership, true);
    }
  });
  await check(
    'all accounts require Google; password/passkey cannot bypass authorization',
    async () => {
      await assert.rejects(assertPersonalLoginMethod(legacy.id));
      await assert.rejects(assertPersonalLoginMethod(a.userId));
      await assertPersonalLoginMethod(a.userId, true);
    },
  );
  await check('native API tokens cannot bypass Portal revocation or an outage', async () => {
    const team = await prisma.team.findUnique({ where: { url: 'homix-personal-910001' } });
    const token = 'fixture-api-token-never-used-outside-local-test';
    await prisma.apiToken.create({
      data: { name: 'Fixture token', token: hashString(token), teamId: team.id, userId: a.userId },
    });
    assert.equal((await getApiTokenByToken({ token })).user.id, a.userId);
    unavailable = true;
    await assert.rejects(getApiTokenByToken({ token }));
    unavailable = false;
    const saved = grants.get('google-a')!;
    grants.delete('google-a');
    await assert.rejects(getApiTokenByToken({ token }));
    grants.set('google-a', saved);
  });
  await check(
    'existing session authorization fails closed on Portal outage, without deleting sessions',
    async () => {
      await createSession('fixture-session-a', a.userId, {
        ipAddress: '127.0.0.1',
        userAgent: 'integration-test',
      });
      unavailable = true;
      await assert.rejects(validateSessionToken('fixture-session-a'));
      assert.equal(await prisma.session.count({ where: { userId: a.userId } }), 1);
      unavailable = false;
      assert.equal((await validateSessionToken('fixture-session-a')).isAuthenticated, true);
    },
  );
  await check('revocation kills old sessions, independent of the Portal navigation', async () => {
    const saved = grants.get('google-a')!;
    grants.delete('google-a');
    assert.equal((await validateSessionToken('fixture-session-a')).isAuthenticated, false);
    assert.equal(await prisma.session.count({ where: { userId: a.userId } }), 0);
    await assert.rejects(createSession('fixture-denied', a.userId, {}));
    grants.set('google-a', saved);
    assert.equal((await validateSessionToken('fixture-session-a')).isAuthenticated, false);
  });
  await check(
    'new grant version requires fresh Google login and preserves the user ID',
    async () => {
      await createSession('fixture-session-b', b.userId, {});
      grants.set('google-b', {
        ...grants.get('google-b')!,
        email: 'b-updated@personal.example.test',
        grantId: '287c74d0-b63a-45d5-b8de-dbb4596a60c5',
      });
      assert.equal((await validateSessionToken('fixture-session-b')).isAuthenticated, false);
      assert.equal((await provisionPersonalGoogleUser(identity('google-b'))).userId, b.userId);
      assert.equal(
        (await prisma.user.findUnique({ where: { id: b.userId } })).email,
        'b-updated@personal.example.test',
      );
    },
  );
  await check('an extra organisation membership does not grant cross-agent access', async () => {
    const bOrg = await prisma.organisation.findUnique({ where: { url: 'homix-personal-910002' } });
    await prisma.organisationMember.create({
      data: { id: 'fixture-cross-membership', organisationId: bOrg.id, userId: a.userId },
    });
    await assert.rejects(assertPersonalUserAccess(a.userId));
    await assert.rejects(assertPersonalUserAccess(b.userId));
    await prisma.organisationMember.delete({ where: { id: 'fixture-cross-membership' } });
  });
  await check(
    'a promoted managed user is denied, not granted site administrator access',
    async () => {
      await prisma.user.update({ where: { id: a.userId }, data: { roles: ['ADMIN'] } });
      await assert.rejects(assertPersonalUserAccess(a.userId));
      await prisma.user.update({ where: { id: a.userId }, data: { roles: ['USER'] } });
    },
  );
  await check('cookie expiry is computed when written, not once at module startup', async () => {
    assert.equal(
      typeof Object.getOwnPropertyDescriptor(sessionCookieOptions, 'expires')?.get,
      'function',
    );
    assert.ok(sessionCookieOptions.expires.getTime() > Date.now());
    assert.equal(sessionCookieOptions.secure, true);
  });
  process.stdout.write(`${passed} native integration checks passed\n`);
} finally {
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
}
