import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadBridgeConfig } from '../config.js';
import { BridgeStore } from '../store.js';
import { SigningService } from '../service.js';
import { Documenso } from '../documenso.js';
import type { Connection, PackageRow } from '../model.js';

// A remote operator can publish through the authenticated bridge API while the
// production databases stay private. Native credentials are read only locally.
export async function importContext() {
  const agentId = Number(process.env.ESIGN_OPERATOR_AGENT_ID);
  const email = z.email().parse(process.env.ESIGN_OPERATOR_EMAIL).toLowerCase();
  const clientId = z.string().min(2).parse(process.env.ESIGN_OPERATOR_CLIENT_ID);
  if (!Number.isSafeInteger(agentId) || agentId < 1)
    throw new Error('Canonical Portal operator ID required');
  const actor = { agentId, admin: true, verifiedEmails: [email] };
  const remote = process.env.ESIGN_IMPORT_BRIDGE_URL;
  if (remote) {
    const origin = new URL(remote);
    if (
      origin.origin !== remote ||
      (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))
    )
      throw new Error('Trusted HTTPS bridge origin required');
    const token = z.string().min(24).parse(process.env.ESIGN_BRIDGE_API_KEY);
    const nativeUrl = z.url().parse(process.env.DOCUMENSO_BASE_URL);
    const credentials = z
      .object({
        connections: z.array(
          z.object({
            companyKey: z.string(),
            email: z.email(),
            name: z.string(),
            nativeUserId: z.number().int().positive(),
            teamId: z.number().int().positive(),
            teamUrl: z.string(),
            token: z.string().min(16),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            z.string().min(1).parse(process.env.ESIGN_IMPORT_NATIVE_CREDENTIALS),
            'utf8',
          ),
        ),
      );
    async function api<T>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(remote + '/v1/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Portal-Actor': Buffer.from(JSON.stringify(actor)).toString('base64url'),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Bridge import API ${path}: HTTP ${response.status}`);
      return (await response.json()) as T;
    }
    return {
      clientId,
      async connections(): Promise<Connection[]> {
        const current = await api<{
          items: Array<{
            id: string;
            scope: string;
            companyKey: string;
            nativeEmail: string;
            teamUrl: string;
            revokedAt: string | null;
          }>;
        }>('connections');
        return credentials.connections.map((c) => {
          const matches = current.items.filter(
            (r) =>
              r.scope === 'company' &&
              r.companyKey === c.companyKey &&
              !r.revokedAt &&
              r.nativeEmail === c.email &&
              r.teamUrl === c.teamUrl,
          );
          if (matches.length !== 1)
            throw new Error(
              'Native credentials do not match the registered company connection: ' + c.companyKey,
            );
          return {
            id: matches[0].id,
            client_id: clientId,
            scope: 'company',
            owner_agent_id: null,
            company_key: c.companyKey,
            native_user_id: c.nativeUserId,
            native_email: c.email,
            team_id: c.teamId,
            team_url: c.teamUrl,
            token_ciphertext: '',
            revoked_at: null,
          };
        });
      },
      provider(connection: Connection) {
        const credential = credentials.connections.find(
          (c) =>
            c.companyKey === connection.company_key &&
            c.email === connection.native_email &&
            c.teamId === connection.team_id,
        )!;
        return new Documenso(nativeUrl, credential.token);
      },
      async packages() {
        return (await api<{ items: PackageRow[] }>('packages')).items;
      },
      publish(body: unknown) {
        return api<PackageRow>('packages', body);
      },
      async close() {},
    };
  }
  const config = loadBridgeConfig(),
    client = config.clients.find((c) => c.id === clientId);
  if (!client) throw new Error('Verified Portal operator client required');
  const principal = { ...actor, clientId, portalOrigin: client.portalOrigin };
  const store = new BridgeStore(config.ESIGN_DATABASE_URL, config.ESIGN_CREDENTIAL_KEY),
    service = new SigningService(store, config);
  await store.migrate();
  return {
    clientId,
    connections: () =>
      store.query<Connection>(
        "SELECT * FROM signing.connections WHERE client_id=$1 AND scope='company' AND revoked_at IS NULL",
        [clientId],
      ),
    provider: (connection: Connection) => service.provider(connection),
    packages: () => service.packages(principal),
    publish: (body: unknown) => service.publish(principal, body),
    close: () => store.close(),
  };
}
