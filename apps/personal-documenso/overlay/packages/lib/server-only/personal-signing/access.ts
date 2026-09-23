// This module is installed ONLY in the personal Documenso image, never the company engine.
export const PERSONAL_ORIGIN = 'https://documenso.kevv.ai';
export const AUTHORIZATION_URL = 'https://agents.homixny.com/api/personal-signing/authorize';

export class PersonalAccessError extends Error {
  constructor(public readonly status: 403 | 503) {
    super(status === 403 ? 'PERSONAL_SIGNING_ACCESS_DENIED' : 'PERSONAL_SIGNING_UNAVAILABLE');
  }
}

export type PortalGrant = { agentId: number; email: string; name: string; grantId: string };
export type GoogleIdentity = { googleSubject: string; email: string };

export function assertPersonalHost(env = process.env) {
  // A wrong deployment must fail closed, especially on esign.kevv.ai.
  if (env.NEXT_PUBLIC_WEBAPP_URL !== PERSONAL_ORIGIN || env.NODE_ENV !== 'production') {
    throw new PersonalAccessError(503);
  }
}

export async function fetchPortalGrant(
  identity: GoogleIdentity,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): Promise<PortalGrant> {
  const env = options.env || process.env;
  assertPersonalHost(env);
  const token = env.PERSONAL_SIGNING_SERVICE_TOKEN?.trim();
  if (!token || token.length < 32) throw new PersonalAccessError(503);
  let response: Response;
  try {
    response = await (options.fetch || fetch)(AUTHORIZATION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        googleSubject: identity.googleSubject,
        email: identity.email.toLowerCase(),
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new PersonalAccessError(503);
  }
  if (response.status === 403) throw new PersonalAccessError(403);
  if (!response.ok) throw new PersonalAccessError(503);
  let grant: Partial<PortalGrant> | null;
  try {
    grant = await response.json();
  } catch {
    throw new PersonalAccessError(503);
  }
  if (
    !grant ||
    !Number.isSafeInteger(grant.agentId) ||
    grant.agentId! <= 0 ||
    typeof grant.email !== 'string' ||
    grant.email !== identity.email.toLowerCase() ||
    typeof grant.name !== 'string' ||
    grant.name.length > 500 ||
    typeof grant.grantId !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(grant.grantId)
  ) {
    throw new PersonalAccessError(503);
  }
  return grant as PortalGrant;
}
