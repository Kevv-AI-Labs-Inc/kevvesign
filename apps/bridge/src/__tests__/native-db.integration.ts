import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BridgeStore } from '../store.js';
import { loadBridgeConfig, type Principal } from '../config.js';
import { Documenso, sha256 } from '../documenso.js';
import { SigningService } from '../service.js';
import { BridgeError } from '../model.js';
import { buildServer } from '../server.js';
import { webhookSecret } from '../auth.js';

const url = process.env.ESIGN_DATABASE_URL;
if (
  url !== 'postgres://homix:synthetic-only@127.0.0.1:5569/homix_signing_bridge_integration' ||
  process.env.DOCUMENSO_BASE_URL !== 'http://localhost:3469'
)
  throw new Error('This test requires the isolated Homix synthetic databases');
const directory = process.env.HOMIX_QA_DIRECTORY;
if (!directory?.startsWith('/private/tmp/homix-documenso-integration'))
  throw new Error('Private synthetic fixture directory required');
const fixture = JSON.parse(await readFile(`${directory}/fixtures.json`, 'utf8')) as {
  admin: { email: string };
  connections: Array<{
    scope: string;
    nativeUserId: number;
    email: string;
    teamId: number;
    teamUrl: string;
    token: string;
  }>;
};
if (fixture.connections.some((c) => !c.email.endsWith('@example.invalid')))
  throw new Error('Only synthetic recipients are permitted');
const secret = 'synthetic-test-portal-api-key-never-production';
const config = loadBridgeConfig({
  NODE_ENV: 'test',
  ESIGN_DATABASE_URL: url,
  DOCUMENSO_BASE_URL: process.env.DOCUMENSO_BASE_URL,
  ESIGN_CREDENTIAL_KEY: '34'.repeat(32),
  ESIGN_PORTAL_CLIENTS_JSON: JSON.stringify([
    { id: 'homix-test', keyHash: sha256(secret), portalOrigin: 'http://localhost:3000' },
  ]),
  ESIGN_WEBHOOK_SECRET: 'synthetic-webhook-secret-never-use-production',
});
const store = new BridgeStore(url, config.ESIGN_CREDENTIAL_KEY),
  service = new SigningService(store, config);
const admin: Principal = {
  clientId: 'homix-test',
  agentId: 900,
  admin: true,
  verifiedEmails: [fixture.admin.email],
  portalOrigin: 'http://localhost:3000',
};
const customers = fixture.connections.filter((c) => c.scope === 'customer');
const actors = customers.map((c, i) => ({
  ...admin,
  agentId: i + 1,
  admin: false,
  verifiedEmails: [c.email],
}));
const run = randomUUID();

// A tiny, valid synthetic fixture PDF. It is never used as a company contract.
function pdf(text: string) {
  const stream = `BT /F1 20 Tf 50 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n',
    offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const offset = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(result);
}
const files = [
  {
    name: 'Synthetic QA - not a legal contract.pdf',
    bytes: pdf('SYNTHETIC QA ONLY - NOT A CONTRACT'),
  },
  { name: 'Synthetic QA second document.pdf', bytes: pdf('SECOND SYNTHETIC DOCUMENT') },
];
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  await store.migrate();
  for (const [index, upstream] of fixture.connections.entries()) {
    const ownerAgentId =
      upstream.scope === 'customer' ? customers.indexOf(upstream) + 1 : undefined;
    const exists = await service.connections(admin);
    if (
      exists.some(
        (c) =>
          c.scope === upstream.scope &&
          (ownerAgentId ? c.ownerAgentId === ownerAgentId : c.companyKey === 'homix_realty') &&
          !c.revokedAt,
      )
    )
      continue;
    const provider = new Documenso(config.DOCUMENSO_BASE_URL, upstream.token);
    const proofId = await provider.create(
      {
        title: `Synthetic connection proof ${index}`,
        type: 'DOCUMENT',
        delegatedDocumentOwner: upstream.email,
        visibility: 'ADMIN',
        externalId: `qa-proof:${run}:${index}`,
      },
      [files[0]],
    );
    const proof = await provider.get(proofId);
    assert.equal(proof.userId, upstream.nativeUserId, 'actual native owner is the delegated agent');
    await service.registerConnection(admin, {
      scope: upstream.scope,
      ownerAgentId,
      companyKey: ownerAgentId ? undefined : 'homix_realty',
      verifiedEmails: [upstream.email],
      token: upstream.token,
      proofEnvelopeId: proofId,
      isolationConfirmed: true,
      isolationNotes:
        'Synthetic fixture uses separate non-inheriting member teams and a private HR team.',
    });
  }
  console.log('PASS: native delegated owners and team-scoped connections');
  const hr = fixture.connections.find((c) => c.scope === 'company')!;
  const provider = new Documenso(config.DOCUMENSO_BASE_URL, hr.token);
  const templateId = await provider.create(
    {
      title: `Synthetic package template ${run}`,
      type: 'TEMPLATE',
      visibility: 'ADMIN',
      recipients: [
        {
          name: 'First buyer',
          email: 'qa-buyer-a@example.invalid',
          role: 'SIGNER',
          signingOrder: 1,
          fields: [
            {
              identifier: 0,
              type: 'SIGNATURE',
              page: 1,
              positionX: 10,
              positionY: 55,
              width: 30,
              height: 8,
              fieldMeta: { type: 'signature', required: true },
            },
            {
              identifier: 1,
              type: 'TEXT',
              page: 1,
              positionX: 10,
              positionY: 30,
              width: 60,
              height: 5,
              fieldMeta: { type: 'text', label: 'Property', readOnly: true, required: true },
            },
          ],
        },
        {
          name: 'Co buyer',
          email: 'qa-buyer-b@example.invalid',
          role: 'SIGNER',
          signingOrder: 1,
          fields: [
            {
              identifier: 1,
              type: 'SIGNATURE',
              page: 1,
              positionX: 10,
              positionY: 55,
              width: 30,
              height: 8,
              fieldMeta: { type: 'signature', required: true },
            },
          ],
        },
      ],
      meta: { signingOrder: 'PARALLEL', distributionMethod: 'EMAIL', timezone: 'America/New_York' },
    },
    files,
  );
  const template = await provider.get(templateId);
  const published = await service.publish(admin, {
    packageKey: `qa-${run}`,
    version: 1,
    title: 'Synthetic buyer package',
    scenario: 'buyer',
    companyKey: 'homix_realty',
    selectors: {},
    parts: [
      {
        title: 'Synthetic documents',
        templateId,
        roles: template.recipients.map((r, i) => ({
          key: `buyer_${i}`,
          templateRecipientId: r.id,
          actor: 'customer',
          label: r.name,
        })),
        prefill: [
          {
            key: 'property',
            templateFieldId: template.fields.find((f) => f.type === 'TEXT')!.id,
            required: true,
            label: 'Property address',
          },
        ],
      },
    ],
  });
  const input = {
    title: `Synthetic buyer request ${run}`,
    idempotencyKey: `qa-${run}`,
    externalReference: `qa:${run}`,
    scenario: 'buyer',
    packageId: published.id,
    companyKey: 'homix_realty',
    ownerAgentId: 1,
    business: { customer: 'Synthetic buyers', property: '123 Synthetic QA Street', reference: run },
    recipients: template.recipients.map((r, i) => ({
      key: `buyer_${i}`,
      name: r.name,
      email: r.email,
    })),
    values: { property: '123 Synthetic QA Street' },
  };
  const preview = await service.preview(actors[0], input);
  assert.equal(preview.parts[0].files.length, 2);
  const request = await service.create(actors[0], input);
  assert.equal(request.parts.length, 1);
  assert.equal(
    request.parts[0].document?.status,
    'DRAFT',
    request.parts[0].error || 'native draft not created',
  );
  assert.equal(request.parts[0].document.files.length, 2);
  assert.equal(request.parts[0].document.recipients.length, 2);
  const again = await service.create(actors[0], input);
  assert.equal(again.id, request.id);
  assert.equal(
    again.parts[0].document?.id,
    request.parts[0].document.id,
    'repeat creates no second upstream document',
  );
  await assert.rejects(
    service.create(actors[0], { ...input, title: 'Changed' }),
    (e) => e instanceof BridgeError && e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    service.detail(actors[1], request.id),
    (e) => e instanceof BridgeError && e.status === 404,
  );
  await assert.rejects(
    service.detail({ ...actors[0], clientId: 'another-portal' }, request.id),
    (e) => e instanceof BridgeError && e.status === 404,
  );
  const native = await new Documenso(config.DOCUMENSO_BASE_URL, customers[0].token).get(
    request.parts[0].document.id,
  );
  assert.equal(native.userId, customers[0].nativeUserId);
  assert.equal(native.teamId, customers[0].teamId);
  assert.equal(
    native.fields.find((f) => f.type === 'TEXT')?.fieldMeta?.text,
    '123 Synthetic QA Street',
  );
  assert.equal(native.fields.find((f) => f.type === 'TEXT')?.fieldMeta?.readOnly, true);
  assert.equal(new Set(native.fields.map((f) => f.envelopeItemId)).size, 2);
  const editor = await service.access(actors[0], request.id, request.parts[0].id, 'editor');
  assert.equal(
    editor.url,
    `http://localhost:3469/t/${customers[0].teamUrl}/documents/${native.id}/edit`,
  );
  assert.ok(!JSON.stringify(request).includes('token'));
  assert.ok(!JSON.stringify(request).includes(native.recipients[0].token));
  await assert.rejects(
    service.download(
      actors[0],
      request.id,
      request.parts[0].id,
      'signed',
      native.envelopeItems[0].id,
    ),
  );
  const original = await service.download(
    actors[0],
    request.id,
    request.parts[0].id,
    'original',
    native.envelopeItems[0].id,
  );
  assert.equal(original.subarray(0, 5).toString(), '%PDF-');
  console.log(
    'PASS: real multi-file template, repeat-safe creation, delegation, field prefill, exact editor, API isolation and completion-file gate',
  );
  const sent = await service.command(actors[0], request.id, 'send');
  assert.equal(sent.parts[0].document?.status, 'PENDING');
  const repeatedSend = await service.command(actors[0], request.id, 'send');
  assert.equal(repeatedSend.parts[0].document?.id, native.id);
  await assert.rejects(
    service.access(actors[0], request.id, request.parts[0].id, 'signer', native.recipients[0].id),
    (e) => e instanceof BridgeError && e.status === 403,
  );
  const syntheticRecipient = { ...actors[0], verifiedEmails: [native.recipients[0].email] };
  const resumeA = await service.access(
    syntheticRecipient,
    request.id,
    request.parts[0].id,
    'signer',
    native.recipients[0].id,
  );
  const resumeB = await service.access(
    syntheticRecipient,
    request.id,
    request.parts[0].id,
    'signer',
    native.recipients[0].id,
  );
  assert.equal(resumeA.url, resumeB.url, 'native resume link remains stable across visits');
  const connection = (await service.connections(admin)).find((c) => c.ownerAgentId === 1)!;
  app = await buildServer(config, service);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests' })).statusCode, 401);
  const body = {
    event: 'DOCUMENT_SENT',
    payload: {
      envelopeId: native.id,
      externalId: native.externalId,
      teamId: native.teamId,
      userId: native.userId,
    },
    createdAt: new Date().toISOString(),
  };
  const webhookPath = `/webhooks/documenso/${connection.id}`;
  assert.equal(
    (await app.inject({ method: 'POST', url: webhookPath, payload: body })).statusCode,
    401,
  );
  const headers = { 'x-documenso-secret': webhookSecret(config, String(connection.id)) };
  assert.equal(
    (await app.inject({ method: 'POST', url: webhookPath, payload: body, headers })).statusCode,
    202,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: webhookPath,
        payload: { ...body, createdAt: new Date(Date.now() + 1000).toISOString() },
        headers,
      })
    ).statusCode,
    202,
  );
  const inbox = await store.query<{ count: string }>(
    'SELECT count(*) AS count FROM signing.webhook_inbox WHERE provider_id=$1',
    [native.id],
  );
  assert.equal(inbox[0].count, '1');
  await service.reconcile();
  console.log(
    'PASS: real distribution, safe repeated send, own-email resume authorization and durable webhook retry dedupe',
  );
  await writeFile(
    `${directory}/native-request-${run}.json`,
    JSON.stringify(
      {
        requestId: request.id,
        packageId: published.id,
        templateId,
        editorUrl: editor.url,
        nativeId: native.id,
        recipients: native.recipients.map((r) => ({
          id: r.id,
          email: r.email,
          signingUrl: `http://localhost:3469/sign/${r.token}`,
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Synthetic browser follow-up saved for request ${request.id}. Signing, sealing, native UI isolation and final PDFs still require browser verification.`,
  );
} finally {
  if (app) await app.close();
  await store.close();
}
