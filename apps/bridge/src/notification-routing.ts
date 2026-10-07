import type { Principal } from './config.js';
import { BridgeError, type PreparedPart } from './model.js';
import { isCompanyPackage } from './policy.js';

// Ownership stays with the company. Only business notifications go to the
// authenticated initiating agent, who is already an approved recipient.
export function routeAgentNotifications(
  part: PreparedPart,
  scenario: string,
  principal: Principal,
  requestId: string,
): PreparedPart {
  if (!isCompanyPackage(scenario)) return part;
  const owners = part.bindings.filter((r) => r.actor === 'owner');
  if (
    owners.length !== 1 ||
    !principal.verifiedEmails.includes(owners[0].email) ||
    !['SIGNER', 'APPROVER'].includes(owners[0].role)
  )
    throw new BridgeError('OWNER_RECIPIENT_NOT_VERIFIED', 403);
  const meta = (part.payload.meta || {}) as Record<string, unknown>;
  return {
    ...part,
    payload: {
      ...part.payload,
      meta: {
        ...meta,
        emailSettings: {
          ...(meta.emailSettings as Record<string, unknown> | null),
          ownerNotificationRecipient: owners[0].email,
          ownerNotificationUrl: `${principal.portalOrigin}/signing/${requestId}`,
        },
      },
    },
  };
}
