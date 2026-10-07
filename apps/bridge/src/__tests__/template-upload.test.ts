import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { SigningService } from '../service.js';
import type { NativeEnvelope, Documenso } from '../documenso.js';
import type { BridgeConfig, Principal } from '../config.js';
import type { BridgeStore } from '../store.js';
import { templateRecipients, templateLayoutSchema } from '../template-layout.js';

const principal = { clientId: 'portal', agentId: 7, admin: true } as Principal;
const pdf = await PDFDocument.create();
pdf.addPage([612, 792]);
const file = { name: 'Synthetic.pdf', bytes: Buffer.from(await pdf.save()) };
const input = {
  uploadId: '00000000-0000-4000-8000-000000000001',
  title: 'Synthetic template',
  layout: templateLayoutSchema.parse({
    recipients: [
      {
        name: 'Consumer',
        role: 'SIGNER',
        fields: [
          {
            identifier: 0,
            type: 'SIGNATURE',
            page: 1,
            positionX: 10,
            positionY: 70,
            width: 30,
            height: 8,
            fieldMeta: { type: 'signature', label: 'Consumer signature' },
          },
        ],
      },
    ],
  }),
};
function fixture() {
  let row: { request_hash: string; provider_id: string | null; state: string } | undefined;
  const native = {
    id: 'template',
    type: 'TEMPLATE',
    status: 'DRAFT',
    userId: 4,
    teamId: 3,
    user: { email: 'company@example.invalid' },
    visibility: 'ADMIN',
    deletedAt: null,
    externalId: `company-template:${input.uploadId}`,
    recipients: templateRecipients(input.layout).map((r) => ({
      ...r,
      id: 5,
      token: 'MUST-NOT-LEAK',
    })),
    envelopeItems: [{ id: 'pdf', title: file.name }],
    fields: [
      { ...input.layout.recipients[0].fields[0], id: 9, recipientId: 5, envelopeItemId: 'pdf' },
    ],
  } as unknown as NativeEnvelope;
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.startsWith('INSERT INTO signing.template_uploads') && !row)
      row = { request_hash: args[4] as string, provider_id: null, state: 'new' };
    if (sql.startsWith('SELECT * FROM signing.template_uploads')) return [row];
    if (sql.includes("SET state='creating'")) row!.state = 'creating';
    if (sql.includes('SET provider_id=')) row!.provider_id = args[1] as string;
    if (sql.includes("SET state='ready'")) row!.state = 'ready';
    return [];
  });
  const provider = {
    get: vi.fn(async (id: string) =>
      id === 'template'
        ? native
        : {
            id: 'probe',
            externalId: `${native.externalId}:preflight:0`,
            status: 'DRAFT',
            recipients: [],
            envelopeItems: [{ id: 'pdf' }],
          },
    ),
    list: vi.fn(async () => ({ data: [], totalPages: 1 })),
    create: vi.fn(async (payload: { type: string }) =>
      payload.type === 'TEMPLATE' ? 'template' : 'probe',
    ),
    document: vi.fn(async () => file.bytes),
    editorUrl: vi.fn(() => 'https://esign.example.invalid/edit/template'),
    deleteDraft: vi.fn(async () => {}),
    distribute: vi.fn(),
  };
  const connection = {
    scope: 'company',
    team_id: 3,
    native_user_id: 4,
    native_email: 'company@example.invalid',
  };
  const service = new SigningService({ query } as unknown as BridgeStore, {} as BridgeConfig);
  Object.assign(service, {
    connection: vi.fn(async () => connection),
    provider: () => provider as unknown as Documenso,
    lease: async (_id: string, work: () => Promise<unknown>) => work(),
  });
  return { service, provider, connection, native, query };
}

describe('administrator template upload with reviewed layout', () => {
  it('creates only a template and a recipient-free PDF probe, never sends, and safely replays', async () => {
    const { service, provider, query } = fixture();
    await service.uploadTemplate(principal, 'company', input, [file]);
    expect(provider.create.mock.calls[0][0]).toMatchObject({
      type: 'TEMPLATE',
      visibility: 'ADMIN',
      recipients: [{ email: 'template-role-1@example.invalid' }],
    });
    expect(provider.create.mock.calls[1][0]).toMatchObject({ type: 'DOCUMENT', recipients: [] });
    expect(provider.deleteDraft).toHaveBeenCalledWith('probe');
    expect(provider.distribute).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes("SET state='ready'"))).toBe(true);
    await service.uploadTemplate(principal, 'company', input, [file]);
    expect(provider.create).toHaveBeenCalledTimes(2);
    const changed = structuredClone(input);
    changed.layout.recipients[0].fields[0].positionX = 20;
    await expect(
      service.uploadTemplate(principal, 'company', changed, [file]),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('denies non-admins and customer connections before native mutation', async () => {
    const { service, provider, connection } = fixture();
    await expect(
      service.uploadTemplate({ ...principal, admin: false }, 'company', input, [file]),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    connection.scope = 'customer';
    await expect(service.uploadTemplate(principal, 'company', input, [file])).rejects.toMatchObject(
      { code: 'COMPANY_TEMPLATES_ONLY' },
    );
    expect(provider.create).not.toHaveBeenCalled();
  });
  it('rejects wrong file references, changed native fields and normalized PDF bytes', async () => {
    const invalid = structuredClone(input);
    invalid.layout.recipients[0].fields[0].identifier = 1;
    const first = fixture();
    await expect(
      first.service.uploadTemplate(principal, 'company', invalid, [file]),
    ).rejects.toMatchObject({ code: 'TEMPLATE_ITEM_MISMATCH' });
    expect(first.provider.create).not.toHaveBeenCalled();
    const absentPage = structuredClone(input);
    absentPage.layout.recipients[0].fields[0].page = 2;
    await expect(
      first.service.uploadTemplate(principal, 'company', absentPage, [file]),
    ).rejects.toMatchObject({ code: 'TEMPLATE_PAGE_MISMATCH' });
    await expect(
      first.service.uploadTemplate(principal, 'company', input, [
        { ...file, bytes: Buffer.from('%PDF-invalid') },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_PDF_UPLOAD' });
    expect(first.provider.create).not.toHaveBeenCalled();
    const second = fixture();
    second.native.fields[0].page = 2;
    await expect(
      second.service.uploadTemplate(principal, 'company', input, [file]),
    ).rejects.toMatchObject({ code: 'TEMPLATE_LAYOUT_MISMATCH' });
    const third = fixture();
    third.provider.document.mockResolvedValue(Buffer.from('%PDF-changed'));
    await expect(
      third.service.uploadTemplate(principal, 'company', input, [file]),
    ).rejects.toMatchObject({ code: 'TEMPLATE_PDF_CHANGED' });
    for (const f of [second, third])
      expect(f.query.mock.calls.some(([sql]) => sql.includes("SET state='ready'"))).toBe(false);
  });
  it('exposes template geometry to admins without native tokens, and rechecks ownership', async () => {
    const { service, native, provider } = fixture();
    const result = await service.templates(principal, 'company', 'template');
    expect(result).toHaveProperty('layout');
    expect(JSON.stringify(result)).not.toContain('MUST-NOT-LEAK');
    native.teamId = 999;
    await expect(service.templates(principal, 'company', 'template')).rejects.toMatchObject({
      code: 'TEMPLATE_ACCESS_MISMATCH',
    });
    provider.get.mockClear();
    await expect(
      service.templates({ ...principal, admin: false }, 'company', 'template'),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(provider.get).not.toHaveBeenCalled();
  });
});
