import { describe, expect, it } from 'vitest';
import { resolveNotificationOwner } from '../overlay/packages/lib/server-only/email/notification-recipient.js';
const admin = { id: 7, name: 'Company', email: 'admin@example.invalid' };
const agent = { id: 10, name: 'Agent', email: 'agent@example.invalid', role: 'APPROVER' };
const client = { id: 11, name: 'Client', email: 'client@example.invalid', role: 'SIGNER' };
const route = {
  ownerNotificationRecipient: agent.email,
  ownerNotificationUrl: 'https://portal.example.invalid/signing/qa',
};
const envelope = (settings: unknown = route) => ({
  id: 'envelope-qa',
  user: admin,
  documentMeta: { emailSettings: settings },
});
describe('native business notification destination', () => {
  it('preserves the company owner for HR and ordinary unconfigured native documents', () => {
    for (const settings of [null, {}, { recipientSigned: false }])
      expect(resolveNotificationOwner(envelope(settings), []).email).toBe(admin.email);
  });
  it('routes only to a bound signer or approver, preserving the native ownership id', () => {
    const input = envelope(),
      before = structuredClone(input);
    const destination = resolveNotificationOwner(input, [agent, client]);
    expect(destination).toMatchObject({
      email: agent.email,
      name: agent.name,
      id: admin.id,
      recipientId: agent.id,
      recipientRole: 'APPROVER',
      documentUrl: route.ownerNotificationUrl,
    });
    expect(input).toEqual(before);
    // Upstream completion de-duplicates against this target: only the normal
    // recipient completion email is delivered, never an extra admin copy.
    expect([agent, client].some((r) => r.email === destination.email)).toBe(true);
  });
  it('fails closed for removed recipients, CCs, duplicates and invalid explicit routes', () => {
    for (const recipients of [[], [client], [{ ...agent, role: 'CC' }], [agent, agent]])
      expect(() => resolveNotificationOwner(envelope(), recipients)).toThrow(
        'NOTIFICATION_RECIPIENT_NOT_BOUND',
      );
    for (const settings of [
      { ownerNotificationRecipient: agent.email },
      { ...route, ownerNotificationUrl: 'http://portal.example.invalid' },
      { ...route, ownerNotificationUrl: 'https://user:pass@portal.example.invalid' },
    ])
      expect(() => resolveNotificationOwner(envelope(settings), [agent])).toThrow(
        'INVALID_NOTIFICATION_ROUTE',
      );
  });
});
