import { z } from 'zod';
import type { Envelope, TemplateField } from '@esign/contracts';
import {
  DomainError,
  type SigningEngine,
  type SigningEngineDocumentInput,
  type SigningEngineEnvelope,
} from '@esign/domain';

const RecipientSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    email: z.string().email(),
    name: z.string().default(''),
    role: z.string().default('SIGNER'),
    signingOrder: z.number().nullable().optional(),
    sendStatus: z.string().optional(),
    signingStatus: z.string().optional(),
    readStatus: z.string().optional(),
    signedAt: z.string().nullable().optional(),
    signingUrl: z.string().url().optional(),
  })
  .passthrough();

const ItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().default('document.pdf'),
    order: z.number().int().default(0),
  })
  .passthrough();

const EnvelopeSchema = z
  .object({
    id: z.string().min(1),
    externalId: z.string().nullable().optional(),
    status: z.string().default('DRAFT'),
    title: z.string().default('Untitled'),
    completedAt: z.string().nullable().optional(),
    recipients: z.array(RecipientSchema).default([]),
    envelopeItems: z.array(ItemSchema).default([]),
  })
  .passthrough();

const EnvelopeListSchema = z.object({
  data: z.array(EnvelopeSchema),
  pagination: z
    .object({ page: z.number(), totalPages: z.number() })
    .default({ page: 1, totalPages: 1 }),
});

type Fetch = typeof fetch;

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('DOCUMENSO_BASE_URL must not contain credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('DOCUMENSO_BASE_URL must use HTTPS outside local development.');
  }
  const root = url
    .toString()
    .replace(/\/$/, '')
    .replace(/\/api\/v2$/, '');
  return `${root}/api/v2`;
}

function engineRole(kind: Envelope['recipients'][number]['kind']): string {
  switch (kind) {
    case 'approver':
      return 'APPROVER';
    case 'viewer':
      return 'VIEWER';
    case 'copy':
      return 'CC';
    default:
      return 'SIGNER';
  }
}

function engineFieldType(field: TemplateField): string | undefined {
  switch (field.type) {
    case 'signature':
      return 'SIGNATURE';
    case 'initials':
      return 'INITIALS';
    case 'signed_date':
      return 'DATE';
    case 'full_name':
      return 'NAME';
    case 'email':
      return 'EMAIL';
    case 'number':
    case 'currency':
      return 'NUMBER';
    case 'checkbox':
      return 'CHECKBOX';
    case 'radio':
      return 'RADIO';
    case 'dropdown':
      return 'DROPDOWN';
    case 'attachment':
      return undefined;
    default:
      return 'TEXT';
  }
}

function externalEnvelope(value: z.infer<typeof EnvelopeSchema>): SigningEngineEnvelope {
  return {
    id: value.id,
    status: value.status,
    title: value.title,
    ...(value.externalId !== undefined ? { externalId: value.externalId } : {}),
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    recipients: value.recipients.map((recipient) => ({
      id: recipient.id,
      email: recipient.email,
      name: recipient.name,
      role: recipient.role,
      ...(recipient.signingOrder !== undefined ? { signingOrder: recipient.signingOrder } : {}),
      ...(recipient.sendStatus !== undefined ? { sendStatus: recipient.sendStatus } : {}),
      ...(recipient.signingStatus !== undefined ? { signingStatus: recipient.signingStatus } : {}),
      ...(recipient.readStatus !== undefined ? { readStatus: recipient.readStatus } : {}),
      ...(recipient.signedAt !== undefined ? { signedAt: recipient.signedAt } : {}),
      ...(recipient.signingUrl !== undefined ? { signingUrl: recipient.signingUrl } : {}),
    })),
    items: value.envelopeItems.map((item) => ({ ...item })),
  };
}

export class DocumensoSigningEngine implements SigningEngine {
  readonly provider = 'documenso' as const;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiToken: string,
    private readonly timeoutMs = 15_000,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!apiToken.startsWith('api_') || apiToken.length < 20) {
      throw new Error('DOCUMENSO_API_TOKEN must be a valid API token.');
    }
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
        headers: {
          Authorization: this.apiToken,
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        // Do not expose the provider response: it can contain document or recipient details.
        throw new DomainError(
          'signing_engine_error',
          `The signing engine rejected the request (${response.status}).`,
          502,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'signing_engine_unavailable',
        'The signing engine is unavailable.',
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async json(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(pathname, init);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 5 * 1024 * 1024) {
      throw new DomainError(
        'signing_engine_response_too_large',
        'Signing engine response is too large.',
        502,
      );
    }
    const body = await response.text();
    if (body.length > 5 * 1024 * 1024) {
      throw new DomainError(
        'signing_engine_response_too_large',
        'Signing engine response is too large.',
        502,
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new DomainError(
        'signing_engine_invalid_response',
        'Signing engine response is invalid.',
        502,
      );
    }
  }

  async health(): Promise<{ provider: string; reachable: boolean }> {
    await this.json('/envelope?type=DOCUMENT&page=1&perPage=1');
    return { provider: this.provider, reachable: true };
  }

  async findEnvelopeByExternalId(externalId: string): Promise<SigningEngineEnvelope | undefined> {
    // The v2 list API does not guarantee an externalId filter. Bound the recovery scan so a
    // retry can reconnect an envelope created before a local transaction committed.
    for (let page = 1; page <= 10; page += 1) {
      const result = EnvelopeListSchema.parse(
        await this.json(`/envelope?type=DOCUMENT&page=${page}&perPage=100`),
      );
      const match = result.data.find((candidate) => candidate.externalId === externalId);
      if (match) return externalEnvelope(match);
      if (page >= result.pagination.totalPages) break;
    }
    return undefined;
  }

  async createEnvelope(
    envelope: Envelope,
    documents: SigningEngineDocumentInput[],
  ): Promise<SigningEngineEnvelope> {
    if (envelope.fields.some((field) => field.type === 'attachment')) {
      throw new DomainError(
        'signing_engine_unsupported_field',
        'Attachment fields are not supported by the configured signing engine.',
        422,
      );
    }
    const form = new FormData();
    const roles = new Map(envelope.recipients.map((recipient) => [recipient.roleId, recipient]));
    const primaryRecipientRoleId = envelope.recipients.find(
      (recipient) => !['copy', 'viewer'].includes(recipient.kind),
    )?.roleId;
    const signingOrders = new Set(
      envelope.recipients
        .filter((recipient) => !['copy', 'viewer'].includes(recipient.kind))
        .map((recipient) => recipient.routingOrder),
    );
    const payload = {
      type: 'DOCUMENT',
      title: envelope.subject,
      externalId: envelope.id,
      visibility: 'ADMIN',
      recipients: envelope.recipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name,
        role: engineRole(recipient.kind),
        signingOrder: recipient.routingOrder,
        fields: envelope.fields
          .filter(
            (field) =>
              (field.roleId === recipient.roleId ||
                (field.roleId === null && recipient.roleId === primaryRecipientRoleId)) &&
              engineFieldType(field),
          )
          .map((field) => ({
            identifier: documents.find((document) => document.id === field.documentId)?.order ?? 0,
            type: engineFieldType(field),
            page: field.page,
            positionX: field.rect.x * 100,
            positionY: field.rect.y * 100,
            width: field.rect.width * 100,
            height: field.rect.height * 100,
            customText:
              typeof roles.get(field.roleId ?? '')?.values[field.id] === 'string'
                ? roles.get(field.roleId ?? '')?.values[field.id]
                : undefined,
            fieldMeta: {
              type: field.type,
              label: field.label,
              required: field.required,
              readOnly: field.readOnly,
              options: field.options,
            },
          })),
      })),
      meta: {
        subject: envelope.subject,
        message: envelope.message,
        timezone: 'America/New_York',
        signingOrder: signingOrders.size > 1 ? 'SEQUENTIAL' : 'PARALLEL',
        typedSignatureEnabled: true,
        uploadSignatureEnabled: false,
        drawSignatureEnabled: true,
        distributionMethod: 'EMAIL',
      },
    };
    form.set('payload', JSON.stringify(payload));
    for (const document of [...documents].sort((left, right) => left.order - right.order)) {
      form.append(
        'files',
        new Blob([Uint8Array.from(document.bytes).buffer], { type: 'application/pdf' }),
        document.name,
      );
    }
    const raw = await this.json('/envelope/create', { method: 'POST', body: form });
    const parsed = EnvelopeSchema.parse(
      typeof raw === 'object' && raw !== null && 'data' in raw
        ? (raw as { data: unknown }).data
        : raw,
    );
    return externalEnvelope(parsed);
  }

  async distributeEnvelope(envelopeId: string): Promise<SigningEngineEnvelope> {
    await this.json('/envelope/distribute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeId }),
    });
    return this.getEnvelope(envelopeId);
  }

  async redistributeEnvelope(
    envelopeId: string,
    recipientId?: string | number,
  ): Promise<SigningEngineEnvelope> {
    await this.json('/envelope/redistribute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeId, ...(recipientId === undefined ? {} : { recipientId }) }),
    });
    return this.getEnvelope(envelopeId);
  }

  async cancelEnvelope(envelopeId: string): Promise<void> {
    await this.json('/envelope/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeId }),
    });
  }

  async getEnvelope(envelopeId: string): Promise<SigningEngineEnvelope> {
    const raw = await this.json(`/envelope/${encodeURIComponent(envelopeId)}`);
    const parsed = EnvelopeSchema.parse(
      typeof raw === 'object' && raw !== null && 'data' in raw
        ? (raw as { data: unknown }).data
        : raw,
    );
    return externalEnvelope(parsed);
  }

  async downloadItem(itemId: string): Promise<Uint8Array> {
    const response = await this.request(`/envelope/item/${encodeURIComponent(itemId)}/download`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 100 * 1024 * 1024) {
      throw new DomainError('signing_engine_file_too_large', 'Completed PDF exceeds 100 MB.', 502);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 100 * 1024 * 1024) {
      throw new DomainError('signing_engine_file_too_large', 'Completed PDF exceeds 100 MB.', 502);
    }
    if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
      throw new DomainError(
        'signing_engine_invalid_pdf',
        'Signing engine returned an invalid PDF.',
        502,
      );
    }
    return bytes;
  }
}
