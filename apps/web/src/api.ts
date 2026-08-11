import type { ApiFailure, ApiSuccess } from '@esign/contracts';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Array<{ field: string; message: string; code: string }> = [],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body === undefined || init.body instanceof FormData
        ? {}
        : { 'content-type': 'application/json' }),
      ...csrfHeader(),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiFailure | undefined;
    throw new ApiError(
      body?.error.code ?? 'request_failed',
      body?.error.message ?? 'The request could not be completed.',
      response.status,
      body?.error.details ?? [],
    );
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as ApiSuccess<T>;
  return body.data;
}

function csrfHeader(): Record<string, string> {
  const cookies = document.cookie.split('; ');
  const names = window.location.pathname.startsWith('/sign/')
    ? ['esign_csrf=', 'esign_staff_csrf=']
    : ['esign_staff_csrf=', 'esign_csrf='];
  const csrf = names
    .map((prefix) => cookies.find((item) => item.startsWith(prefix))?.slice(prefix.length))
    .find(Boolean);
  return csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {};
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}
