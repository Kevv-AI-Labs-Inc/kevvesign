// Execute the pinned, patched upstream handlers with fake DB/SMTP only.
// No customer document, live credential, network request or email is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod-native';

if (!process.argv[2]) throw new Error('Pass an explicit prepared upstream source checkout');
const source = resolve(process.argv[2]);
const emailRoot = 'packages/lib/jobs/definitions/emails/';
const handlers = [
  'send-recipient-signed-email',
  'send-document-completed-emails',
  'send-rejection-emails',
  'send-owner-recipient-expired-email',
];
const route = {
  ownerNotificationRecipient: 'agent@example.invalid',
  ownerNotificationUrl: 'https://portal.example.invalid/signing/request-qa',
};
let state;
function fixture(routed) {
  const recipients = [
    {
      id: 10,
      email: 'agent@example.invalid',
      name: 'Agent',
      role: 'APPROVER',
      token: 'fake-agent-token',
    },
    {
      id: 11,
      email: 'client@example.invalid',
      name: 'Client',
      role: 'SIGNER',
      token: 'fake-client-token',
      rejectionReason: 'QA only',
    },
  ];
  return {
    recipients,
    sent: [],
    envelope: {
      id: 'qa',
      title: 'QA only',
      internalVersion: 2,
      user: { id: 7, name: 'Company', email: 'admin@example.invalid', disabled: false },
      teamId: 1,
      team: { id: 1, url: 'qa' },
      recipients,
      envelopeItems: [{ title: 'QA', documentData: {} }],
      documentMeta: { distributionMethod: 'EMAIL', emailSettings: routed ? route : {} },
    },
  };
}
const sendMail = async (mail) => {
  state.sent.push(mail);
};
const envelopeRead = async (query) => ({
  ...state.envelope,
  recipients: query.include?.recipients?.where?.id
    ? state.recipients.filter((r) => r.id === query.include.recipients.where.id)
    : state.recipients,
});
const recipientRead = async (query) => state.recipients.find((r) => r.id === query.where.id);
const prisma = {
  envelope: { findFirst: envelopeRead, findUnique: envelopeRead, findFirstOrThrow: envelopeRead },
  recipient: {
    findFirst: recipientRead,
    findFirstOrThrow: recipientRead,
    findMany: async (query) => {
      assert.equal(query.where.envelopeId, state.envelope.id);
      return state.recipients;
    },
    update: async () => {},
  },
  documentAuditLog: { create: async () => {} },
};
function load(file) {
  const exports = {};
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  function require(name) {
    if (
      name.endsWith('get-notification-owner') ||
      name.endsWith('notification-recipient') ||
      name.endsWith('types/document-email')
    )
      return load(resolve(dirname(file), name + '.ts'));
    if (name === 'zod') return { z };
    if (name === '@documenso/prisma') return { prisma };
    if (name === '@documenso/email/mailer') return { mailer: { sendMail } };
    if (name.startsWith('@documenso/email/templates/'))
      return new Proxy({}, { get: (_target, key) => (key === '__esModule' ? true : () => null) });
    if (name === '@prisma/client')
      return {
        EnvelopeType: { DOCUMENT: 'DOCUMENT' },
        DocumentSource: { TEMPLATE_DIRECT_LINK: 'DIRECT' },
        RecipientRole: { CC: 'CC' },
        SigningStatus: { REJECTED: 'REJECTED' },
        SendStatus: { SENT: 'SENT' },
        DocumentDistributionMethod: { EMAIL: 'EMAIL' },
      };
    if (name === '@lingui/core/macro')
      return {
        msg: (strings, ...values) => strings.reduce((s, p, i) => s + p + (values[i] ?? ''), ''),
      };
    if (name === 'react') return { createElement: (_component, props) => props };
    if (name.endsWith('i18n-server'))
      return { getI18nInstance: async () => ({ _: (value) => value }) };
    if (name.endsWith('constants/app'))
      return { NEXT_PUBLIC_WEBAPP_URL: () => 'https://esign.example.invalid' };
    if (name.endsWith('constants/email'))
      return { DOCUMENSO_INTERNAL_EMAIL: { address: 'system@example.invalid' } };
    if (name.endsWith('get-email-context'))
      return {
        getEmailContext: async () => ({
          emailLanguage: 'en',
          emailTransport: { sendMail },
          emailsDisabled: false,
          senderEmail: { address: 'system@example.invalid' },
        }),
      };
    if (name.endsWith('assert-organisation-rates-and-limits'))
      return { assertOrganisationRatesAndLimits: async () => {} };
    if (name.endsWith('types/document-audit-logs'))
      return { DOCUMENT_AUDIT_LOG_TYPE: { EMAIL_SENT: 'EMAIL_SENT' } };
    if (name.endsWith('utils/document-audit-logs'))
      return { createDocumentAuditLogData: (value) => value };
    if (name.endsWith('get-file.server'))
      return { getFileServerSide: async () => Buffer.from('%PDF-QA only') };
    if (name.endsWith('utils/envelope'))
      return { unsafeBuildEnvelopeIdQuery: () => ({ id: 'qa' }) };
    if (name.endsWith('utils/recipients'))
      return { isRecipientEmailValidForSending: (recipient) => Boolean(recipient.email) };
    if (name.endsWith('render-email-with-i18n'))
      return { renderEmailWithI18N: async (props) => JSON.stringify(props) };
    if (name.endsWith('render-custom-email-template'))
      return { renderCustomEmailTemplate: (value) => value };
    if (name.endsWith('utils/teams')) return { formatDocumentsPath: () => '/t/qa/documents' };
    throw new Error('Unmocked dependency: ' + name);
  }
  runInNewContext(output, { exports, require, Buffer, URL }, { filename: file });
  return exports;
}
const deliveredTo = () =>
  state.sent
    .flatMap((m) => (Array.isArray(m.to) ? m.to.map((r) => r.address) : [m.to.address]))
    .sort();
for (const name of handlers) {
  const handler = load(resolve(source, emailRoot + name + '.handler.ts'));
  for (const routed of [false, true]) {
    state = fixture(routed);
    await handler.run({
      payload: { documentId: 'qa', envelopeId: 'qa', recipientId: 11, requestMetadata: {} },
      io: { runTask: async (_name, fn) => fn(), logger: { warn() {} } },
    });
    const owner = routed ? 'agent@example.invalid' : 'admin@example.invalid';
    const expected =
      name === 'send-document-completed-emails'
        ? routed
          ? ['agent@example.invalid', 'client@example.invalid']
          : ['admin@example.invalid', 'agent@example.invalid', 'client@example.invalid']
        : name === 'send-rejection-emails'
          ? [owner, 'client@example.invalid'].sort()
          : [owner];
    assert.deepEqual(deliveredTo(), expected, `${name}, routed=${routed}`);
    if (routed && name !== 'send-recipient-signed-email') {
      const agentMail = state.sent.find((m) =>
        (Array.isArray(m.to) ? m.to : [m.to]).some((r) => r.address === 'agent@example.invalid'),
      );
      assert(
        agentMail.html.includes(route.ownerNotificationUrl),
        `${name}: return agent to Portal`,
      );
      assert(!agentMail.html.includes('/t/qa/documents'), `${name}: no administrator-only link`);
    }
  }
  if (name === 'send-recipient-signed-email') {
    state = fixture(true);
    await handler.run({
      payload: { documentId: 'qa', recipientId: 10 },
      io: { runTask: async (_name, fn) => fn() },
    });
    assert.equal(state.sent.length, 0, 'The agent does not get a notice about their own approval');
  }
  state = fixture(true);
  state.recipients = state.recipients.filter((r) => r.id !== 10);
  await assert.rejects(
    () =>
      handler.run({
        payload: { documentId: 'qa', envelopeId: 'qa', recipientId: 11 },
        io: { runTask: async (_name, fn) => fn() },
      }),
    /NOTIFICATION_RECIPIENT_NOT_BOUND/,
  );
  assert.equal(
    state.sent.length,
    0,
    'A removed notification recipient must not leak an admin copy',
  );
}
console.log(
  'PASS: four real upstream mail handlers route only to the bound agent, preserve HR, de-duplicate completion and fail closed; no emails sent.',
);
