import type { Projection } from './model.js';

// Mirrors native sequential routing for the Portal action label. Documenso
// still performs the authoritative routing check when the signer opens it.
export function recipientIsCurrent(document: Projection, recipientId: number) {
  if (document.status !== 'PENDING') return false;
  const pending = document.recipients.filter(
    (r) => r.role !== 'CC' && r.signingStatus === 'NOT_SIGNED',
  );
  const recipient = pending.find((r) => r.id === recipientId);
  if (!recipient || (recipient.expiresAt && Date.parse(recipient.expiresAt) <= Date.now()))
    return false;
  if (document.signingOrder !== 'SEQUENTIAL') return true;
  return (recipient.signingOrder ?? 1) === Math.min(...pending.map((r) => r.signingOrder ?? 1));
}
