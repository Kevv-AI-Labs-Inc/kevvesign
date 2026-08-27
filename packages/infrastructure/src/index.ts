import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { createConnection } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import path from 'node:path';
import { EmailClient } from '@azure/communication-email';
import { DefaultAzureCredential } from '@azure/identity';
import { CryptographyClient, KeyClient, KnownSignatureAlgorithms } from '@azure/keyvault-keys';
import { ServiceBusClient } from '@azure/service-bus';
import { BlobServiceClient } from '@azure/storage-blob';
import type { BlobImmutabilityPolicyMode } from '@azure/storage-blob';
import type {
  AuditEvent,
  Envelope,
  EvidenceFile,
  EvidencePackage,
  PlatformState,
  WebhookEvent,
} from '@esign/contracts';
import {
  DomainError,
  appendAudit,
  canonicalJson,
  findEnvelope,
  sha256,
  transitionEnvelope,
  type EmailMessage,
  type EmailPort,
  type EvidenceFinalizer,
  type FileScanner,
  type ManifestSigner,
  type ObjectStore,
  type PlatformRepository,
} from '@esign/domain';
import sql from 'mssql';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export { DocumensoSigningEngine } from './documenso.js';

function assertSafeObjectKey(key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,499}$/.test(key) || key.includes('..')) {
    throw new DomainError('invalid_object_key', 'Object key is invalid.', 400);
  }
  return key;
}

function parsePlatformState(value: string): PlatformState {
  const state = JSON.parse(value) as PlatformState;
  state.applicationClients ??= [];
  for (const client of state.applicationClients) {
    client.allowedReturnUrls ??= [];
    // Legacy credentials are intentionally fail-closed until an administrator assigns domains.
    if (
      !Array.isArray(client.businessDomains) ||
      client.businessDomains.length !== 1 ||
      !['HR', 'REAL_ESTATE'].includes(client.businessDomains[0] ?? '')
    ) {
      client.businessDomains = [];
    }
  }
  state.integrationLaunchSessions ??= state.portalLaunchSessions ?? [];
  delete state.portalLaunchSessions;
  state.staffSessions ??= [];
  state.webhookSubscriptions ??= [];
  return state;
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private target(key: string): string {
    return path.join(this.root, assertSafeObjectKey(key));
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const target = this.target(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.target(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('object_not_found', 'Document is unavailable.', 404);
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.target(key));
      return true;
    } catch {
      return false;
    }
  }

  async protect(key: string, retentionUntil: Date, legalHold: boolean): Promise<void> {
    const metadataKey = `${assertSafeObjectKey(key)}.retention.json`;
    await this.put(
      metadataKey,
      Buffer.from(JSON.stringify({ retentionUntil: retentionUntil.toISOString(), legalHold })),
      'application/json',
    );
  }
}

export class AzureBlobObjectStore implements ObjectStore {
  private readonly container;

  constructor(accountUrl: string, containerName: string) {
    const service = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    this.container = service.getContainerClient(containerName);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const blob = this.container.getBlockBlobClient(assertSafeObjectKey(key));
    await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.container.getBlobClient(assertSafeObjectKey(key)).download();
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.readableStreamBody ?? []) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    return this.container.getBlobClient(assertSafeObjectKey(key)).exists();
  }

  async protect(key: string, retentionUntil: Date, legalHold: boolean): Promise<void> {
    const blob = this.container.getBlockBlobClient(assertSafeObjectKey(key));
    await blob.setImmutabilityPolicy({
      expiriesOn: retentionUntil,
      policyMode: 'Locked' as BlobImmutabilityPolicyMode,
    });
    if (legalHold) await blob.setLegalHold(true);
  }
}

export class JsonFileRepository implements PlatformRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly initialState: () => PlatformState,
  ) {}

  private async load(): Promise<PlatformState> {
    try {
      return parsePlatformState(await fs.readFile(this.filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state = this.initialState();
      await this.save(state);
      return state;
    }
  }

  private async save(state: PlatformState): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, this.filename);
  }

  async read<T>(operation: (state: Readonly<PlatformState>) => T): Promise<T> {
    await this.queue;
    return operation(await this.load());
  }

  async write<T>(operation: (state: PlatformState) => T): Promise<T> {
    let release: () => void = () => undefined;
    const wait = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      const state = await this.load();
      const result = operation(state);
      await this.save(state);
      return result;
    } finally {
      release();
    }
  }
}

export class AzureSqlStateRepository implements PlatformRepository {
  private poolPromise: Promise<sql.ConnectionPool> | undefined;

  constructor(private readonly connectionString: string) {}

  private pool(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= sql.connect(this.connectionString);
    return this.poolPromise;
  }

  async read<T>(operation: (state: Readonly<PlatformState>) => T): Promise<T> {
    const result = await (
      await this.pool()
    )
      .request()
      .query<{ state_json: string }>(
        'SELECT state_json FROM dbo.platform_state WHERE singleton_id = 1',
      );
    const row = result.recordset[0];
    if (!row) throw new Error('Azure SQL has not been seeded.');
    return operation(parsePlatformState(row.state_json));
  }

  async write<T>(operation: (state: PlatformState) => T): Promise<T> {
    const transaction = new sql.Transaction(await this.pool());
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const request = new sql.Request(transaction);
      const result = await request.query<{ state_json: string }>(
        'SELECT state_json FROM dbo.platform_state WITH (UPDLOCK, HOLDLOCK) WHERE singleton_id = 1',
      );
      const row = result.recordset[0];
      if (!row) throw new Error('Azure SQL has not been seeded.');
      const state = parsePlatformState(row.state_json);
      const existingAuditCount = state.auditEvents.length;
      const value = operation(state);
      await new sql.Request(transaction)
        .input('stateJson', sql.NVarChar(sql.MAX), JSON.stringify(state))
        .query(
          'UPDATE dbo.platform_state SET state_json = @stateJson, updated_at = SYSUTCDATETIME() WHERE singleton_id = 1',
        );
      for (const event of state.auditEvents.slice(existingAuditCount)) {
        await insertLedgerEvent(transaction, event);
      }
      await transaction.commit();
      return value;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

async function insertLedgerEvent(transaction: sql.Transaction, event: AuditEvent): Promise<void> {
  await new sql.Request(transaction)
    .input('id', sql.UniqueIdentifier, event.id)
    .input('workspaceId', sql.UniqueIdentifier, event.workspaceId)
    .input('envelopeId', sql.UniqueIdentifier, event.envelopeId ?? null)
    .input('actorType', sql.VarChar(20), event.actorType)
    .input('actorId', sql.NVarChar(120), event.actorId)
    .input(
      'sourceApplicationClientId',
      sql.UniqueIdentifier,
      event.sourceApplicationClientId ?? null,
    )
    .input('eventType', sql.VarChar(100), event.type)
    .input('occurredAt', sql.DateTime2, new Date(event.occurredAt))
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(event.payload))
    .input('previousHash', sql.Char(64), event.previousHash)
    .input('eventHash', sql.Char(64), event.hash).query(`INSERT INTO esign.audit_events
      (id, workspace_id, envelope_id, actor_type, actor_id, source_application_client_id, event_type, occurred_at, payload_json, previous_hash, event_hash)
      VALUES (@id, @workspaceId, @envelopeId, @actorType, @actorId, @sourceApplicationClientId, @eventType, @occurredAt, @payload, @previousHash, @eventHash)`);
}

export class LocalEmailPort implements EmailPort {
  constructor(private readonly outbox: string) {}

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const messageId = randomUUID();
    await fs.mkdir(this.outbox, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(this.outbox, `${messageId}.json`),
      JSON.stringify({ ...message, messageId, createdAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    return { messageId };
  }
}

export class LocalFileScanner implements FileScanner {
  async scan(bytes: Uint8Array): Promise<void> {
    const sample = Buffer.from(bytes).toString('ascii');
    if (sample.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
      throw new DomainError(
        'malware_detected',
        'The uploaded file was rejected by malware scanning.',
        422,
      );
    }
  }
}

export class ClamAvFileScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  async scan(bytes: Uint8Array): Promise<void> {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let result = '';
      const timeout = setTimeout(
        () => socket.destroy(new Error('Malware scanner timed out.')),
        this.timeoutMs,
      );
      socket.on('connect', () => {
        socket.write(Buffer.from('zINSTREAM\0'));
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (chunk) => {
        result += chunk.toString('utf8');
      });
      socket.on('end', () => {
        clearTimeout(timeout);
        resolve(result);
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (response.includes('FOUND')) {
      throw new DomainError(
        'malware_detected',
        'The uploaded file was rejected by malware scanning.',
        422,
      );
    }
    if (!response.includes('OK'))
      throw new Error('Malware scanner returned an indeterminate result.');
  }
}

export class AzureCommunicationEmailPort implements EmailPort {
  private readonly client: EmailClient;

  constructor(
    connectionString: string,
    private readonly sender: string,
  ) {
    this.client = new EmailClient(connectionString);
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const poller = await this.client.beginSend({
      senderAddress: this.sender,
      recipients: { to: [{ address: message.to }] },
      content: { subject: message.subject, plainText: message.text, html: message.html },
      headers: Object.fromEntries(
        Object.entries(message.tags).map(([name, value]) => [`X-Esign-${name}`, value]),
      ),
    });
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') throw new Error('Email delivery was not accepted.');
    return { messageId: result.id };
  }
}

export class HmacManifestSigner implements ManifestSigner {
  constructor(
    private readonly secret: string,
    private readonly keyId = 'local-hmac-v1',
  ) {
    if (secret.length < 32)
      throw new Error('Manifest signing secret must be at least 32 characters.');
  }

  async sign(bytes: Uint8Array): Promise<{ signature: string; algorithm: string; keyId: string }> {
    return {
      signature: createHmac('sha256', this.secret).update(bytes).digest('base64url'),
      algorithm: 'HMAC-SHA256',
      keyId: this.keyId,
    };
  }

  async verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean> {
    if (keyId !== this.keyId) return false;
    const actual = Buffer.from((await this.sign(bytes)).signature);
    const expected = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export class AzureKeyVaultManifestSigner implements ManifestSigner {
  private readonly keyClient: KeyClient;

  constructor(
    vaultUrl: string,
    private readonly keyName: string,
  ) {
    this.keyClient = new KeyClient(vaultUrl, new DefaultAzureCredential());
  }

  private async crypto(keyId?: string): Promise<CryptographyClient> {
    const version = keyId?.split('/').at(-1);
    const key = version
      ? await this.keyClient.getKey(this.keyName, { version })
      : await this.keyClient.getKey(this.keyName);
    return new CryptographyClient(key, new DefaultAzureCredential());
  }

  async sign(bytes: Uint8Array): Promise<{ signature: string; algorithm: string; keyId: string }> {
    const key = await this.keyClient.getKey(this.keyName);
    const crypto = new CryptographyClient(key, new DefaultAzureCredential());
    const digest = Buffer.from(sha256(bytes), 'hex');
    const result = await crypto.sign(KnownSignatureAlgorithms.RS256, digest);
    return {
      signature: Buffer.from(result.result).toString('base64url'),
      algorithm: 'RS256',
      keyId: key.id ?? this.keyName,
    };
  }

  async verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean> {
    const crypto = await this.crypto(keyId);
    const result = await crypto.verify(
      KnownSignatureAlgorithms.RS256,
      Buffer.from(sha256(bytes), 'hex'),
      Buffer.from(signature, 'base64url'),
    );
    return result.result;
  }
}

export interface PdfMetadata {
  pageCount: number;
  pages: Array<{ width: number; height: number; rotation: number }>;
  hasAcroForm: boolean;
  hasXfa: boolean;
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfMetadata> {
  if (bytes.byteLength < 8 || Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new DomainError('invalid_pdf', 'The uploaded file is not a valid PDF.', 422);
  }
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch {
    throw new DomainError('unsupported_pdf', 'The PDF is encrypted, corrupt, or unsupported.', 422);
  }
  let hasAcroForm = false;
  let hasXfa = false;
  try {
    const form = document.getForm();
    hasAcroForm = form.getFields().length > 0;
    hasXfa = form.hasXFA();
  } catch {
    // A malformed form catalog is treated as unsupported below.
  }
  if (hasXfa) throw new DomainError('unsupported_xfa', 'Dynamic XFA PDFs are not supported.', 422);
  return {
    pageCount: document.getPageCount(),
    pages: document.getPages().map((page) => ({
      width: page.getWidth(),
      height: page.getHeight(),
      rotation: page.getRotation().angle,
    })),
    hasAcroForm,
    hasXfa,
  };
}

export function completedFieldDisplayValue(
  envelope: Envelope,
  fieldId: string,
): string | undefined {
  const field = envelope.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return undefined;
  const recipient = field.readOnly
    ? envelope.recipients.find((candidate) => candidate.values[fieldId] !== undefined)
    : envelope.recipients.find((candidate) => candidate.roleId === field.roleId);
  if (!recipient) return undefined;
  if (field.type === 'signature' || field.type === 'initials') return recipient.signature?.value;
  const value = recipient.values[fieldId];
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (!value) return value;
  return field.label.startsWith('Summary: ')
    ? `${field.label.slice('Summary: '.length)}: ${value}`
    : value;
}

export async function renderCompletedPdf(
  source: Uint8Array,
  envelope: Envelope,
  documentId: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of envelope.fields.filter((candidate) => candidate.documentId === documentId)) {
    const value = completedFieldDisplayValue(envelope, field.id);
    if (!value) continue;
    const page = pdf.getPage(field.page - 1);
    if (!page)
      throw new DomainError('finalization_failed', 'Field references a missing PDF page.', 500);
    const x = field.rect.x * page.getWidth();
    const height = field.rect.height * page.getHeight();
    const width = field.rect.width * page.getWidth();
    const y = page.getHeight() - field.rect.y * page.getHeight() - height;
    const size = Math.max(8, Math.min(height * 0.55, field.type === 'signature' ? 18 : 12));
    page.drawText(value.startsWith('data:image/') ? 'Signed electronically' : value, {
      x: x + 2,
      y: y + Math.max(2, (height - size) / 2),
      size,
      font,
      color: rgb(0.04, 0.16, 0.14),
      maxWidth: Math.max(10, width - 4),
    });
  }
  const certificate = pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  certificate.drawText('Electronic Signature Completion Certificate', {
    x: 54,
    y: 730,
    size: 18,
    font: bold,
  });
  certificate.drawText(`Envelope: ${envelope.id}`, { x: 54, y: 690, size: 10, font });
  certificate.drawText(`Subject: ${envelope.subject}`, {
    x: 54,
    y: 672,
    size: 10,
    font,
    maxWidth: 500,
  });
  certificate.drawText(`Completed: ${envelope.completedAt ?? new Date().toISOString()}`, {
    x: 54,
    y: 654,
    size: 10,
    font,
  });
  certificate.drawText('Assurance: secure invitation delivered to assigned recipient email', {
    x: 54,
    y: 626,
    size: 10,
    font,
  });
  let y = 590;
  for (const recipient of envelope.recipients) {
    certificate.drawText(`${recipient.name} <${recipient.email}> — ${recipient.status}`, {
      x: 54,
      y,
      size: 10,
      font,
    });
    y -= 18;
  }
  certificate.drawText(
    'This certificate records system-observed events; it is not government identity verification.',
    {
      x: 54,
      y: 90,
      size: 9,
      font,
      color: rgb(0.3, 0.3, 0.3),
      maxWidth: 500,
    },
  );
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

export class PlatformEvidenceFinalizer implements EvidenceFinalizer {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly objects: ObjectStore,
    private readonly signer: ManifestSigner,
    private readonly retentionYears = 7,
  ) {}

  async finalize(envelopeId: string): Promise<void> {
    const envelope = await this.repository.read((state) => {
      const found = state.envelopes.find((candidate) => candidate.id === envelopeId);
      if (!found) throw new DomainError('not_found', 'Envelope not found.', 404);
      return structuredClone(found);
    });
    const evidenceId = randomUUID();
    const files: EvidenceFile[] = [];
    for (const document of envelope.documents) {
      const source = await this.objects.get(document.objectKey);
      if (sha256(source) !== document.sourceSha256) {
        throw new DomainError(
          'source_hash_mismatch',
          'Frozen document hash verification failed.',
          500,
        );
      }
      let completed: Uint8Array;
      if (document.completedObjectKey && document.completedSha256) {
        completed = await this.objects.get(document.completedObjectKey);
        if (sha256(completed) !== document.completedSha256) {
          throw new DomainError(
            'completed_hash_mismatch',
            'Sealed document hash verification failed.',
            500,
          );
        }
      } else {
        completed = await renderCompletedPdf(source, envelope, document.id);
      }
      const objectKey = `completed/${envelope.workspaceId}/${envelope.id}/${document.order}-${document.name}`;
      await this.objects.put(objectKey, completed, 'application/pdf');
      files.push({
        name: document.name,
        objectKey,
        sha256: sha256(completed),
        bytes: completed.byteLength,
        contentType: 'application/pdf',
      });
    }
    const audit = await this.repository.read((state) =>
      state.auditEvents.filter((event) => event.envelopeId === envelope.id),
    );
    const auditBytes = Buffer.from(audit.map((event) => canonicalJson(event)).join('\n'));
    const auditKey = `evidence/${envelope.workspaceId}/${envelope.id}/audit.jsonl`;
    await this.objects.put(auditKey, auditBytes, 'application/x-ndjson');
    files.push({
      name: 'audit.jsonl',
      objectKey: auditKey,
      sha256: sha256(auditBytes),
      bytes: auditBytes.byteLength,
      contentType: 'application/x-ndjson',
    });
    const manifest = {
      schemaVersion: '2026-08-01',
      evidenceId,
      envelopeId: envelope.id,
      workspaceId: envelope.workspaceId,
      generatedAt: new Date().toISOString(),
      sourceDocuments: envelope.documents.map((document) => ({
        objectKey: document.objectKey,
        sha256: document.sourceSha256,
      })),
      files,
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    const signed = await this.signer.sign(manifestBytes);
    const manifestKey = `evidence/${envelope.workspaceId}/${envelope.id}/manifest.json`;
    await this.objects.put(manifestKey, manifestBytes, 'application/json');
    const retentionUntil = new Date();
    retentionUntil.setUTCFullYear(retentionUntil.getUTCFullYear() + this.retentionYears);
    for (const file of files) await this.objects.protect(file.objectKey, retentionUntil, false);
    await this.objects.protect(manifestKey, retentionUntil, false);
    await this.repository.write((state) => {
      const mutable = findEnvelope(state, envelope.workspaceId, envelope.id);
      if (mutable.status !== 'FINALIZING' && mutable.status !== 'FAILED_FINALIZATION') {
        throw new DomainError('invalid_transition', 'Envelope is not ready for finalization.', 409);
      }
      if (mutable.status === 'FAILED_FINALIZATION')
        transitionEnvelope(mutable, 'FINALIZING', new Date().toISOString());
      const evidence: EvidencePackage = {
        id: evidenceId,
        workspaceId: envelope.workspaceId,
        envelopeId: envelope.id,
        createdAt: new Date().toISOString(),
        files,
        manifestObjectKey: manifestKey,
        manifestSha256: sha256(manifestBytes),
        signature: signed.signature,
        signatureAlgorithm: signed.algorithm,
        signingKeyId: signed.keyId,
        retentionUntil: retentionUntil.toISOString(),
        legalHold: false,
        verificationStatus: 'VERIFIED',
      };
      state.evidencePackages.push(evidence);
      mutable.evidencePackageId = evidence.id;
      transitionEnvelope(mutable, 'COMPLETED', new Date().toISOString());
      appendAudit(state, {
        workspaceId: mutable.workspaceId,
        envelopeId: mutable.id,
        actorType: 'system',
        actorId: 'pdf-finalizer',
        type: 'envelope.completed',
        occurredAt: mutable.completedAt ?? new Date().toISOString(),
        payload: { evidencePackageId: evidence.id, manifestSha256: evidence.manifestSha256 },
      });
    });
  }
}

export class ServiceBusFinalizationQueue {
  private readonly client: ServiceBusClient;

  constructor(
    namespace: string,
    private readonly queueName: string,
  ) {
    this.client = new ServiceBusClient(namespace, new DefaultAzureCredential());
  }

  async enqueue(envelopeId: string, workspaceId: string): Promise<void> {
    const sender = this.client.createSender(this.queueName);
    try {
      await sender.sendMessages({
        messageId: `finalize:${envelopeId}`,
        subject: 'esign.finalize.v1',
        body: { schemaVersion: 1, envelopeId, workspaceId },
      });
    } finally {
      await sender.close();
    }
  }
}

function isPrivateIp(address: string): boolean {
  if (
    address === '::1' ||
    address.startsWith('fe80:') ||
    address.startsWith('fc') ||
    address.startsWith('fd')
  )
    return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError('invalid_webhook_url', 'Webhook URL is invalid.', 422);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new DomainError(
      'invalid_webhook_url',
      'Webhook URL must use HTTPS without credentials or a custom port.',
      422,
    );
  }
  const literal = isIP(url.hostname);
  const addresses = literal
    ? [url.hostname]
    : [...(await resolve4(url.hostname)), ...(await resolve6(url.hostname))];
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new DomainError('unsafe_webhook_url', 'Webhook destination is not allowed.', 422);
  }
  return url;
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifyWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  now = new Date(),
  toleranceSeconds = 300,
): boolean {
  const stamp = Number(timestamp);
  if (!Number.isFinite(stamp) || Math.abs(now.getTime() / 1000 - stamp) > toleranceSeconds)
    return false;
  return signWebhook(secret, timestamp, rawBody) === signature;
}

export async function deliverWebhook(
  url: URL,
  secret: string,
  event: WebhookEvent,
): Promise<Response> {
  await assertSafeWebhookUrl(url.toString());
  const rawBody = canonicalJson(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Internal-ESign-Webhook/1.0',
      'x-esign-event-id': event.id,
      'x-esign-timestamp': timestamp,
      'x-esign-signature': signWebhook(secret, timestamp, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
}
