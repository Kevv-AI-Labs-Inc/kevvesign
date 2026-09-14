import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BridgeStore } from '../store.js';
import { SigningService } from '../service.js';
import { loadBridgeConfig, type Principal } from '../config.js';
import { sha256 } from '../documenso.js';
const database =
  'postgres://homix:synthetic-only@127.0.0.1:5569/homix_company_packages_integration';
const config = loadBridgeConfig({
  NODE_ENV: 'test',
  ESIGN_DATABASE_URL: database,
  ESIGN_CREDENTIAL_KEY: '34'.repeat(32),
  DOCUMENSO_BASE_URL: 'http://localhost:3469',
  ESIGN_WEBHOOK_SECRET: 'synthetic-webhook-secret-never-production',
  ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
    {
      id: 'homix-test',
      keyHash: sha256('synthetic-company-package-api-key'),
      portalOrigin: 'http://localhost:3000',
    },
  ]),
});
const store = new BridgeStore(database, config.ESIGN_CREDENTIAL_KEY),
  service = new SigningService(store, config);
const run = randomUUID(),
  client = `pagination-${run}`;
const actor: Principal = {
  clientId: client,
  agentId: 10401,
  verifiedEmails: ['qa-company-agent-a@example.invalid'],
  admin: false,
  portalOrigin: 'http://localhost:3000',
  allowedCompanyKeys: ['homix_realty'],
};
try {
  await store.migrate();
  const [connection] = await store.query(
    "SELECT id FROM signing.connections WHERE scope='company' LIMIT 1",
  );
  assert(connection);
  const ids = await store.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO signing.requests(id,client_id,owner_agent_id,idempotency_key,request_hash,external_reference,scenario,title,business,input_snapshot,updated_at)
   SELECT gen_random_uuid(),$1,10401,'key-'||i,'hash-'||i,'ref-'||i,'buyer','Synthetic page '||i,'{}','{}',NOW() FROM generate_series(1,615) i RETURNING id`,
      [client],
    );
    for (const [index, row] of rows.entries()) {
      const state = index % 5;
      const recipient = {
        id: 1,
        key: 'agent',
        actor: 'owner',
        name: 'Synthetic agent',
        email: actor.verifiedEmails[0],
        role: 'SIGNER',
        signingOrder: 1,
        signingStatus: 'NOT_SIGNED',
        expiresAt: null,
      };
      const projection = {
        status:
          state === 0 ? 'REJECTED' : state === 1 ? 'COMPLETED' : state === 2 ? 'DRAFT' : 'PENDING',
        expired: false,
        signingOrder: 'SEQUENTIAL',
        recipients:
          state === 4
            ? [{ ...recipient, email: 'qa-client@example.invalid', actor: 'customer' }]
            : [recipient],
        files: [],
      };
      await tx.query(
        `INSERT INTO signing.request_parts(id,request_id,part_index,connection_id,external_id,operation_state,snapshot,recipients,projection)
       VALUES(gen_random_uuid(),$1,0,$2,$3,'linked','{}','[]',$4)`,
        [row.id, connection.id, `pagination:${row.id}`, projection],
      );
    }
    return rows.map((row) => row.id);
  });
  const seen = new Set<string>();
  for (let page = 1; page <= 21; page++) {
    const result = await service.list(actor, { page });
    assert.equal(result.count, 615);
    assert.equal(result.truncated, false);
    for (const item of result.items) {
      assert(!seen.has(item.id), 'Stable tie ordering without duplicates');
      seen.add(item.id);
    }
  }
  assert.equal(seen.size, 615);
  assert.deepEqual(new Set(ids), seen);
  for (const category of ['attention', 'completed', 'draft', 'mine', 'waiting']) {
    const list = await service.list(actor, { category });
    assert.equal(list.count, 123);
    assert(
      list.items.every((item) => item.category === category),
      'SQL category equals authorized detail projection',
    );
  }
  assert.equal((await service.list({ ...actor, agentId: 10402 }, {})).count, 0);
  assert.equal((await service.list(actor, { query: 'Synthetic page 615' })).count, 1);
  const beyond = await service.list(actor, { page: 99 });
  assert.equal(beyond.count, 615);
  assert.equal(beyond.items.length, 0);
  const runState = JSON.parse(
    await readFile('/private/tmp/homix-documenso-integration/company-stage-one-run.json', 'utf8'),
  );
  const [part] = await store.query('SELECT * FROM signing.request_parts WHERE id=$1', [
    runState.cases[0].partId,
  ]);
  assert(part?.provider_id);
  for (let i = 0; i < 101; i++)
    await store.query(
      "INSERT INTO signing.webhook_inbox(digest,connection_id,event,provider_id,external_id,received_at) VALUES($1,$2,'DOCUMENT_COMPLETED',$3,$4,NOW()-INTERVAL '1 hour')",
      [`poison:${run}:${i}`, part.connection_id, `incorrect-native-${i}`, part.external_id],
    );
  const healthy = `healthy:${run}`;
  await store.query(
    "INSERT INTO signing.webhook_inbox(digest,connection_id,event,provider_id,external_id) VALUES($1,$2,'DOCUMENT_COMPLETED',$3,$4)",
    [healthy, part.connection_id, part.provider_id, part.external_id],
  );
  await service.reconcile();
  await service.reconcile();
  const [processed] = await store.query(
    'SELECT processed_at FROM signing.webhook_inbox WHERE digest=$1',
    [healthy],
  );
  assert(processed.processed_at, 'Poisoned batch cannot starve a later valid event');
  const failures = await store.query(
    'SELECT attempts,next_attempt_at > NOW() AS deferred FROM signing.webhook_inbox WHERE digest LIKE $1',
    [`poison:${run}:%`],
  );
  assert(failures.every((row) => row.attempts === 1 && row.deferred));
  await store.query('DELETE FROM signing.webhook_inbox WHERE digest LIKE $1 OR digest=$2', [
    `poison:${run}:%`,
    healthy,
  ]);
  console.log(
    'PASS: 615 requests, stable full pagination, exact totals, every status category, search and cross-agent isolation.',
  );
} finally {
  await store.query(
    'DELETE FROM signing.request_parts WHERE request_id IN (SELECT id FROM signing.requests WHERE client_id=$1)',
    [client],
  );
  await store.query('DELETE FROM signing.requests WHERE client_id=$1', [client]);
  await store.close();
}
