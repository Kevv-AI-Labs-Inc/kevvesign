import { z } from 'zod';
export const clientsSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]{2,80}$/),
      keyHash: z.string().regex(/^[a-f0-9]{64}$/),
      portalOrigin: z.url(),
      callbackSecret: z.string().min(32).optional(),
    }),
  )
  .min(1);
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  DOCUMENSO_BASE_URL: z.url(),
  ESIGN_DATABASE_URL: z.string().min(1),
  ESIGN_CREDENTIAL_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  ESIGN_PORTAL_CLIENTS_JSON: z.string(),
  ESIGN_WEBHOOK_SECRET: z.string().min(32),
  ESIGN_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
});
export function loadBridgeConfig(env = process.env) {
  const config = configSchema.parse(env);
  const clients = clientsSchema.parse(JSON.parse(config.ESIGN_PORTAL_CLIENTS_JSON));
  if (new Set(clients.map((c) => c.id)).size !== clients.length)
    throw new Error('Duplicate Portal client');
  for (const client of clients) {
    if (config.NODE_ENV === 'production' && !client.callbackSecret)
      throw new Error('Portal callback authentication is required in production');
    const url = new URL(client.portalOrigin);
    if (
      url.origin !== client.portalOrigin ||
      (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error('Portal must use a credential-free HTTPS origin');
  }
  return { ...config, clients };
}
export type BridgeConfig = ReturnType<typeof loadBridgeConfig>;
export type Principal = {
  clientId: string;
  agentId: number;
  admin: boolean;
  verifiedEmails: string[];
  portalOrigin: string;
};
