import { describe, expect, it, vi } from 'vitest';
import { SigningService } from '../service.js';
import type { BridgeConfig, Principal } from '../config.js';
import type { BridgeStore } from '../store.js';

const principal: Principal = {
  clientId: 'qa',
  agentId: 42,
  admin: false,
  verifiedEmails: ['agent@example.invalid'],
  allowedCompanyKeys: ['qa'],
  portalOrigin: 'https://portal.example.invalid',
};

function fixture(projection: { status: string } | null, nativeStatus = 'DRAFT') {
  const part = {
    id: 'part-qa',
    provider_id: 'native-qa',
    operation_state: 'linked',
    delivery_state: 'idle',
    snapshot: {},
    projection,
  };
  const query = vi.fn(async () => [part]);
  const service = new SigningService({ query } as unknown as BridgeStore, {} as BridgeConfig);
  const distribute = vi.fn();
  const syncPart = vi.fn(async () => ({
    document: { id: 'native-qa', status: nativeStatus },
    connection: {},
  }));
  Object.assign(service, {
    request: vi.fn(async () => ({
      id: 'request-qa',
      scenario: 'buyer',
      request_hash: 'prepared-qa',
      input_snapshot: { companyKey: 'qa' },
    })),
    lease: async (_id: string, run: () => Promise<void>) => run(),
    syncPart,
    provider: () => ({ distribute }),
    detail: vi.fn(async () => ({ id: 'request-qa' })),
  });
  return { service, query, syncPart, distribute };
}

describe('standard draft review at the native send boundary', () => {
  for (const cached of [null, { status: 'PENDING' }, { status: 'DRAFT' }]) {
    it(`rejects a missing or invalid hash with cached status ${cached?.status ?? 'null'}`, async () => {
      for (const hash of [undefined, '0'.repeat(64)]) {
        const { service, query, syncPart, distribute } = fixture(cached);
        await expect(
          service.command(principal, 'request-qa', 'send', undefined, undefined, hash),
        ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED', status: 409 });
        expect(syncPart).toHaveBeenCalledOnce();
        expect(distribute).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledOnce(); // No sending-state write.
      }
    });
  }
  for (const native of ['PENDING', 'COMPLETED']) {
    it(`keeps an already ${native} send retry idempotent without a hash`, async () => {
      const { service, distribute } = fixture(null, native);
      await expect(service.command(principal, 'request-qa', 'send')).resolves.toMatchObject({
        id: 'request-qa',
      });
      expect(distribute).not.toHaveBeenCalled();
    });
  }
});
