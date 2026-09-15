import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export class BridgeStore {
  readonly pool: Pool;
  constructor(
    databaseUrl: string,
    private credentialKey: string,
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30_000,
    });
    this.pool.on('error', () => {});
  }
  async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return (await this.pool.query<T>(text, values)).rows;
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(this.credentialKey, 'hex'), iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  decrypt(value: string) {
    const bytes = Buffer.from(value, 'base64'),
      cipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(this.credentialKey, 'hex'),
        bytes.subarray(0, 12),
      );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  async migrate() {
    await this.pool.query(BRIDGE_SCHEMA);
  }
  async close() {
    await this.pool.end();
  }
}

export const BRIDGE_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS signing;
CREATE TABLE IF NOT EXISTS signing.connections (
 id UUID PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('customer','company')),
 owner_agent_id INTEGER, company_key TEXT, native_user_id INTEGER NOT NULL, native_email TEXT NOT NULL, native_name TEXT NOT NULL,
 team_id INTEGER NOT NULL UNIQUE, team_url TEXT NOT NULL, token_ciphertext TEXT NOT NULL,
 isolation_verified_by INTEGER NOT NULL, isolation_notes TEXT NOT NULL, proof_envelope_id TEXT NOT NULL,
 revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((scope = 'customer' AND owner_agent_id IS NOT NULL AND company_key IS NULL) OR (scope = 'company' AND owner_agent_id IS NULL AND company_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_agent ON signing.connections(client_id,owner_agent_id) WHERE scope='customer' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connection_company ON signing.connections(client_id,company_key) WHERE scope='company' AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS signing.template_uploads (
 id UUID PRIMARY KEY, client_id TEXT NOT NULL,
 connection_id UUID NOT NULL REFERENCES signing.connections(id) ON DELETE RESTRICT,
 actor_agent_id INTEGER NOT NULL, request_hash TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE,
 provider_id TEXT, state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','creating','unknown','ready','failed')),
 last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS signing.packages (
 id UUID PRIMARY KEY, client_id TEXT NOT NULL, package_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 title TEXT NOT NULL, scenario TEXT NOT NULL CHECK(scenario IN ('onboarding','team_leader','buyer','seller','commercial')),
 company_key TEXT NOT NULL, selectors JSONB NOT NULL DEFAULT '{}', definition JSONB NOT NULL,
 published_by INTEGER NOT NULL, retired_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(client_id,package_key,version)
);
ALTER TABLE signing.packages ADD COLUMN IF NOT EXISTS applicable_company_keys TEXT[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS signing.requests (
 id UUID PRIMARY KEY, client_id TEXT NOT NULL, owner_agent_id INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, external_reference TEXT NOT NULL,
 scenario TEXT NOT NULL CHECK(scenario IN ('onboarding','team_leader','buyer','seller','commercial','custom')),
 package_id UUID REFERENCES signing.packages(id) ON DELETE RESTRICT,
 title TEXT NOT NULL, business JSONB NOT NULL, input_snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(client_id,owner_agent_id,idempotency_key), UNIQUE(client_id,external_reference)
);
-- Upgrade existing installations as well as fresh databases. Existing rows remain valid.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='signing.packages'::regclass AND conname='packages_scenario_check' AND position('commercial' in pg_get_constraintdef(oid))=0) THEN
  ALTER TABLE signing.packages DROP CONSTRAINT packages_scenario_check;
  ALTER TABLE signing.packages ADD CONSTRAINT packages_scenario_check CHECK(scenario IN ('onboarding','team_leader','buyer','seller','commercial'));
 END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='signing.requests'::regclass AND conname='requests_scenario_check' AND position('commercial' in pg_get_constraintdef(oid))=0) THEN
  ALTER TABLE signing.requests DROP CONSTRAINT requests_scenario_check;
  ALTER TABLE signing.requests ADD CONSTRAINT requests_scenario_check CHECK(scenario IN ('onboarding','team_leader','buyer','seller','commercial','custom'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS signing.request_parts (
 id UUID PRIMARY KEY, request_id UUID NOT NULL REFERENCES signing.requests(id) ON DELETE RESTRICT,
 part_index INTEGER NOT NULL, connection_id UUID NOT NULL REFERENCES signing.connections(id) ON DELETE RESTRICT,
 external_id TEXT NOT NULL UNIQUE, provider_id TEXT UNIQUE, folder_id TEXT,
 operation_state TEXT NOT NULL DEFAULT 'prepared' CHECK(operation_state IN ('prepared','creating','unknown','linked','failed','discarded')),
 create_started_at TIMESTAMPTZ, snapshot JSONB NOT NULL, recipients JSONB NOT NULL DEFAULT '[]',
 delivery_state TEXT NOT NULL DEFAULT 'idle' CHECK(delivery_state IN ('idle','sending','unknown','sent')),
 projection JSONB, last_error TEXT, last_synced_at TIMESTAMPTZ, reminder_requested_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(request_id,part_index)
);
CREATE TABLE IF NOT EXISTS signing.webhook_inbox (
 digest TEXT PRIMARY KEY, connection_id UUID NOT NULL REFERENCES signing.connections(id) ON DELETE RESTRICT,
 event TEXT NOT NULL, provider_id TEXT NOT NULL, external_id TEXT,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
ALTER TABLE signing.webhook_inbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE signing.request_parts ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE signing.request_parts ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS webhook_inbox_pending_retry ON signing.webhook_inbox(next_attempt_at,received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS parts_reconcile_retry ON signing.request_parts(next_reconcile_at) WHERE operation_state <> 'discarded';
CREATE INDEX IF NOT EXISTS requests_owner_page ON signing.requests(client_id,owner_agent_id,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS signing.request_uploads (
 part_id UUID NOT NULL REFERENCES signing.request_parts(id) ON DELETE RESTRICT,
 file_index INTEGER NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, content_ciphertext TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(part_id,file_index)
);
CREATE TABLE IF NOT EXISTS signing.events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id UUID REFERENCES signing.requests(id) ON DELETE RESTRICT, client_id TEXT NOT NULL,
 actor_agent_id INTEGER, event TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS requests_owner ON signing.requests(client_id,owner_agent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS parts_reconcile ON signing.request_parts(last_synced_at) WHERE operation_state <> 'discarded';
CREATE TABLE IF NOT EXISTS signing.portal_outbox (
 id UUID PRIMARY KEY, request_id UUID NOT NULL REFERENCES signing.requests(id) ON DELETE RESTRICT,
 client_id TEXT NOT NULL, owner_agent_id INTEGER NOT NULL, scenario TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT
);
CREATE INDEX IF NOT EXISTS portal_outbox_pending ON signing.portal_outbox(next_attempt_at) WHERE delivered_at IS NULL;
`;
