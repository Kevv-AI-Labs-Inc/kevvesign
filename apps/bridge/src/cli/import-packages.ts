import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { importContext } from './import-context.js';
import { canonical, sha256, type NativeEnvelope } from '../documenso.js';
import { key } from '../model.js';

const manifestSchema = z.object({
  format: z.literal('homix-documenso-import-v1'),
  packages: z
    .array(
      z.object({
        packageKey: key,
        version: z.number().int().positive().max(2147483647),
        title: z.string().min(1),
        scenario: z.enum(['onboarding', 'team_leader']),
        companyKey: key,
        selectors: z.record(key, z.string()),
        file: z.object({
          path: z.string(),
          name: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          pages: z.number().int().positive(),
        }),
        fields: z
          .array(
            z.object({
              key,
              actor: z.enum(['owner', 'company']),
              mergeKey: key.optional(),
              required: z.boolean(),
              label: z.string(),
              native: z.object({
                identifier: z.literal(0),
                type: z.enum(['TEXT', 'DATE', 'SIGNATURE', 'INITIALS', 'CHECKBOX']),
                page: z.number().int().positive(),
                positionX: z.number().min(0).max(100),
                positionY: z.number().min(0).max(100),
                width: z.number().positive().max(100),
                height: z.number().positive().max(100),
                fieldMeta: z.record(z.string(), z.unknown()),
              }),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
type ImportPackage = z.infer<typeof manifestSchema>['packages'][number];
type State = Record<
  string,
  { hash: string; started: boolean; templateId?: string; packageId?: string }
>;
function nativeFieldFor(document: NativeEnvelope, field: ImportPackage['fields'][number]) {
  const expectedOrder = field.actor === 'owner' ? 1 : 2;
  const matches = document.fields.filter(
    (candidate) =>
      candidate.fieldMeta?.label === field.label &&
      candidate.type === field.native.type &&
      candidate.page === field.native.page &&
      document.recipients.find((r) => r.id === candidate.recipientId)?.signingOrder ===
        expectedOrder &&
      (['positionX', 'positionY', 'width', 'height'] as const).every(
        (coordinate) => Math.abs(candidate[coordinate] - field.native[coordinate]) <= 0.03,
      ),
  );
  if (matches.length !== 1) throw new Error(`Native role/field placement mismatch: ${field.key}`);
  return matches[0];
}
function verifyNativeFields(document: NativeEnvelope, input: ImportPackage) {
  if (
    document.type !== 'TEMPLATE' ||
    document.fields.length !== input.fields.length ||
    document.recipients.length !== 2
  )
    throw new Error(`Native template changed: ${input.packageKey}`);
  const matched = new Set<number>();
  for (const field of input.fields) {
    const native = nativeFieldFor(document, field);
    if (matched.has(native.id))
      throw new Error(`Two source fields mapped to one native field: ${field.key}`);
    matched.add(native.id);
    if (field.mergeKey && native.fieldMeta?.readOnly !== true)
      throw new Error(`Native business field must be readonly: ${field.key}`);
    // Upstream may supply extra defaults; every explicit approved setting must survive import.
    for (const [key, value] of Object.entries(field.native.fieldMeta))
      if (canonical(native.fieldMeta?.[key]) !== canonical(value))
        throw new Error(`Native field setting changed: ${field.key}:${key}`);
  }
}

async function main() {
  const filename = process.env.HOMIX_PACKAGE_MANIFEST;
  if (!filename) throw new Error('HOMIX_PACKAGE_MANIFEST is required');
  const manifestPath = path.resolve(filename),
    checkpointPath = `${manifestPath}.state.local.json`;
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const selected = manifest.packages.filter(
    (p) => !process.env.HOMIX_IMPORT_COMPANY || p.companyKey === process.env.HOMIX_IMPORT_COMPANY,
  );
  if (!selected.length) throw new Error('No matching company packages');
  const files = new Map<string, Buffer>();
  for (const p of selected) {
    const bytes = await readFile(path.resolve(path.dirname(manifestPath), p.file.path));
    if (sha256(bytes) !== p.file.sha256 || bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new Error(`Approved PDF hash mismatch: ${p.file.name}`);
    for (const f of p.fields)
      if (
        f.native.page > p.file.pages ||
        f.native.positionX + f.native.width > 100.03 ||
        f.native.positionY + f.native.height > 100.03
      )
        throw new Error(`Invalid approved field geometry: ${f.key}`);
    files.set(`${p.packageKey}:${p.version}`, bytes);
  }
  if (!process.argv.includes('--publish')) {
    console.log(
      `Validated ${selected.length} approved package definitions. Use --publish to import templates and publish; this command never sends invitations.`,
    );
    return;
  }
  const context = await importContext();
  let state: State = {};
  try {
    state = JSON.parse(await readFile(checkpointPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const save = () =>
    writeFile(checkpointPath, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
    });
  try {
    const connections = await context.connections();
    for (const company of new Set(selected.map((p) => p.companyKey)))
      if (!connections.some((c) => c.company_key === company))
        throw new Error(`Connect the verified private HR team first: ${company}`);
    for (const input of selected) {
      const stateKey = `${input.packageKey}:${input.version}`,
        hash = sha256(canonical(input));
      if (state[stateKey] && state[stateKey].hash !== hash)
        throw new Error(`Import changed under an existing version: ${stateKey}`);
      const connection = connections.find((c) => c.company_key === input.companyKey)!,
        provider = context.provider(connection);
      const externalId = `homix-import:${context.clientId}:${stateKey}`;
      let templateId = state[stateKey]?.templateId;
      if (!templateId) {
        const found: string[] = [];
        for (let page = 1; ; page++) {
          const result = await provider.list({ type: 'TEMPLATE', page });
          found.push(
            ...result.data.filter((item) => item.externalId === externalId).map((item) => item.id),
          );
          if (page >= result.totalPages) break;
        }
        if (found.length > 1)
          throw new Error(`Duplicate native template needs review: ${stateKey}`);
        templateId = found[0];
        if (!templateId && state[stateKey]?.started)
          throw new Error(
            `Prior native creation outcome is uncertain; review ${externalId} before retrying. No duplicate will be created.`,
          );
        if (!templateId) {
          state[stateKey] = { hash, started: true };
          await save();
          templateId = await provider.create(
            {
              title: input.title,
              type: 'TEMPLATE',
              visibility: 'ADMIN',
              externalId,
              recipients: ['owner', 'company'].map((actor, index) => ({
                name: actor === 'owner' ? 'Agent' : 'Company Broker',
                email:
                  actor === 'owner'
                    ? 'template-recipient@example.invalid'
                    : connection.native_email,
                role: 'SIGNER',
                signingOrder: index + 1,
                fields: input.fields.filter((f) => f.actor === actor).map((f) => f.native),
              })),
              meta: {
                signingOrder: 'SEQUENTIAL',
                distributionMethod: 'EMAIL',
                timezone: 'America/New_York',
                dateFormat: 'yyyy-MM-dd',
                language: 'en',
                typedSignatureEnabled: true,
                drawSignatureEnabled: true,
                uploadSignatureEnabled: true,
              },
            },
            [{ name: input.file.name, bytes: files.get(stateKey)! }],
          );
        }
        state[stateKey] = { hash, started: true, templateId };
        await save();
      }
      const native = await provider.get(templateId);
      verifyNativeFields(native, input);
      if (
        native.envelopeItems.length !== 1 ||
        sha256(await provider.document(native.id, native.envelopeItems[0].id, 'original')) !==
          input.file.sha256
      )
        throw new Error(`Native original differs from the approved PDF: ${stateKey}`);
      const existing = (await context.packages()).find(
        (p) => p.package_key === input.packageKey && p.version === input.version,
      );
      if (
        existing &&
        (existing.definition.length !== 1 || existing.definition[0].templateId !== native.id)
      )
        throw new Error(`Published version points to another template: ${stateKey}`);
      const published =
        existing ||
        (await context.publish({
          packageKey: input.packageKey,
          version: input.version,
          title: input.title,
          scenario: input.scenario,
          companyKey: input.companyKey,
          selectors: input.selectors,
          parts: [
            {
              title: input.title,
              templateId: native.id,
              roles: native.recipients.map((r) => ({
                key: r.signingOrder === 1 ? 'agent' : 'company',
                actor: r.signingOrder === 1 ? 'owner' : 'company',
                templateRecipientId: r.id,
                label: r.signingOrder === 1 ? 'Agent' : 'Company Broker',
              })),
              prefill: input.fields
                .filter((f) => f.mergeKey)
                .map((f) => ({
                  key: f.mergeKey,
                  templateFieldId: nativeFieldFor(native, f).id,
                  required: f.required,
                  label: f.label,
                })),
            },
          ],
        }));
      state[stateKey] = {
        hash,
        started: true,
        templateId,
        packageId: published.id,
      };
      await save();
      console.log(`Verified and published ${stateKey}`);
    }
  } finally {
    await context.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Package import failed');
  process.exitCode = 1;
});
