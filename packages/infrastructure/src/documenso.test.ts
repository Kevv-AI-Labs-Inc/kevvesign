import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@esign/contracts';
import { DomainError } from '@esign/domain';
import { DocumensoSigningEngine } from './documenso';

function localEnvelope(fieldType: Envelope['fields'][number]['type'] = 'signature'): Envelope {
  const documentId = '22222222-2222-4222-8222-222222222222';
  const roleId = '33333333-3333-4333-8333-333333333333';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    templateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    templateVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    subject: 'Synthetic offer',
    message: 'Please review',
    status: 'READY_TO_SEND',
    jurisdiction: 'NY',
    businessDomain: 'REAL_ESTATE',
    approvalRequired: false,
    expiresAt: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    documents: [
      {
        id: documentId,
        name: 'offer.pdf',
        objectKey: 'templates/offer.pdf',
        sha256: 'a'.repeat(64),
        sourceSha256: 'a'.repeat(64),
        pageCount: 1,
        order: 0,
        retentionClass: 'real-estate-7y',
        detectedMime: 'application/pdf',
      },
    ],
    fields: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        documentId,
        page: 1,
        type: fieldType,
        roleId,
        label: 'Buyer signature',
        required: true,
        readOnly: false,
        sensitive: false,
        tabIndex: 0,
        rect: { x: 0.1, y: 0.75, width: 0.25, height: 0.05, rotation: 0 },
      },
    ],
    recipients: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        roleId,
        name: 'Buyer One',
        email: 'buyer@example.test',
        kind: 'signer',
        routingOrder: 1,
        status: 'PENDING',
        assuranceMethod: 'email_invitation',
        accessCodeFailures: 0,
        values: {},
      },
    ],
    retentionPolicyId: 'real-estate-7y',
  };
}

function remoteEnvelope(status = 'DRAFT') {
  return {
    id: 'envelope_test123',
    externalId: '11111111-1111-4111-8111-111111111111',
    status,
    title: 'Synthetic offer',
    recipients: [
      {
        id: 42,
        email: 'buyer@example.test',
        name: 'Buyer One',
        role: 'SIGNER',
        sendStatus: status === 'DRAFT' ? 'NOT_SENT' : 'SENT',
      },
    ],
    envelopeItems: [{ id: 'item_1', title: 'offer.pdf', order: 0 }],
  };
}

describe('Documenso signing engine adapter', () => {
  it('maps normalized fields to the v2 multipart envelope contract', async () => {
    let requestBody: FormData | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestBody = init?.body as FormData;
      return Response.json(remoteEnvelope());
    });
    const engine = new DocumensoSigningEngine(
      'https://sign.example.test',
      'api_12345678901234567890',
      15_000,
      fetcher,
    );
    const result = await engine.createEnvelope(localEnvelope(), [
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'offer.pdf',
        order: 0,
        bytes: Buffer.from('%PDF-1.7 test'),
      },
    ]);

    expect(result.id).toBe('envelope_test123');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://sign.example.test/api/v2/envelope/create',
    );
    const payload = JSON.parse(String(requestBody?.get('payload'))) as {
      externalId: string;
      recipients: Array<{
        fields: Array<{
          identifier: number;
          positionX: number;
          positionY: number;
          width: number;
          height: number;
        }>;
      }>;
      meta: { signingOrder: string };
    };
    expect(payload.externalId).toBe(localEnvelope().id);
    expect(payload.meta.signingOrder).toBe('PARALLEL');
    expect(payload.recipients[0]?.fields[0]).toMatchObject({
      identifier: 0,
      positionX: 10,
      positionY: 75,
      width: 25,
      height: 5,
    });
    expect(requestBody?.getAll('files')).toHaveLength(1);
  });

  it('fails closed for unsupported fields and unsafe provider origins', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const engine = new DocumensoSigningEngine(
      'https://sign.example.test/api/v2',
      'api_12345678901234567890',
      15_000,
      fetcher,
    );
    await expect(engine.createEnvelope(localEnvelope('attachment'), [])).rejects.toMatchObject({
      code: 'signing_engine_unsupported_field',
      statusCode: 422,
    } satisfies Partial<DomainError>);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () => new DocumensoSigningEngine('http://sign.example.test', 'api_12345678901234567890'),
    ).toThrow('must use HTTPS');
  });

  it('uses provider resend/cancel endpoints and rejects non-PDF downloads', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (String(input).endsWith('/download')) return new Response('not-a-pdf');
      if (String(input).endsWith('/envelope/envelope_test123')) {
        return Response.json(remoteEnvelope('PENDING'));
      }
      return Response.json({ success: true });
    });
    const engine = new DocumensoSigningEngine(
      'https://sign.example.test',
      'api_12345678901234567890',
      15_000,
      fetcher,
    );

    await engine.redistributeEnvelope('envelope_test123', 42);
    await engine.cancelEnvelope('envelope_test123');
    await expect(engine.downloadItem('item_1')).rejects.toMatchObject({
      code: 'signing_engine_invalid_pdf',
    });
    expect(requests.some((request) => request.url.endsWith('/envelope/redistribute'))).toBe(true);
    expect(requests.some((request) => request.body?.includes('"recipientId":42'))).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/envelope/delete'))).toBe(true);
  });
});
