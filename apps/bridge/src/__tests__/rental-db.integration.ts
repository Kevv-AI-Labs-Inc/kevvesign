import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BridgeStore } from '../store.js';

const url = process.env.ESIGN_DATABASE_URL;
if (url !== 'postgres://postgres@127.0.0.1:5597/esign_rental_test')
  throw new Error('Disposable local rental database required');
const store = new BridgeStore(url, '11'.repeat(32));
try {
  await store.migrate();
  const run = randomUUID();
  // Recreate pre-rental constraints on this disposable database only.
  await store.query(
    "UPDATE signing.requests SET scenario='buyer' WHERE scenario='rental'; UPDATE signing.packages SET scenario='buyer' WHERE scenario='rental'",
  );
  await store.query(`ALTER TABLE signing.packages DROP CONSTRAINT packages_scenario_check;
    ALTER TABLE signing.packages ADD CONSTRAINT packages_scenario_check CHECK (scenario IN ('onboarding','team_leader','offboarding','buyer','seller','commercial','company_file'));
    ALTER TABLE signing.requests DROP CONSTRAINT requests_scenario_check;
    ALTER TABLE signing.requests ADD CONSTRAINT requests_scenario_check CHECK (scenario IN ('onboarding','team_leader','offboarding','buyer','seller','commercial','company_file','custom'));`);
  await store.migrate();
  await store.migrate();
  const constraints = await store.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE connamespace='signing'::regnamespace AND conname IN ('packages_scenario_check','requests_scenario_check')`,
  );
  assert.equal(constraints.length, 2);
  assert(
    constraints.every(
      (c) => c.definition.includes('rental') && c.definition.includes('offboarding'),
    ),
  );
  const { rows } = await store.pool.query(
    `INSERT INTO signing.packages(id,client_id,package_key,version,title,scenario,company_key,selectors,definition,published_by)
    VALUES(gen_random_uuid(),$1,'rental-qa',1,'Synthetic rental','rental','qa','{}','[]',1) RETURNING id`,
    [run],
  );
  await store.query(
    `INSERT INTO signing.requests(id,client_id,owner_agent_id,idempotency_key,request_hash,external_reference,scenario,package_id,title,business,input_snapshot)
    VALUES(gen_random_uuid(),$2,1,'rental-qa','qa','rental-qa','rental',$1,'Synthetic rental','{}','{}')`,
    [rows[0].id, run],
  );
  await assert.rejects(
    store.query(`UPDATE signing.packages SET scenario='unreviewed' WHERE id=$1`, [rows[0].id]),
  );
  console.log(
    'Rental database: legacy upgrade, repeated migration, inserts and invalid scenario rejection passed',
  );
} finally {
  await store.close();
}
