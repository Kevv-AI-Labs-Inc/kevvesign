import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PNG } from 'pngjs';
import {
  HmacManifestSigner,
  JsonFileRepository,
  LocalEmailPort,
  LocalObjectStore,
  completedFieldDisplayValue,
  inspectPdf,
  renderCompletedPdf,
  signWebhook,
  verifyWebhook,
} from './index';
import { seedState } from '@esign/domain';

describe('local durable substitutes', () => {
  it('persists state atomically and keeps objects private', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-infra-'));
    const repository = new JsonFileRepository(path.join(root, 'state.json'), seedState);
    await repository.write(
      (state) =>
        (state.idempotency.test = { requestHash: 'a', response: { ok: true }, createdAt: 'now' }),
    );
    await expect(repository.read((state) => state.idempotency.test?.response)).resolves.toEqual({
      ok: true,
    });
    const objects = new LocalObjectStore(path.join(root, 'objects'));
    await objects.put('templates/workspace/file.pdf', Uint8Array.of(1, 2, 3), 'application/pdf');
    expect(Array.from(await objects.get('templates/workspace/file.pdf'))).toEqual([1, 2, 3]);
    await expect(objects.put('../escape', Uint8Array.of(1), 'x')).rejects.toThrow(
      'Object key is invalid',
    );
  });

  it('migrates legacy Portal launch state into the provider-neutral collection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-state-migration-'));
    const stateFile = path.join(root, 'state.json');
    const legacy = seedState() as unknown as Record<string, unknown>;
    delete legacy.integrationLaunchSessions;
    legacy.portalLaunchSessions = [];
    await writeFile(stateFile, JSON.stringify(legacy));

    const repository = new JsonFileRepository(stateFile, seedState);
    await expect(repository.read((state) => state.integrationLaunchSessions)).resolves.toEqual([]);
  });

  it('migrates legacy application clients without a business domain as fail-closed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-client-domain-migration-'));
    const stateFile = path.join(root, 'state.json');
    const legacy = seedState() as unknown as Record<string, unknown>;
    legacy.applicationClients = [
      {
        id: crypto.randomUUID(),
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: 'Legacy integration',
        secretHash: 'a'.repeat(64),
        scopes: ['templates:read'],
        status: 'ACTIVE',
        createdAt: '2026-08-12T12:00:00.000Z',
      },
    ];
    await writeFile(stateFile, JSON.stringify(legacy));

    const repository = new JsonFileRepository(stateFile, seedState);
    await expect(
      repository.read((state) => state.applicationClients[0]?.businessDomains),
    ).resolves.toEqual([]);
  });

  it('writes local email outbox without invoking a provider', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'esign-email-'));
    const email = new LocalEmailPort(root);
    const sent = await email.send({
      to: 'person@example.test',
      subject: 'Sign',
      text: 'body',
      html: '<p>body</p>',
      tags: {},
    });
    const stored = JSON.parse(
      await readFile(path.join(root, `${sent.messageId}.json`), 'utf8'),
    ) as { to: string };
    expect(stored.to).toBe('person@example.test');
  });
});

describe('PDF and signatures', () => {
  it('renders read-only merge values from the recipient snapshot', () => {
    const fieldId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const envelope = {
      fields: [
        {
          id: fieldId,
          roleId: null,
          readOnly: true,
          type: 'merge',
          label: 'Summary: Team cap',
        },
      ],
      recipients: [{ roleId, values: { [fieldId]: 'No cap' } }],
    } as unknown as Parameters<typeof completedFieldDisplayValue>[0];

    expect(completedFieldDisplayValue(envelope, fieldId)).toBe('Team cap: No cap');
  });

  it('renders typed initials instead of the full adopted signature', () => {
    const fieldId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const envelope = {
      fields: [{ id: fieldId, roleId, readOnly: false, type: 'initials', label: 'Initials' }],
      recipients: [
        {
          roleId,
          values: {},
          signature: { kind: 'typed', value: 'Homix Geometry UAT Agent' },
        },
      ],
    } as unknown as Parameters<typeof completedFieldDisplayValue>[0];

    expect(completedFieldDisplayValue(envelope, fieldId)).toBe('HGUA');
  });

  it('renders checked checkboxes with a WinAnsi-safe mark', async () => {
    const fieldId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const source = await pdf.save();
    const envelope = {
      id: crypto.randomUUID(),
      subject: 'Checkbox finalization test',
      fields: [
        {
          id: fieldId,
          documentId,
          page: 1,
          type: 'checkbox',
          roleId,
          label: 'Acknowledgement',
          required: true,
          readOnly: false,
          rect: { x: 0.1, y: 0.1, width: 0.05, height: 0.05, rotation: 0 },
        },
      ],
      recipients: [
        {
          roleId,
          name: 'UAT Signer',
          email: 'uat@example.test',
          status: 'COMPLETED',
          values: { [fieldId]: true },
        },
      ],
    } as unknown as Parameters<typeof renderCompletedPdf>[1];

    expect(completedFieldDisplayValue(envelope, fieldId)).toBe('X');
    const completed = await renderCompletedPdf(source, envelope, documentId);
    await expect(inspectPdf(completed)).resolves.toMatchObject({ pageCount: 2 });
  });

  it('accepts a valid PDF and rejects non-PDF bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    await expect(inspectPdf(bytes)).resolves.toMatchObject({ pageCount: 1, hasXfa: false });
    await expect(inspectPdf(Buffer.from('not pdf'))).rejects.toThrow('not a valid PDF');
  });

  it('signs and verifies manifests and replay-bounded webhooks', async () => {
    const signer = new HmacManifestSigner('a-secret-longer-than-thirty-two-characters');
    const bytes = Buffer.from('{"ok":true}');
    const signed = await signer.sign(bytes);
    await expect(signer.verify(bytes, signed.signature, signed.keyId)).resolves.toBe(true);
    await expect(
      signer.verify(Buffer.from('tampered'), signed.signature, signed.keyId),
    ).resolves.toBe(false);

    const timestamp = String(Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000));
    const signature = signWebhook('secret', timestamp, '{}');
    expect(
      verifyWebhook('secret', timestamp, '{}', signature, new Date('2026-01-01T00:02:00Z')),
    ).toBe(true);
    expect(
      verifyWebhook('secret', timestamp, '{}', signature, new Date('2026-01-01T01:00:00Z')),
    ).toBe(false);
  });
});

it('preserves drawn ink in the completed PDF and embeds Chinese text in fields and certificates', async () => {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  const png = new PNG({ width: 32, height: 12 });
  png.data.fill(0);
  for (let x = 0; x < 32; x++) {
    const offset = (6 * 32 + x) * 4;
    png.data.set([18, 60, 51, 255], offset);
  }
  const documentId = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const signatureId = crypto.randomUUID();
  const nameId = crypto.randomUUID();
  const envelope = {
    id: crypto.randomUUID(),
    subject: '客户签署 — 房屋买卖文件',
    completedAt: '2026-09-11T14:00:00Z',
    fields: [
      {
        id: signatureId,
        documentId,
        page: 1,
        type: 'signature',
        roleId,
        label: 'Signature',
        rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.1, rotation: 0 },
      },
      {
        id: nameId,
        documentId,
        page: 1,
        type: 'full_name',
        roleId,
        label: 'Name',
        rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.1, rotation: 0 },
      },
    ],
    recipients: [
      {
        roleId,
        name: '测试客户',
        email: 'qa@example.invalid',
        status: 'COMPLETED',
        values: { [nameId]: '测试客户' },
        signature: {
          kind: 'drawn',
          value: `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`,
        },
      },
    ],
  } as unknown as Parameters<typeof renderCompletedPdf>[1];
  const result = await PDFDocument.load(
    await renderCompletedPdf(await source.save(), envelope, documentId),
  );
  expect(result.getPageCount()).toBe(2);
  const streams = result.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream);
  const image = streams.find(
    (stream) =>
      stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' &&
      stream.dict.get(PDFName.of('ColorSpace'))?.toString() === '/DeviceRGB',
  );
  expect(image).toBeDefined();
  expect(
    Array.from(
      decodePDFRawStream(image!)
        .decode()
        .slice(6 * 32 * 3, 6 * 32 * 3 + 3),
    ),
  ).toEqual([18, 60, 51]);
  const unicodeMaps = streams
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .filter((stream) => stream.includes('beginbfchar'))
    .join('')
    .toLowerCase();
  for (const character of '测试客户房屋买卖文件')
    expect(unicodeMaps).toContain(character.charCodeAt(0).toString(16));
  envelope.recipients[0]!.signature = {
    kind: 'typed',
    value: '测试客户',
    intentText: 'I intend to sign.',
    adoptedAt: envelope.completedAt!,
  };
  envelope.recipients = Array.from({ length: 50 }, () => structuredClone(envelope.recipients[0]!));
  const many = await PDFDocument.load(
    await renderCompletedPdf(await source.save(), envelope, documentId),
  );
  expect(many.getPageCount()).toBe(3);
});
