import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_URL,
  assertPersonalHost,
  fetchPortalGrant,
} from '../overlay/packages/lib/server-only/personal-signing/access';

const env = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_WEBAPP_URL: 'https://documenso.kevv.ai',
  PERSONAL_SIGNING_SERVICE_TOKEN: 'test-only-service-token-with-enough-length',
};
const identity = { googleSubject: 'google-sub-1', email: 'Agent@example.test' };
const grant = {
  agentId: 12,
  email: 'agent@example.test',
  name: 'Agent',
  grantId: '057cafc5-6401-45a2-acdb-3ee92f9c14b3',
};

describe('personal native access', () => {
  it('refuses the company signing origin and insecure runtime', () => {
    expect(() =>
      assertPersonalHost({ ...env, NEXT_PUBLIC_WEBAPP_URL: 'https://esign.kevv.ai' }),
    ).toThrow();
    expect(() => assertPersonalHost({ ...env, NODE_ENV: 'development' })).toThrow();
  });
  it('uses only the fixed backend endpoint with an isolated bearer and no redirect following', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(grant));
    expect(await fetchPortalGrant(identity, { env, fetch: fetcher })).toEqual(grant);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(AUTHORIZATION_URL);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({
      googleSubject: 'google-sub-1',
      email: 'agent@example.test',
    });
    expect(init?.body).not.toContain(env.PERSONAL_SIGNING_SERVICE_TOKEN);
  });
  it('does not cache authorization grants', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(grant))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await fetchPortalGrant(identity, { env, fetch: fetcher });
    await expect(fetchPortalGrant(identity, { env, fetch: fetcher })).rejects.toMatchObject({
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 429, 500, 503])(
    'fails closed without misclassifying HTTP %s as revocation',
    async (status) => {
      await expect(
        fetchPortalGrant(identity, {
          env,
          fetch: vi.fn().mockResolvedValue(new Response(null, { status })),
        }),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
  it('fails closed on timeouts, missing credentials and malformed JSON', async () => {
    await expect(
      fetchPortalGrant(identity, {
        env,
        fetch: vi.fn().mockRejectedValue(new Error('secret-bearing error')),
      }),
    ).rejects.toMatchObject({ status: 503, message: 'PERSONAL_SIGNING_UNAVAILABLE' });
    const fetcher = vi.fn();
    await expect(
      fetchPortalGrant(identity, {
        env: { ...env, PERSONAL_SIGNING_SERVICE_TOKEN: '' },
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      fetchPortalGrant(identity, { env, fetch: vi.fn().mockResolvedValue(new Response('broken')) }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    { ...grant, email: 'someone-else@example.test' },
    { ...grant, agentId: -1 },
    { ...grant, grantId: '' },
    null,
  ])('rejects a mismatched or malformed grant', async (value) => {
    await expect(
      fetchPortalGrant(identity, { env, fetch: vi.fn().mockResolvedValue(Response.json(value)) }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
