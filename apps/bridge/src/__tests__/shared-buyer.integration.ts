import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { BridgeStore } from '../store.js';
import { loadBridgeConfig, type Principal } from '../config.js';
import { Documenso, sha256 } from '../documenso.js';
import { SigningService } from '../service.js';

// Fixed local-only services and synthetic identities; never real contracts/mail.
const nativeUrl = 'http://localhost:3469';
const databaseUrl =
  'postgres://homix:synthetic-only@127.0.0.1:5569/homix_company_packages_integration';
const fixtures = JSON.parse(
  await readFile('/private/tmp/homix-documenso-integration/fixtures.json', 'utf8'),
);
const keys = ['homix_realty', 'homix_living'];
const identities = [
  fixtures.connections.find((c: { scope: string }) => c.scope === 'company'),
  fixtures.connections[0],
];
assert(identities.every((c) => c.email.endsWith('@example.invalid')));
const config = loadBridgeConfig({
  NODE_ENV: 'test',
  ESIGN_DATABASE_URL: databaseUrl,
  DOCUMENSO_BASE_URL: nativeUrl,
  ESIGN_CREDENTIAL_KEY: '34'.repeat(32),
  ESIGN_WEBHOOK_SECRET: 'synthetic-shared-buyer-webhook-secret',
  ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
    {
      id: 'homix-test',
      keyHash: sha256('synthetic-only-key'),
      portalOrigin: 'http://localhost:3000',
    },
  ]),
});
const store = new BridgeStore(databaseUrl, config.ESIGN_CREDENTIAL_KEY);
const service = new SigningService(store, config);
const admin: Principal = {
  clientId: 'homix-test',
  agentId: 900,
  admin: true,
  verifiedEmails: identities.map((c) => c.email),
  portalOrigin: 'http://localhost:3000',
  allowedCompanyKeys: keys,
};
const scenario = process.env.SIGNING_QA_SCENARIO || 'buyer';
assert(['buyer', 'seller', 'commercial'].includes(scenario));
const run = randomUUID();
const proof = await PDFDocument.create();
const page = proof.addPage([612, 792]);
page.drawText('SYNTHETIC SHARED BUYER QA - NOT A CONTRACT', {
  x: 30,
  y: 740,
  size: 12,
  font: await proof.embedFont(StandardFonts.Helvetica),
});
const files = [{ name: 'Synthetic shared buyer.pdf', bytes: await proof.save() }];
const providers = identities.map((c) => new Documenso(nativeUrl, c.token));
const results = [];
try {
  await store.migrate();
  const connections = [];
  for (const [i, identity] of identities.entries()) {
    const existing = (await service.connections(admin)).find(
      (c) => c.companyKey === keys[i] && !c.revokedAt,
    );
    if (existing) {
      connections.push(existing);
      continue;
    }
    const id = await providers[i].create(
      {
        title: 'Synthetic ownership proof',
        type: 'DOCUMENT',
        visibility: 'ADMIN',
        delegatedDocumentOwner: identity.email,
      },
      files,
    );
    connections.push(
      await service.registerConnection(admin, {
        scope: 'company',
        companyKey: keys[i],
        verifiedEmails: [identity.email],
        token: identity.token,
        proofEnvelopeId: id,
        isolationConfirmed: true,
        isolationNotes: 'Isolated local synthetic signing team; no production identities.',
      }),
    );
  }
  const people = ['Agent', 'Buyer 1', 'Buyer 2'].map((name, i) => ({
    name,
    email: `shared-${i}@example.invalid`,
    role: 'SIGNER',
    signingOrder: i + 1,
    fields: [
      {
        identifier: 0,
        type: 'SIGNATURE',
        page: 1,
        positionX: 10,
        positionY: 35 + i * 15,
        width: 35,
        height: 7,
        fieldMeta: { type: 'signature', required: true },
      },
      {
        identifier: 0,
        type: 'TEXT',
        page: 1,
        positionX: 50,
        positionY: 35 + i * 15,
        width: 35,
        height: 5,
        fieldMeta: { type: 'text', label: `Name ${i}`, readOnly: true, required: true },
      },
    ],
  }));
  const templateId = await providers[0].create(
    {
      title: `Synthetic shared buyer master ${run}`,
      type: 'TEMPLATE',
      visibility: 'ADMIN',
      delegatedDocumentOwner: identities[0].email,
      recipients: people,
      meta: { signingOrder: 'SEQUENTIAL' },
    },
    files,
  );
  const native = await providers[0].get(templateId);
  const roles = native.recipients.map((r, i) => ({
    key: i === 0 ? 'agent' : `buyer${i}`,
    actor: i === 0 ? 'owner' : 'customer',
    label: people[i].name,
    templateRecipientId: r.id,
    optional: i === 2,
  }));
  const published = await service.publish(admin, {
    packageKey: `shared-buyer-${run}`,
    version: 1,
    title: 'Synthetic shared buyer package',
    scenario,
    companyKey: keys[0],
    applicableCompanyKeys: keys,
    parts: [
      {
        title: 'Shared buyer',
        templateId,
        roles,
        prefill: native.fields
          .filter((f) => f.type === 'TEXT')
          .map((f) => ({
            templateFieldId: f.id,
            key: `name_${f.recipientId}`,
            label: 'Name',
            required: true,
          })),
      },
    ],
  });
  for (const [companyIndex, companyKey] of keys.entries())
    for (const count of [1, 2]) {
      const agent: Principal = {
        ...admin,
        admin: false,
        agentId: 19000 + companyIndex,
        verifiedEmails: [people[0].email],
        allowedCompanyKeys: [companyKey],
      };
      assert((await service.packages(agent)).some((p) => p.id === published.id));
      const active = roles.slice(0, count + 1);
      const input = {
        idempotencyKey: randomUUID(),
        externalReference: randomUUID(),
        title: `Synthetic shared ${companyKey} ${count}`,
        scenario,
        companyKey,
        packageId: published.id,
        ownerAgentId: agent.agentId,
        recipients: active.map((r, i) => ({
          key: r.key,
          name: people[i].name,
          email: people[i].email,
        })),
        values: Object.fromEntries(
          active.map((r, i) => [
            `name_${r.templateRecipientId}`,
            i === 0 ? companyKey : people[i].name,
          ]),
        ),
      };
      const request = await service.create(agent, input);
      assert.equal(request.parts[0].document?.status, 'DRAFT', request.parts[0].error || 'Draft');
      const provider = providers[companyIndex];
      let doc = await provider.get(request.parts[0].document!.id);
      assert.equal(doc.teamId, identities[companyIndex].teamId);
      assert.equal(doc.userId, identities[companyIndex].nativeUserId);
      assert.equal(doc.recipients.length, count + 1);
      assert.equal(doc.fields.length, 2 * (count + 1));
      await assert.rejects(service.detail({ ...agent, agentId: 19999 }, request.id));
      await assert.rejects(
        service.create(
          { ...agent, allowedCompanyKeys: [] },
          { ...input, idempotencyKey: randomUUID() },
        ),
      );
      const review = await service.review(agent, request.id);
      await service.command(agent, request.id, 'send', undefined, undefined, review.reviewHash);
      doc = await provider.get(doc.id);
      for (const person of doc.recipients.toSorted(
        (a, b) => (a.signingOrder || 0) - (b.signingOrder || 0),
      )) {
        for (const field of doc.fields.filter(
          (f) => f.recipientId === person.id && f.type === 'SIGNATURE',
        )) {
          const res = await fetch(`${nativeUrl}/api/trpc/envelope.field.sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              json: {
                token: person.token,
                fieldId: field.id,
                fieldValue: { type: 'SIGNATURE', value: `SYNTHETIC QA ${person.name}` },
              },
            }),
          });
          assert(res.ok, 'Synthetic field signing');
        }
        const res = await fetch(`${nativeUrl}/api/trpc/recipient.completeDocumentWithToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            json: { token: person.token, documentId: Number(doc.secondaryId.split('_')[1]) },
          }),
        });
        assert(res.ok, 'Synthetic completion');
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        doc = await provider.get(doc.id);
        if (doc.status === 'COMPLETED') break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(doc.status, 'COMPLETED');
      assert.equal((await service.refresh(agent, request.id)).category, 'completed');
      assert((await service.bundle(agent, request.id)).bytes.length > 1000);
      results.push({
        companyKey,
        count,
        requestId: request.id,
        nativeId: doc.id,
        teamId: doc.teamId,
        status: doc.status,
      });
      console.log(
        `PASS shared ${scenario} master: ${companyKey}, ${count} buyers, agent + clients complete and archive`,
      );
    }
  assert.equal(
    (await providers[0].get(templateId)).recipients.length,
    3,
    'Master remains unchanged',
  );
  await writeFile(
    `/private/tmp/homix-documenso-integration/shared-${scenario}-run.json`,
    JSON.stringify({ packageId: published.id, results }, null, 2),
  );
} finally {
  await store.close();
}
