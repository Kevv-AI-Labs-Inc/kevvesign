import { prisma } from '@documenso/prisma';
import {
  notificationRoute,
  resolveNotificationOwner,
  type NotificationEnvelope,
} from './notification-recipient';

export async function getNotificationOwner(envelope: NotificationEnvelope) {
  // Several upstream handlers only include the recipient that triggered the
  // event. Resolve against all current recipients of this exact envelope.
  const recipients = notificationRoute(envelope)
    ? await prisma.recipient.findMany({
        where: { envelopeId: envelope.id },
        select: { id: true, email: true, name: true, role: true },
      })
    : [];
  return resolveNotificationOwner(envelope, recipients);
}
