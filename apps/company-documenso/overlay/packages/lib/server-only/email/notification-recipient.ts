// Shared-company ownership and business notification delivery are independent.
// This never changes an envelope's user, team, access rights or signers.
type User = { id: number; email: string; name: string | null };
type Recipient = { id: number; email: string; name: string; role: string };
export type NotificationEnvelope = {
  id: string;
  user: User;
  documentMeta: { emailSettings: unknown } | null;
};

export function notificationRoute(envelope: NotificationEnvelope) {
  const settings = envelope.documentMeta?.emailSettings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const { ownerNotificationRecipient: email, ownerNotificationUrl: url } = settings as Record<
    string,
    unknown
  >;
  if (email === undefined && url === undefined) return null;
  // Invalid explicit routing fails closed. Never silently fall back to the
  // shared administrator mailbox or deliver to an unbound address.
  if (typeof email !== 'string' || typeof url !== 'string')
    throw new Error('INVALID_NOTIFICATION_ROUTE');
  const link = new URL(url);
  if (link.protocol !== 'https:' || link.username || link.password)
    throw new Error('INVALID_NOTIFICATION_ROUTE');
  return { email: email.trim().toLowerCase(), url: link.href };
}

export function resolveNotificationOwner(envelope: NotificationEnvelope, recipients: Recipient[]) {
  const route = notificationRoute(envelope);
  if (!route)
    return {
      ...envelope.user,
      documentUrl: undefined,
      recipientId: undefined,
      recipientRole: undefined,
    };
  const matches = recipients.filter(
    (r) => r.email.toLowerCase() === route.email && ['SIGNER', 'APPROVER'].includes(r.role),
  );
  if (matches.length !== 1) throw new Error('NOTIFICATION_RECIPIENT_NOT_BOUND');
  const recipient = matches[0];
  return {
    ...envelope.user,
    email: recipient.email,
    name: recipient.name,
    documentUrl: route.url,
    recipientId: recipient.id,
    recipientRole: recipient.role === 'SIGNER' ? ('SIGNER' as const) : ('APPROVER' as const),
  };
}
