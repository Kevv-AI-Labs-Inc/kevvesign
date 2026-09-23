// Apply a small, version-locked overlay to an official source checkout.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_COMMIT = '191170923a459afa003c846bd8501190a14f52d5';
const root = resolve(process.argv[2] || '');
if (
  !process.argv[2] ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !==
    UPSTREAM_COMMIT
) {
  throw new Error('Expected the pinned official Documenso 2.11.0 source checkout');
}
const changes = new Map();
function replace(file, before, after) {
  const source = changes.get(file) ?? readFileSync(resolve(root, file), 'utf8');
  if (source.split(before).length !== 2)
    throw new Error(`Source drift or already patched: ${file}`);
  changes.set(file, source.replace(before, after));
}

const callback = 'packages/auth/server/lib/utils/handle-oauth-callback-url.ts';
const originalCallback = readFileSync(resolve(root, callback), 'utf8');
const validation = originalCallback.slice(originalCallback.indexOf('export const validateOauth ='));
if (!validation.startsWith('export const validateOauth ='))
  throw new Error('Missing upstream OAuth validator');
changes.set(
  callback,
  `import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { provisionPersonalGoogleUser } from '@documenso/lib/server-only/personal-signing/users';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { decodeIdToken, OAuth2Client } from 'arctic';
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { OAuthClientOptions } from '../../config';
import { AuthenticationErrorCode } from '../errors/error-codes';
import { onAuthorize } from './authorizer';
import { getOpenIdConfiguration } from './open-id';

type HandleOAuthCallbackUrlOptions = { c: Context; clientOptions: OAuthClientOptions };
export const handleOAuthCallbackUrl = async (options: HandleOAuthCallbackUrlOptions) => {
  if (options.clientOptions.id !== 'google' || options.clientOptions.bypassEmailVerification) {
    return options.c.text('FORBIDDEN', 403);
  }
  const identity = await validateOauth(options);
  try {
    const user = await provisionPersonalGoogleUser({ googleSubject: identity.sub, email: identity.email });
    await onAuthorize({ userId: user.userId, personalGoogleVerified: true }, options.c);
    return options.c.redirect(user.redirectPath, 302);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403) {
      return options.c.text('Access denied. Open self-service signing in Homix Portal first, then use the same Google account. Contact your administrator if access is still denied.', 403);
    }
    // Do not log OAuth codes/tokens, response bodies, or credential-bearing URLs.
    return options.c.text('Signing is temporarily unavailable. Please try again later.', 503);
  }
};

${validation}`,
);
replace(
  callback,
  '  const email = claims.email;',
  `  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss)) ||
      claims.aud !== clientOptions.clientId || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new AppError(AuthenticationErrorCode.InvalidRequest, { message: 'Invalid Google identity' });
  }
  const email = claims.email;`,
);

const authorizer = 'packages/auth/server/lib/utils/authorizer.ts';
replace(
  authorizer,
  "import type { Context } from 'hono';",
  "import { assertPersonalLoginMethod } from '@documenso/lib/server-only/personal-signing/users';\nimport type { Context } from 'hono';",
);
replace(authorizer, '  userId: number;', '  userId: number;\n  personalGoogleVerified?: boolean;');
replace(
  authorizer,
  "  const metadata = c.get('requestMetadata');",
  "  await assertPersonalLoginMethod(user.userId, user.personalGoogleVerified === true);\n  const metadata = c.get('requestMetadata');",
);

const session = 'packages/auth/server/lib/session/session.ts';
replace(
  session,
  'import { AppError, AppErrorCode }',
  "import { assertPersonalUserAccess } from '@documenso/lib/server-only/personal-signing/users';\nimport { AppError, AppErrorCode }",
);
replace(
  session,
  '  const hashedSessionId =',
  '  await assertPersonalUserAccess(userId);\n  const hashedSessionId =',
);
replace(
  session,
  '  const { user, ...session } = result;',
  `  const { user, ...session } = result;
  try {
    await assertPersonalUserAccess(user.id);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 403) {
      return { session: null, user: null, isAuthenticated: false };
    }
    throw error;
  }`,
);

const api = 'packages/lib/server-only/public-api/get-api-token-by-token.ts';
replace(
  api,
  'import { prisma }',
  "import { assertPersonalUserAccess } from '../personal-signing/users';\nimport { prisma }",
);
replace(
  api,
  '  return {\n    ...apiToken,',
  '  await assertPersonalUserAccess(user.id);\n\n  return {\n    ...apiToken,',
);

const cookies = 'packages/auth/server/lib/session/session-cookies.ts';
replace(
  cookies,
  '  expires: new Date(Date.now() + AUTH_SESSION_LIFETIME),',
  `  // Compute per write; module-load expiry breaks login after long container uptime.
  get expires() { return new Date(Date.now() + AUTH_SESSION_LIFETIME); },`,
);
replace(cookies, "  sameSite: useSecureCookies ? 'none' : 'lax',", "  sameSite: 'lax',");

const oauth = 'packages/auth/server/lib/utils/handle-oauth-authorize-url.ts';
replace(
  oauth,
  "  let prompt = options.prompt ?? 'login';",
  "  let prompt = options.prompt ?? (clientOptions.id === 'google' ? 'select_account' : 'login');",
);
const org = 'packages/auth/server/lib/utils/handle-oauth-organisation-callback-url.ts';
// Organisation SSO is not an alternate signup path in this personal instance.
const orgSource = readFileSync(resolve(root, org), 'utf8');
if (!orgSource.includes('export const handleOAuthOrganisationCallbackUrl ='))
  throw new Error('Missing organisation callback');
changes.set(
  org,
  `import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { Context } from 'hono';
export const handleOAuthOrganisationCallbackUrl = async (_options: { c: Context; orgUrl: string }) => {
  throw new AppError(AppErrorCode.FORBIDDEN, { message: 'Use Google through Homix Portal', statusCode: 403 });
};
`,
);

const schema = 'packages/prisma/schema.prisma';
replace(
  schema,
  '  accounts            Account[]',
  '  portalSigningIdentity PortalSigningIdentity?\n  accounts            Account[]',
);
changes.set(
  schema,
  changes.get(schema) +
    `
model PortalSigningIdentity {
  portalAgentId Int @id
  userId Int @unique
  googleSubject String @unique
  email String
  grantId String @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
`,
);

const docker = 'docker/Dockerfile';
replace(
  docker,
  'FROM node:22-alpine3.22 AS base',
  'FROM node:22-alpine3.22 AS base\nRUN npm install --global npm@11.11.0',
);
replace(docker, 'FROM base AS runner', 'FROM base AS runner\nENV NODE_ENV=production');
replace(
  'docker/start.sh',
  '#!/bin/sh',
  '#!/bin/sh\nset -eu\n# Refuse to serve the personal app if its additive identity migration fails.',
);
const signin = 'apps/remix/app/routes/_unauthenticated+/signin.tsx';
replace(
  signin,
  "import { SignInForm } from '~/components/forms/signin';",
  "import { PersonalGoogleSignIn } from '~/components/forms/personal-google-signin';",
);
replace(signin, '        <SignInForm', '        <PersonalGoogleSignIn');
replace(
  signin,
  '        <hr className="-mx-6 my-4" />',
  `        <p className="mt-2 text-sm">
          Homix agents: open Self-service signing in Portal first, then use the same Google account.
          Access is limited to active, authorized Homix Portal users.
          {' '}<a className="underline" href="/personal-signing-source.tar.gz">Source code (AGPL)</a>
        </p>
        <hr className="-mx-6 my-4" />`,
);
// Validate every source anchor before making any writes. This script is only run
// in a disposable, pinned build checkout, never on a live container/filesystem.
for (const [file, contents] of changes) writeFileSync(resolve(root, file), contents);
cpSync(resolve(dirname(fileURLToPath(import.meta.url)), 'overlay'), root, { recursive: true });
process.stdout.write(`Prepared personal signing overlay for ${UPSTREAM_COMMIT}\n`);
