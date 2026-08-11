import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  HmacManifestSigner,
  JsonFileRepository,
  LocalEmailPort,
  LocalObjectStore,
  inspectPdf,
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
