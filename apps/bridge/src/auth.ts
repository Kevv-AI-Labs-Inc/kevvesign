import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BridgeConfig, Principal } from './config.js';
import { BridgeError, email } from './model.js';

const actorSchema = z
  .object({
    agentId: z.number().int().positive(),
    admin: z.boolean(),
    verifiedEmails: z.array(email).min(1).max(30),
  })
  .strict();
export function secretEquals(actual: string, expected: string) {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
export function authenticate(
  headers: Record<string, string | string[] | undefined>,
  config: BridgeConfig,
): Principal {
  const authorization = headers.authorization;
  const actorHeader = headers['x-portal-actor'];
  if (
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ') ||
    typeof actorHeader !== 'string' ||
    actorHeader.length > 10000
  )
    throw new BridgeError('UNAUTHORIZED', 401);
  const hash = createHash('sha256').update(authorization.slice(7)).digest('hex');
  const client = config.clients.find((c) => secretEquals(hash, c.keyHash));
  if (!client) throw new BridgeError('UNAUTHORIZED', 401);
  let actor: z.infer<typeof actorSchema>;
  try {
    actor = actorSchema.parse(JSON.parse(Buffer.from(actorHeader, 'base64url').toString('utf8')));
  } catch {
    throw new BridgeError('INVALID_PORTAL_ACTOR', 401);
  }
  return { ...actor, clientId: client.id, portalOrigin: client.portalOrigin };
}
export function webhookSecret(config: BridgeConfig, connectionId: string) {
  return createHmac('sha256', config.ESIGN_WEBHOOK_SECRET)
    .update(`documenso:${connectionId}`)
    .digest('hex');
}
