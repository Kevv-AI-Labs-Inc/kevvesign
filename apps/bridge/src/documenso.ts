import { z } from 'zod';
import { createHash } from 'node:crypto';

// Wire contract verified against official v2.18.0 (389390c). No native signing
// code is used here: layouts, recipient state and sealed bytes come upstream.
const recipientSchema = z
  .object({
    id: z.number().int(),
    email: z.email(),
    name: z.string(),
    token: z.string(),
    role: z.enum(['SIGNER', 'APPROVER', 'VIEWER', 'CC', 'ASSISTANT']),
    signingOrder: z.number().nullable(),
    signingStatus: z.enum(['NOT_SIGNED', 'SIGNED', 'REJECTED']),
    sendStatus: z.string(),
    readStatus: z.string(),
    signedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .passthrough();
export const envelopeSchema = z
  .object({
    id: z.string().min(1),
    secondaryId: z.string(),
    externalId: z.string().nullable(),
    title: z.string(),
    type: z.enum(['DOCUMENT', 'TEMPLATE']),
    status: z.enum(['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']),
    userId: z.number().int(),
    teamId: z.number().int(),
    folderId: z.string().nullable(),
    visibility: z.enum(['EVERYONE', 'MANAGER_AND_ABOVE', 'ADMIN']),
    user: z.object({ id: z.number().int(), email: z.email(), name: z.string().nullable() }),
    team: z.object({ id: z.number().int(), url: z.string() }),
    recipients: z.array(recipientSchema),
    envelopeItems: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        order: z.number().int(),
        documentDataId: z.string(),
      }),
    ),
    fields: z.array(
      z.object({
        id: z.number().int(),
        recipientId: z.number().int(),
        envelopeItemId: z.string(),
        type: z.string(),
        page: z.number().int().positive(),
        positionX: z.coerce.number(),
        positionY: z.coerce.number(),
        width: z.coerce.number(),
        height: z.coerce.number(),
        fieldMeta: z.record(z.string(), z.unknown()).nullable(),
        customText: z.string().nullable().optional(),
        inserted: z.boolean(),
      }),
    ),
    documentMeta: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
  })
  .passthrough();
export type NativeEnvelope = z.infer<typeof envelopeSchema>;
export type NativeRecipient = NativeEnvelope['recipients'][number];
export type NativeField = NativeEnvelope['fields'][number];

export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public uncertain = false,
  ) {
    super(code);
  }
}
export class Documenso {
  readonly origin: string;
  constructor(
    baseUrl: string,
    private token: string,
    private timeout = 20_000,
    private fetcher = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Documenso URL must be an origin');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Documenso requires HTTPS');
    this.origin = url.origin;
  }
  private async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/api/v2${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      throw new ProviderError(
        'PROVIDER_UNREACHABLE',
        502,
        Boolean(init.method && init.method !== 'GET'),
      );
    }
    if (!response.ok)
      throw new ProviderError(
        response.status === 429
          ? 'PROVIDER_RATE_LIMITED'
          : response.status === 404
            ? 'PROVIDER_DOCUMENT_NOT_FOUND'
            : 'PROVIDER_REQUEST_FAILED',
        response.status,
        response.status >= 500 && Boolean(init.method),
      );
    return response;
  }
  private async json(path: string, body: unknown) {
    return (
      await this.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  }
  async get(id: string) {
    return envelopeSchema.parse(
      await (await this.request(`/envelope/${encodeURIComponent(id)}`)).json(),
    );
  }
  async list(
    input: {
      type?: 'DOCUMENT' | 'TEMPLATE';
      query?: string;
      page?: number;
      folderId?: string;
      status?: string;
    } = {},
  ) {
    const params = new URLSearchParams({
      type: input.type || 'DOCUMENT',
      page: String(input.page || 1),
      perPage: '100',
      orderByColumn: 'createdAt',
      orderByDirection: 'desc',
    });
    if (input.query) params.set('query', input.query);
    if (input.folderId) params.set('folderId', input.folderId);
    if (input.status) params.set('status', input.status);
    return z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
              externalId: z.string().nullable(),
              userId: z.number(),
              teamId: z.number(),
              folderId: z.string().nullable(),
            })
            .passthrough(),
        ),
        count: z.number(),
        currentPage: z.number(),
        perPage: z.number(),
        totalPages: z.number(),
      })
      .parse(await (await this.request(`/envelope?${params}`)).json());
  }
  async create(
    payload: Record<string, unknown>,
    files: Array<{ name: string; bytes: Uint8Array }>,
  ) {
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    files.forEach((file) =>
      form.append(
        'files',
        new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' }),
        file.name,
      ),
    );
    const result = z
      .object({ id: z.string().min(1) })
      .parse(await (await this.request('/envelope/create', { method: 'POST', body: form })).json());
    // Caller persists this ID before fetching, so a GET failure cannot create
    // another envelope after a successful multipart POST.
    return result.id;
  }
  async distribute(id: string) {
    await this.json('/envelope/distribute', { envelopeId: id });
  }
  async remind(id: string, recipients: number[]) {
    if (!recipients.length) throw new ProviderError('NO_RECIPIENTS', 400);
    await this.json('/envelope/redistribute', { envelopeId: id, recipients });
  }
  async cancel(id: string, reason: string) {
    const document = await this.get(id);
    if (document.status === 'CANCELLED') return document;
    if (document.status !== 'PENDING')
      throw new ProviderError('ONLY_PENDING_ENVELOPES_CAN_BE_CANCELLED', 409);
    await this.json('/envelope/cancel', { envelopeId: id, reason });
    return this.get(id);
  }
  async deleteDraft(id: string) {
    const document = await this.get(id);
    if (document.status !== 'DRAFT') throw new ProviderError('ONLY_DRAFTS_CAN_BE_DISCARDED', 409);
    await this.json('/envelope/delete', { envelopeId: id });
  }
  async update(id: string, data: Record<string, unknown>, meta?: Record<string, unknown>) {
    await this.json('/envelope/update', { envelopeId: id, data, meta });
  }
  async pdf(path: string) {
    const response = await this.request(path);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 50 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new ProviderError('INVALID_PROVIDER_PDF');
    return bytes;
  }
  async document(id: string, itemId: string, version: 'original' | 'signed') {
    const document = await this.get(id);
    if (!document.envelopeItems.some((item) => item.id === itemId))
      throw new ProviderError('DOCUMENT_ITEM_NOT_FOUND', 404);
    if (version === 'signed' && document.status !== 'COMPLETED')
      throw new ProviderError('SIGNED_PDF_NOT_READY', 409);
    return this.pdf(`/envelope/item/${encodeURIComponent(itemId)}/download?version=${version}`);
  }
  async certificate(id: string, type: 'audit-log' | 'certificate') {
    if ((await this.get(id)).status !== 'COMPLETED')
      throw new ProviderError('COMPLETION_FILES_NOT_READY', 409);
    return this.pdf(`/envelope/${encodeURIComponent(id)}/${type}/download`);
  }
  signingUrl(recipient: NativeRecipient) {
    return `${this.origin}/sign/${encodeURIComponent(recipient.token)}`;
  }
  editorUrl(document: NativeEnvelope) {
    return `${this.origin}/t/${encodeURIComponent(document.team.url)}/documents/${encodeURIComponent(document.id)}/edit`;
  }
}

export function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function templateFingerprint(document: NativeEnvelope, fileHashes: string[]) {
  return sha256(
    canonical({
      items: document.envelopeItems.map(({ id, title, order }) => ({ id, title, order })),
      recipients: document.recipients.map(({ id, role, signingOrder }) => ({
        id,
        role,
        signingOrder,
      })),
      fields: document.fields.map(({ inserted: _inserted, ...f }) => f),
      meta: document.documentMeta,
      fileHashes,
    }),
  );
}
