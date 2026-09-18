import { describe, expect, it, vi } from 'vitest';
import { SigningService } from '../service.js';
import { sha256, templateFingerprint } from '../documenso.js';
import type { NativeEnvelope } from '../documenso.js';
import type { BridgeConfig, Principal } from '../config.js';
import type { BridgeStore } from '../store.js';
import type { PackageRow } from '../model.js';

const principal = {
  clientId: 'portal',
  agentId: 7,
  admin: false,
  verifiedEmails: [],
  allowedCompanyKeys: ['living'],
  portalOrigin: 'https://portal.example.invalid',
} as Principal;
function fixture() {
  const bytes = [Buffer.from('%PDF-1.7 first'), Buffer.from('%PDF-1.7 second')];
  const native = {
    id: 'native',
    type: 'TEMPLATE',
    deletedAt: null,
    teamId: 3,
    userId: 4,
    user: { email: 'company@example.invalid' },
    visibility: 'ADMIN',
    recipients: [],
    fields: [],
    envelopeItems: [
      { id: 'a', title: 'First.pdf' },
      { id: 'b', title: 'Second.pdf' },
    ],
    documentMeta: {},
  } as unknown as NativeEnvelope;
  const part = {
    title: 'Document',
    templateId: native.id,
    connectionId: 'company',
    roles: [],
    prefill: [],
    fingerprint: templateFingerprint(native, bytes.map(sha256)),
    files: bytes.map((b, i) => ({ title: native.envelopeItems[i].title, hash: sha256(b) })),
  };
  const row = {
    id: 'package',
    scenario: 'seller',
    company_key: 'realty',
    applicable_company_keys: ['realty', 'living'],
    definition: [part],
    catalog_kind: 'document',
  } as unknown as PackageRow;
  const query = vi.fn(async () => [row]);
  const provider = {
    get: vi.fn(async () => native),
    document: vi.fn(async (_: string, id: string) => bytes[id === 'a' ? 0 : 1]),
    create: vi.fn(),
    distribute: vi.fn(),
  };
  const service = new SigningService({ query } as unknown as BridgeStore, {} as BridgeConfig);
  Object.assign(service, {
    connection: vi.fn(async () => ({
      scope: 'company',
      company_key: 'realty',
      team_id: 3,
      native_user_id: 4,
      native_email: 'company@example.invalid',
    })),
    provider: () => provider,
  });
  return { service, query, provider, native, bytes, row };
}
describe('published company PDF browsing before preparation', () => {
  it('returns the selected PDF without recipients, a draft or native mutations', async () => {
    const { service, query, provider, bytes } = fixture();
    expect(await service.packageFile(principal, 'package', 0, 1)).toEqual({
      name: 'Second.pdf',
      bytes: bytes[1],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('retired_at IS NULL'), [
      'package',
      'portal',
    ]);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.distribute).not.toHaveBeenCalled();
  });
  it('denies other companies and unpublished/retired IDs before reading native data', async () => {
    const { service, query, provider } = fixture();
    await expect(
      service.packageFile({ ...principal, allowedCompanyKeys: ['other'] }, 'package', 0, 0),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    query.mockResolvedValueOnce([]);
    await expect(service.packageFile(principal, 'retired', 0, 0)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(provider.get).not.toHaveBeenCalled();
  });
  it('does not expose HR agreements even to admins through the catalog file route', async () => {
    const { service, row, provider } = fixture();
    row.scenario = 'onboarding';
    await expect(
      service.packageFile({ ...principal, admin: true }, 'package', 0, 0),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(provider.get).not.toHaveBeenCalled();
  });
  it('rejects invalid indices and retired package components', async () => {
    const { service, row, query, provider } = fixture();
    for (const [part, file] of [
      [-1, 0],
      [0, -1],
      [0, 0.5],
      [1, 0],
      [0, 2],
    ])
      await expect(service.packageFile(principal, 'package', part, file)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    row.catalog_kind = 'package';
    row.components = [{ id: 'retired', key: 'doc', version: 1, title: 'Retired' }];
    query.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(service.packageFile(principal, 'package', 0, 0)).rejects.toMatchObject({
      code: 'APPROVED_DOCUMENT_NOT_AVAILABLE',
    });
    expect(provider.get).not.toHaveBeenCalled();
  });
  it('rejects changed bytes and native ownership drift rather than showing unreviewed files', async () => {
    const first = fixture();
    first.bytes[0] = Buffer.from('%PDF-1.7 modified');
    await expect(first.service.packageFile(principal, 'package', 0, 0)).rejects.toMatchObject({
      code: 'PUBLISHED_TEMPLATE_CHANGED',
    });
    const second = fixture();
    second.native.teamId = 999;
    await expect(second.service.packageFile(principal, 'package', 0, 0)).rejects.toMatchObject({
      code: 'TEMPLATE_ACCESS_MISMATCH',
    });
    expect(second.provider.document).not.toHaveBeenCalled();
  });
});
