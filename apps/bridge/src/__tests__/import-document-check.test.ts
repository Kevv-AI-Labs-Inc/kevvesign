import { describe, expect, it, vi } from 'vitest';
import { verifyDocumentRoundTrip } from '../cli/import-document-check.js';
import type { Documenso } from '../documenso.js';

function fixture(
  bytes = Buffer.from('%PDF-approved'),
  status = 'DRAFT',
  recipients: unknown[] = [],
) {
  const provider = {
    list: vi.fn(async () => ({ data: [], totalPages: 1 })),
    create: vi.fn(async (_payload: Record<string, unknown>, _files: unknown[]) => 'probe'),
    get: vi.fn(async () => ({
      externalId: 'preflight:qa',
      status,
      recipients,
      envelopeItems: [{ id: 'pdf' }],
    })),
    document: vi.fn(async () => bytes),
    deleteDraft: vi.fn(async () => {}),
  };
  return {
    provider,
    run: () =>
      verifyDocumentRoundTrip(provider as unknown as Documenso, 'preflight:qa', {
        name: 'qa.pdf',
        bytes: Buffer.from('%PDF-approved'),
      }),
  };
}
describe('native document preflight before publishing', () => {
  it('accepts unchanged bytes and deletes the recipient-free probe', async () => {
    const { provider, run } = fixture();
    await run();
    expect(provider.create.mock.calls[0][0]).toMatchObject({
      type: 'DOCUMENT',
      recipients: [],
      visibility: 'ADMIN',
    });
    expect(provider.deleteDraft).toHaveBeenCalledWith('probe');
  });
  it('detects a template that changes on DOCUMENT conversion and cleans up', async () => {
    const { provider, run } = fixture(Buffer.from('%PDF-form-removed'));
    await expect(run()).rejects.toThrow('Native DOCUMENT changes the approved PDF');
    expect(provider.deleteDraft).toHaveBeenCalledWith('probe');
  });
  it('never deletes a pre-existing document with recipients or a changed status', async () => {
    for (const [status, recipients] of [
      ['PENDING', []],
      ['DRAFT', [{ id: 1 }]],
    ] as const) {
      const { provider, run } = fixture(undefined, status, [...recipients]);
      await expect(run()).rejects.toThrow('left untouched');
      expect(provider.deleteDraft).not.toHaveBeenCalled();
    }
  });
});
