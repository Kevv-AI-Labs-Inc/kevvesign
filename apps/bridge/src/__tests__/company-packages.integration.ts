import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { BridgeStore } from '../store.js';
import { loadBridgeConfig, type Principal } from '../config.js';
import { Documenso, sha256 } from '../documenso.js';
import { SigningService } from '../service.js';
import { BridgeError } from '../model.js';
import { buildServer } from '../server.js';

// Deliberately fixed local endpoints: this suite may create/sign synthetic
// envelopes, but cannot be redirected to a production database or SMTP service.
const databaseUrl =
  'postgres://homix:synthetic-only@127.0.0.1:5569/homix_company_packages_integration';
const nativeUrl = 'http://localhost:3469';
const directory = '/private/tmp/homix-documenso-integration';
const fixtures = JSON.parse(await readFile(`${directory}/fixtures.json`, 'utf8'));
const company = fixtures.connections.find(
  (connection: { scope: string }) => connection.scope === 'company',
);
assert(company.email.endsWith('@example.invalid'));
const config = loadBridgeConfig({
  NODE_ENV: 'test',
  ESIGN_DATABASE_URL: databaseUrl,
  DOCUMENSO_BASE_URL: nativeUrl,
  ESIGN_CREDENTIAL_KEY: '34'.repeat(32),
  ESIGN_WEBHOOK_SECRET: 'synthetic-webhook-secret-never-production',
  ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
    {
      id: 'homix-test',
      keyHash: sha256('synthetic-company-package-api-key'),
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
  verifiedEmails: [company.email],
  portalOrigin: 'http://localhost:3000',
  allowedCompanyKeys: ['homix_realty', 'homix_living'],
};
const agent: Principal = {
  ...admin,
  agentId: 10401,
  admin: false,
  verifiedEmails: ['qa-company-agent-a@example.invalid'],
  allowedCompanyKeys: ['homix_realty'],
};
const other: Principal = {
  ...agent,
  agentId: 10402,
  verifiedEmails: ['qa-company-agent-b@example.invalid'],
};
const provider = new Documenso(nativeUrl, company.token);
const run = randomUUID();
const outputs: {
  count: number;
  requestId: string;
  partId: string;
  nativeId: string;
  packageId: string;
}[] = [];
const denied = (code: string) => (error: unknown) =>
  error instanceof BridgeError && error.code === code;
const app = await buildServer(config, service);

async function nativePost(path: string, body: unknown) {
  const response = await fetch(`${nativeUrl}/api/v2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${company.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(
    response.ok,
    true,
    `Native ${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
  );
  return response.json();
}
async function rpc(path: string, input: unknown) {
  const response = await fetch(`${nativeUrl}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const data = await response.json();
  assert(
    response.ok && !data.error,
    `Native public procedure ${path}: ${response.status} ${JSON.stringify(data.error?.json?.message ?? '')}`,
  );
  return data.result.data.json;
}
async function finishSynthetic(nativeId: string) {
  let document = await provider.get(nativeId);
  assert(document.title.includes('Synthetic'));
  for (const [index, person] of [...document.recipients]
    .sort((a, b) => (a.signingOrder ?? 1) - (b.signingOrder ?? 1))
    .entries()) {
    assert(person.email.endsWith('@example.invalid'));
    for (const field of document.fields.filter(
      (f) => f.recipientId === person.id && !f.fieldMeta?.readOnly,
    )) {
      assert.equal(field.type, 'SIGNATURE');
      await rpc('envelope.field.sign', {
        token: person.token,
        fieldId: field.id,
        fieldValue: { type: 'SIGNATURE', value: `SYNTHETIC QA ${person.name}` },
      });
    }
    await rpc('recipient.completeDocumentWithToken', {
      token: person.token,
      documentId: Number(document.secondaryId.split('_')[1]),
    });
    document = await provider.get(nativeId);
    if (index < document.recipients.length - 1)
      assert.equal(document.status, 'PENDING', 'A partial signature is not completion');
    const page = await fetch(`${nativeUrl}/sign/${person.token}`, { redirect: 'manual' });
    assert(
      page.headers.get('location')?.endsWith('/complete'),
      'Signer finishes on native completion page, not Portal login',
    );
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    document = await provider.get(nativeId);
    if (document.status === 'COMPLETED') return document;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Native signing/sealing did not complete');
}
async function testFiles() {
  const files = [];
  for (let i = 1; i <= 2; i++) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText(`SYNTHETIC COMPANY PACKAGE QA - NOT A CONTRACT - ${i}`, {
      x: 30,
      y: 750,
      size: 12,
      font,
    });
    files.push({ name: `Synthetic company document ${i}.pdf`, bytes: await pdf.save() });
  }
  return files;
}
try {
  await store.migrate();
  // Copy only the synthetic company connection; no personal native accounts.
  const seed = new BridgeStore(
    'postgres://homix:synthetic-only@127.0.0.1:5569/homix_signing_bridge_integration',
    config.ESIGN_CREDENTIAL_KEY,
  );
  try {
    const [row] = await seed.query(
      "SELECT * FROM signing.connections WHERE client_id='homix-test' AND scope='company' AND company_key='homix_realty' AND revoked_at IS NULL",
    );
    assert(row && row.native_email.endsWith('@example.invalid'));
    const columns = Object.keys(row);
    await store.query(
      `INSERT INTO signing.connections (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT(id) DO NOTHING`,
      Object.values(row),
    );
  } finally {
    await seed.close();
  }
  const [connection] = await store.query<{ id: string }>(
    "SELECT id FROM signing.connections WHERE client_id=$1 AND scope='company' AND company_key='homix_realty' AND revoked_at IS NULL",
    [admin.clientId],
  );
  assert(connection, 'Use the existing isolated synthetic company fixture');
  assert.equal(
    (
      await store.query('SELECT id FROM signing.connections WHERE owner_agent_id=ANY($1::int[])', [
        [agent.agentId, other.agentId],
      ])
    ).length,
    0,
    'The agents have no native accounts/connections',
  );
  const files = await testFiles();
  await assert.rejects(
    service.uploadTemplate(
      agent,
      connection.id,
      { uploadId: randomUUID(), title: 'Forbidden' },
      files,
    ),
    denied('ADMIN_REQUIRED'),
  );
  await assert.rejects(
    service.create(
      agent,
      {
        title: 'Forbidden',
        idempotencyKey: run,
        externalReference: run,
        scenario: 'custom',
        companyKey: 'homix_realty',
        ownerAgentId: agent.agentId,
        recipients: [],
      },
      files,
    ),
    denied('PERSONAL_SIGNING_UNAVAILABLE'),
  );

  for (const count of [1, 2]) {
    const upload = {
      uploadId: randomUUID(),
      title: `Synthetic company ${count}-client template ${run}`,
    };
    const created = await service.uploadTemplate(admin, connection.id, upload, files);
    assert.equal(
      (await service.uploadTemplate(admin, connection.id, upload, files)).id,
      created.id,
      'Upload retry reuses the native template',
    );
    assert(created.editorUrl.includes('/templates/'));
    await assert.rejects(
      service.uploadTemplate(admin, connection.id, { ...upload, title: 'Changed' }, files),
      denied('IDEMPOTENCY_KEY_REUSED'),
    );
    const people = [
      { name: 'Preparing agent', email: agent.verifiedEmails[0], role: 'SIGNER', signingOrder: 1 },
      ...Array.from({ length: count }, (_, i) => ({
        name: `Test client ${i + 1}`,
        email: `qa-company-client-${i + 1}@example.invalid`,
        role: 'SIGNER',
        signingOrder: i + 2,
      })),
    ];
    await nativePost('/envelope/recipient/create-many', { envelopeId: created.id, data: people });
    let template = await provider.get(created.id);
    const fields = template.recipients.flatMap((recipient, i) =>
      template.envelopeItems.map((item) => ({
        recipientId: recipient.id,
        envelopeItemId: item.id,
        type: 'SIGNATURE',
        page: 1,
        positionX: 10,
        positionY: 45 + i * 12,
        width: 35,
        height: 7,
        fieldMeta: { type: 'signature', required: true },
      })),
    );
    await nativePost('/envelope/field/create-many', {
      envelopeId: created.id,
      data: [
        ...fields,
        {
          recipientId: template.recipients[0].id,
          envelopeItemId: template.envelopeItems[0].id,
          type: 'TEXT',
          page: 1,
          positionX: 10,
          positionY: 20,
          width: 70,
          height: 6,
          fieldMeta: { type: 'text', label: 'Property', readOnly: true, required: true },
        },
      ],
    });
    await provider.update(created.id, {}, { signingOrder: 'SEQUENTIAL' });
    template = await provider.get(created.id);
    const roles = template.recipients.map((recipient, i) => ({
      key: i === 0 ? 'agent' : `client_${i}`,
      templateRecipientId: recipient.id,
      actor: i === 0 ? 'owner' : 'customer',
      label: i === 0 ? 'Agent' : `Client ${i}`,
    }));
    const published = await service.publish(admin, {
      packageKey: `company-qa-${count}-${run}`,
      version: 1,
      title: `Synthetic ${count}-client package`,
      scenario: count === 1 ? 'buyer' : 'seller',
      companyKey: 'homix_realty',
      selectors: { customer_count: String(count) },
      parts: [
        {
          title: 'Company approved documents',
          templateId: template.id,
          roles,
          prefill: [
            {
              key: 'property_address',
              label: 'Property address',
              templateFieldId: template.fields.find((field) => field.type === 'TEXT')!.id,
              required: true,
            },
          ],
        },
      ],
    });
    const input = {
      title: `Synthetic request ${count} ${run}`,
      idempotencyKey: randomUUID(),
      externalReference: randomUUID(),
      scenario: count === 1 ? 'buyer' : 'seller',
      packageId: published.id,
      companyKey: 'homix_realty',
      ownerAgentId: agent.agentId,
      recipients: roles.map((role, i) => ({
        key: role.key,
        name: people[i].name,
        email: people[i].email,
      })),
      business: { customer: 'Synthetic clients', property: '123 Test Street', reference: run },
      values: { property_address: '123 Test Street' },
    };
    await assert.rejects(
      service.create({ ...agent, allowedCompanyKeys: [] }, input),
      denied('COMPANY_ACCESS_DENIED'),
    );
    await assert.rejects(
      service.create(agent, { ...input, ownerAgentId: other.agentId }),
      denied('OWNER_MUST_BE_CURRENT_AGENT'),
    );
    const request = await service.create(agent, input);
    assert.equal(
      request.parts[0].document?.status,
      'DRAFT',
      request.parts[0].error || 'Expected a native company draft',
    );
    assert.equal(request.parts[0].canEdit, false);
    const native = await provider.get(request.parts[0].document!.id);
    assert.equal(native.userId, company.nativeUserId);
    assert.equal(native.teamId, company.teamId);
    assert(!native.documentMeta?.redirectUrl, 'Clients must not redirect to the agent Portal');
    assert.equal(native.recipients.length, count + 1);
    assert.equal(
      native.fields.find((field) => field.type === 'TEXT')?.fieldMeta?.text,
      '123 Test Street',
    );
    assert.equal((await service.create(agent, input)).id, request.id);
    for (const action of [
      () => service.detail(other, request.id),
      () =>
        service.download(
          other,
          request.id,
          request.parts[0].id,
          'original',
          native.envelopeItems[0].id,
        ),
      () => service.command(other, request.id, 'remind'),
      () =>
        service.access(other, request.id, request.parts[0].id, 'signer', native.recipients[0].id),
    ])
      await assert.rejects(action, denied('NOT_FOUND'));
    await assert.rejects(
      service.access(agent, request.id, request.parts[0].id, 'editor'),
      denied('PERSONAL_SIGNING_UNAVAILABLE'),
    );
    assert(
      !JSON.stringify(request).includes(native.recipients[0].token),
      'Status never contains recipient tokens',
    );
    // A native create can succeed before the first projection sync fails.
    // Recovering that draft must still require review before any invitation.
    await store.query('UPDATE signing.request_parts SET projection=NULL WHERE request_id=$1', [
      request.id,
    ]);
    await assert.rejects(service.command(agent, request.id, 'send'), denied('REVIEW_REQUIRED'));
    assert.equal((await provider.get(native.id)).status, 'DRAFT');
    const review = await service.review(agent, request.id);
    assert.equal(review.files.length, 2);
    assert(review.files[0].fields.some((f) => f.value === input.values.property_address));
    assert(!JSON.stringify(review).includes('token'));
    await assert.rejects(service.review(other, request.id), denied('NOT_FOUND'));
    await store.query(
      "UPDATE signing.request_parts SET projection=jsonb_set(projection,'{status}','\"PENDING\"') WHERE request_id=$1",
      [request.id],
    );
    await assert.rejects(
      service.command(agent, request.id, 'send', undefined, undefined, '0'.repeat(64)),
      denied('REVIEW_REQUIRED'),
    );
    assert.equal((await provider.get(native.id)).status, 'DRAFT');
    await service.command(agent, request.id, 'send', undefined, undefined, review.reviewHash);
    const sent = await provider.get(native.id);
    assert.equal(sent.status, 'PENDING');
    const ownLink = await service.access(
      agent,
      request.id,
      request.parts[0].id,
      'signer',
      sent.recipients.find((recipient) => recipient.email === agent.verifiedEmails[0])!.id,
    );
    assert(ownLink.url.startsWith(`${nativeUrl}/sign/`));
    await assert.rejects(
      service.access(
        agent,
        request.id,
        request.parts[0].id,
        'signer',
        sent.recipients.find((recipient) => recipient.email.includes('client'))!.id,
      ),
      denied('SIGNER_ACCESS_DENIED'),
    );
    await assert.rejects(service.bundle(other, request.id), denied('NOT_FOUND'));
    await assert.rejects(service.bundle(agent, request.id), denied('SIGNED_PDF_NOT_READY'));
    const completed = await finishSynthetic(native.id);
    const refreshed = await service.refresh(agent, request.id);
    assert.equal(refreshed.category, 'completed');
    const bundle = await service.bundle(agent, request.id);
    const zipped = unzipSync(bundle.bytes);
    const manifest = JSON.parse(Buffer.from(zipped['manifest.json']).toString());
    assert.equal(manifest.files.length, 4);
    for (const file of completed.envelopeItems) {
      const nativeBytes = await provider.document(completed.id, file.id, 'signed');
      const entry = manifest.files.find((entry: { path: string }) =>
        entry.path.endsWith(file.title),
      );
      assert(entry, 'Readable filename retained');
      assert.deepEqual(Buffer.from(zipped[entry.path]), Buffer.from(nativeBytes));
      assert.equal(entry.sha256, sha256(nativeBytes));
    }
    const seed = await service.reissueSeed(agent, request.id);
    const nextKey = randomUUID();
    const replacement = await service.create(agent, {
      ...seed,
      idempotencyKey: nextKey,
      externalReference: `replacement:${nextKey}`,
      reissueReason: 'Synthetic replacement verification',
    });
    assert.equal(replacement.predecessorRequestId, request.id);
    assert(
      replacement.parts.every(
        (p) =>
          p.document?.status === 'DRAFT' &&
          p.document.recipients.every((r) => r.signingStatus === 'NOT_SIGNED'),
      ),
    );
    await assert.rejects(service.reissueSeed(other, request.id), denied('NOT_FOUND'));
    await assert.rejects(
      service.reissueSeed(agent, replacement.id),
      denied('PREVIOUS_REQUEST_STILL_OPEN'),
    );
    const unknownReview = await service.review(agent, replacement.id);
    await store.query(
      "UPDATE signing.request_parts SET delivery_state='unknown' WHERE request_id=$1",
      [replacement.id],
    );
    await assert.rejects(
      service.command(
        agent,
        replacement.id,
        'send',
        undefined,
        undefined,
        unknownReview.reviewHash,
      ),
      denied('SEND_OUTCOME_UNKNOWN'),
    );
    await assert.rejects(
      service.reissueSeed(agent, replacement.id),
      denied('PREVIOUS_REQUEST_STILL_OPEN'),
    );
    // Local synthetic terminal recovery never mutates an executed contract.
    await service.command(agent, replacement.id, 'discard', 'Synthetic draft correction');
    const discardedSeed = await service.reissueSeed(agent, replacement.id);
    const cancelKey = randomUUID();
    const cancelTask = await service.create(agent, {
      ...discardedSeed,
      idempotencyKey: cancelKey,
      externalReference: `cancel:${cancelKey}`,
      reissueReason: 'Synthetic cancelled replacement',
    });
    const cancelReview = await service.review(agent, cancelTask.id);
    await service.command(
      agent,
      cancelTask.id,
      'send',
      undefined,
      undefined,
      cancelReview.reviewHash,
    );
    const expiringDoc = await provider.get(cancelTask.parts[0].document!.id);
    const expiring = expiringDoc.recipients.find((r) => r.email === agent.verifiedEmails[0])!;
    const nativeDb = new BridgeStore(
      'postgres://homix:synthetic-only@127.0.0.1:5569/documenso',
      config.ESIGN_CREDENTIAL_KEY,
    );
    try {
      await nativeDb.query(
        `UPDATE "Recipient" SET "expiresAt"=NOW()-INTERVAL '1 day' WHERE id=$1 AND email=$2`,
        [expiring.id, expiring.email],
      );
    } finally {
      await nativeDb.close();
    }
    const expired = await service.refresh(agent, cancelTask.id);
    assert.equal(expired.category, 'attention');
    assert(expired.parts[0].document?.expired);
    await service.command(agent, cancelTask.id, 'remind');
    const renewed = await provider.get(expiringDoc.id);
    assert(
      Date.parse(renewed.recipients.find((r) => r.id === expiring.id)!.expiresAt!) > Date.now(),
    );
    await assert.rejects(
      service.command(agent, cancelTask.id, 'remind'),
      denied('REMINDER_RECENTLY_REQUESTED'),
    );
    await service.command(agent, cancelTask.id, 'cancel', 'Synthetic cancellation verification');
    const cancelledSeed = await service.reissueSeed(agent, cancelTask.id);
    const rejectKey = randomUUID();
    const rejectTask = await service.create(agent, {
      ...cancelledSeed,
      idempotencyKey: rejectKey,
      externalReference: `reject:${rejectKey}`,
      reissueReason: 'Synthetic decline verification',
    });
    const rejectReview = await service.review(agent, rejectTask.id);
    await service.command(
      agent,
      rejectTask.id,
      'send',
      undefined,
      undefined,
      rejectReview.reviewHash,
    );
    const rejectDoc = await provider.get(rejectTask.parts[0].document!.id);
    const rejecting = [...rejectDoc.recipients].sort(
      (a, b) => (a.signingOrder ?? 1) - (b.signingOrder ?? 1),
    )[0];
    await rpc('recipient.rejectDocumentWithToken', {
      token: rejecting.token,
      documentId: Number(rejectDoc.secondaryId.split('_')[1]),
      reason: 'Synthetic test decline - no contract',
    });
    let rejected = await service.refresh(agent, rejectTask.id);
    for (
      let attempt = 0;
      rejected.parts[0].document?.status !== 'REJECTED' && attempt < 30;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rejected = await service.refresh(agent, rejectTask.id);
    }
    assert.equal(rejected.parts[0].document?.status, 'REJECTED');
    assert.equal((await service.reissueSeed(agent, rejected.id)).predecessorRequestId, rejected.id);
    const recipient = completed.recipients.find((r) => r.email.includes('client'))!;
    for (const file of completed.envelopeItems) {
      const response = await fetch(
        `${nativeUrl}/api/files/token/${recipient.token}/envelopeItem/${file.id}/download/signed`,
      );
      assert(response.ok, 'Clients download completed PDFs without any account/cookie');
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from(await provider.document(completed.id, file.id, 'signed')),
      );
    }
    const catalog = await service.packages(admin);
    const basePackage = catalog.find((p) => p.id === published.id)!;
    const retiredPackage = await service.publish(admin, {
      packageKey: `retired:${count}:${run}`,
      version: 1,
      title: 'Synthetic retirement probe',
      scenario: basePackage.scenario,
      companyKey: basePackage.company_key,
      parts: basePackage.definition.map((p) => ({
        title: p.title,
        templateId: p.templateId,
        roles: p.roles,
        prefill: p.prefill.map((f) => ({
          key: f.key,
          templateFieldId: f.templateFieldId,
          required: f.required,
          label: f.label,
        })),
      })),
    });
    const retireKey = randomUUID();
    const retireDraft = await service.create(agent, {
      ...input,
      packageId: retiredPackage.id,
      idempotencyKey: retireKey,
      externalReference: `retired:${retireKey}`,
    });
    const retireReview = await service.review(agent, retireDraft.id);
    await service.retirePackage(admin, retiredPackage.id);
    await assert.rejects(
      service.command(agent, retireDraft.id, 'send', undefined, undefined, retireReview.reviewHash),
      denied('PACKAGE_RETIRED'),
    );
    await service.command(agent, retireDraft.id, 'discard', 'Synthetic retired draft closure');
    outputs.push({
      count,
      requestId: request.id,
      partId: request.parts[0].id,
      nativeId: native.id,
      packageId: published.id,
    });
  }
  const raw = await app.inject({
    method: 'POST',
    url: '/v1/requests',
    headers: {
      authorization: 'Bearer synthetic-company-package-api-key',
      'x-portal-actor': Buffer.from(
        JSON.stringify({
          agentId: agent.agentId,
          admin: false,
          verifiedEmails: agent.verifiedEmails,
          allowedCompanyKeys: agent.allowedCompanyKeys,
        }),
      ).toString('base64url'),
    },
    payload: {
      scenario: 'custom',
      companyKey: 'homix_realty',
      ownerAgentId: agent.agentId,
      title: 'Forbidden',
      idempotencyKey: randomUUID(),
      externalReference: randomUUID(),
      recipients: [],
    },
  });
  assert.equal(raw.statusCode, 403);
  await writeFile(
    `${directory}/company-stage-one-run.json`,
    JSON.stringify({ run, cases: outputs }, null, 2),
  );
  console.log(
    'PASS: company upload/configure/publish; agent + 1/2 clients complete real signatures; accountless client downloads; ZIP preserves signed bytes; preview/send binding; ownership; idempotency; draft/cancel/decline recovery.',
  );
} finally {
  await app.close();
  await store.close();
}
