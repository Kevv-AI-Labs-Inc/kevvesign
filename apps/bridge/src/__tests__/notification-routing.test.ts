import { describe, expect, it } from 'vitest';
import { routeAgentNotifications } from '../notification-routing.js';
import type { PreparedPart } from '../model.js';
import type { Principal } from '../config.js';
const principal: Principal = {
  clientId: 'qa',
  agentId: 42,
  admin: false,
  verifiedEmails: ['agent@example.invalid'],
  allowedCompanyKeys: ['company'],
  portalOrigin: 'https://portal.example.invalid',
};
const part = (): PreparedPart => ({
  connection: {
    id: 'company',
    native_email: 'admin@example.invalid',
  } as PreparedPart['connection'],
  files: [],
  bindings: [
    {
      key: 'agent',
      actor: 'owner',
      name: 'Agent',
      email: 'agent@example.invalid',
      role: 'APPROVER',
    },
  ],
  payload: {
    delegatedDocumentOwner: 'admin@example.invalid',
    recipients: [{ email: 'agent@example.invalid', role: 'APPROVER' }],
    meta: { emailSettings: { documentPending: false }, language: 'en' },
  },
});
describe('business notifications belong to the initiating agent, independently of ownership', () => {
  for (const scenario of ['buyer', 'seller', 'commercial', 'company_file'])
    it(`routes ${scenario} to the verified owner recipient without changing ownership or invites`, () => {
      const source = part(),
        original = structuredClone(source);
      const result = routeAgentNotifications(source, scenario, principal, 'request-qa');
      expect(result.payload.meta).toEqual({
        language: 'en',
        emailSettings: {
          documentPending: false,
          ownerNotificationRecipient: 'agent@example.invalid',
          ownerNotificationUrl: 'https://portal.example.invalid/signing/request-qa',
        },
      });
      expect(result.payload.delegatedDocumentOwner).toBe('admin@example.invalid');
      expect(result.payload.recipients).toEqual(source.payload.recipients);
      expect(source).toEqual(original);
    });
  for (const scenario of ['onboarding', 'team_leader', 'offboarding', 'custom'])
    it(`preserves ${scenario} notifications`, () => {
      const source = part();
      expect(routeAgentNotifications(source, scenario, principal, 'qa')).toBe(source);
    });
  it('rejects missing, ambiguous or unverified agent recipients', () => {
    const source = part();
    for (const bindings of [
      [],
      [...source.bindings, ...source.bindings],
      [{ ...source.bindings[0], email: 'someone@example.invalid' }],
      [{ ...source.bindings[0], role: 'CC' }],
    ])
      expect(() =>
        routeAgentNotifications({ ...source, bindings }, 'buyer', principal, 'qa'),
      ).toThrow('OWNER_RECIPIENT_NOT_VERIFIED');
  });
});
