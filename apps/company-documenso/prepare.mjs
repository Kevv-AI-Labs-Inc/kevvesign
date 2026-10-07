// Version-locked company email routing; no schema or signing-engine changes.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_COMMIT = '389390c884949fe27c240488a3259da3cdba93e0';
const root = resolve(process.argv[2] || '');
if (
  !process.argv[2] ||
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !==
    UPSTREAM_COMMIT
)
  throw new Error('Expected the pinned official company Documenso 2.18.0 checkout');
const changes = new Map();
function replace(file, before, after) {
  const source = changes.get(file) ?? readFileSync(resolve(root, file), 'utf8');
  if (source.split(before).length !== 2)
    throw new Error(`Source drift or already patched: ${file}`);
  changes.set(file, source.replace(before, after));
}

const settings = 'packages/lib/types/document-email.ts';
replace(
  settings,
  '  .object({\n    recipientSigningRequest:',
  `  .object({
    // Delivery only: the destination must be an existing signer or approver.
    ownerNotificationRecipient: z.string().email().optional(),
    ownerNotificationUrl: z.string().url().max(2000).refine((url) => {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
    }).optional(),
    recipientSigningRequest:`,
);
replace(
  settings,
  '    recipientSigningRequest: false,',
  `    ownerNotificationRecipient: emailSettings.ownerNotificationRecipient,
    ownerNotificationUrl: emailSettings.ownerNotificationUrl,
    recipientSigningRequest: false,`,
);

// The global settings screen lists boolean preferences, never per-envelope routes.
const adminSettings = 'apps/remix/app/components/general/admin-global-settings-section.tsx';
replace(
  adminSettings,
  'const EMAIL_SETTINGS_LABELS: Record<keyof TDocumentEmailSettings, MessageDescriptor> = {',
  "type EmailPreferenceKey = Exclude<keyof TDocumentEmailSettings, 'ownerNotificationRecipient' | 'ownerNotificationUrl'>;\nconst EMAIL_SETTINGS_LABELS: Record<EmailPreferenceKey, MessageDescriptor> = {",
);
replace(adminSettings, 'as (keyof TDocumentEmailSettings)[];', 'as EmailPreferenceKey[];');

const base = 'packages/lib/jobs/definitions/emails/';
for (const name of [
  'send-recipient-signed-email',
  'send-document-completed-emails',
  'send-rejection-emails',
  'send-owner-recipient-expired-email',
]) {
  const file = `${base}${name}.handler.ts`;
  replace(
    file,
    'import { getEmailContext }',
    "import { getNotificationOwner } from '../../../server-only/email/get-notification-owner';\nimport { getEmailContext }",
  );
  if (name === 'send-owner-recipient-expired-email') {
    replace(
      file,
      '  const { documentMeta, user: documentOwner } = envelope;',
      '  const { documentMeta } = envelope;\n  const documentOwner = await getNotificationOwner(envelope);',
    );
    replace(
      file,
      '  const documentLink = `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(envelope.team.url)}/${envelope.id}`;',
      '  const documentLink = documentOwner.documentUrl ?? `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(envelope.team.url)}/${envelope.id}`;',
    );
  } else if (name === 'send-rejection-emails') {
    replace(
      file,
      '  const { user: documentOwner } = envelope;',
      '  const documentOwner = await getNotificationOwner(envelope);',
    );
    replace(
      file,
      '      documentUrl: `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(envelope.team?.url)}/${envelope.id}`,',
      '      documentUrl: documentOwner.documentUrl ?? `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(envelope.team?.url)}/${envelope.id}`,',
    );
  } else {
    replace(
      file,
      '  const { user: owner } = envelope;',
      '  const owner = await getNotificationOwner(envelope);',
    );
  }
  if (name === 'send-document-completed-emails') {
    replace(
      file,
      '  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);',
      '  documentOwnerDownloadLink = owner.documentUrl ?? documentOwnerDownloadLink;\n\n  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);',
    );
    replace(
      file,
      '          recipientId: owner.id,',
      '          recipientId: owner.recipientId ?? owner.id,',
    );
    replace(
      file,
      "          recipientRole: 'OWNER',",
      "          recipientRole: owner.recipientRole ?? 'OWNER',",
    );
  }
}
// Corresponding source is supplied by build-image.mjs at this public URL.
const rootRoute = 'apps/remix/app/root.tsx';
replace(
  rootRoute,
  '        <Scripts nonce={nonce(cspNonce)} />',
  '        <a href="/company-signing-source.tar.gz" className="block p-2 text-center text-xs text-muted-foreground underline">Source code (AGPL)</a>\n        <Scripts nonce={nonce(cspNonce)} />',
);

// Fail on every unexpected upstream anchor before writing anything.
for (const [file, source] of changes) writeFileSync(resolve(root, file), source);
cpSync(resolve(dirname(fileURLToPath(import.meta.url)), 'overlay'), root, { recursive: true });
process.stdout.write(`Prepared company notification routing for ${UPSTREAM_COMMIT}\n`);
