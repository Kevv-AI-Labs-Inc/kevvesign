import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ApplicationScope,
  AuditEvent,
  Envelope,
  EnvelopeStatus,
  FieldValue,
  PlatformState,
  Recipient,
  RecipientSession,
  StaffPrincipal,
  StaffRole,
  StaffSession,
  Template,
  TemplateField,
  TemplateVersion,
  Transaction,
  Workspace,
} from '@esign/contracts';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Array<{ field: string; message: string; code: string }>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface PlatformRepository {
  read<T>(operation: (state: Readonly<PlatformState>) => T): Promise<T>;
  write<T>(operation: (state: PlatformState) => T): Promise<T>;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  protect(key: string, retentionUntil: Date, legalHold: boolean): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  tags: Record<string, string>;
}

export interface EmailPort {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export interface ManifestSigner {
  sign(bytes: Uint8Array): Promise<{ signature: string; algorithm: string; keyId: string }>;
  verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean>;
}

export interface EvidenceFinalizer {
  finalize(envelopeId: string): Promise<void>;
}

export interface FileScanner {
  scan(bytes: Uint8Array): Promise<void>;
}

export interface SigningEngineDocumentInput {
  id: string;
  name: string;
  order: number;
  bytes: Uint8Array;
}

export interface SigningEngineRecipient {
  id: string | number;
  email: string;
  name: string;
  role: string;
  signingOrder?: number | null;
  sendStatus?: string;
  signingStatus?: string;
  readStatus?: string;
  signedAt?: string | null;
  signingUrl?: string;
}

export interface SigningEngineItem {
  id: string;
  title: string;
  order: number;
}

export interface SigningEngineEnvelope {
  id: string;
  externalId?: string | null;
  status: string;
  title: string;
  completedAt?: string | null;
  recipients: SigningEngineRecipient[];
  items: SigningEngineItem[];
}

/**
 * Anti-corruption boundary around the document-signing implementation.
 * Business services depend on this port, never on Documenso-specific response shapes.
 */
export interface SigningEngine {
  readonly provider: string;
  health(): Promise<{ provider: string; reachable: boolean }>;
  findEnvelopeByExternalId(externalId: string): Promise<SigningEngineEnvelope | undefined>;
  createEnvelope(
    envelope: Envelope,
    documents: SigningEngineDocumentInput[],
  ): Promise<SigningEngineEnvelope>;
  distributeEnvelope(envelopeId: string): Promise<SigningEngineEnvelope>;
  redistributeEnvelope(
    envelopeId: string,
    recipientId?: string | number,
  ): Promise<SigningEngineEnvelope>;
  cancelEnvelope(envelopeId: string): Promise<void>;
  getEnvelope(envelopeId: string): Promise<SigningEngineEnvelope>;
  downloadItem(itemId: string): Promise<Uint8Array>;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeSecretEqual(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function safeAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const forbidden = /token|secret|password|signature|field.?value|document|ssn|bank|access.?code/i;
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          forbidden.test(key) ? '[REDACTED]' : redact(item),
        ]),
      );
    }
    return value;
  };
  return redact(payload) as Record<string, unknown>;
}

export function appendAudit(
  state: PlatformState,
  input: Omit<AuditEvent, 'id' | 'previousHash' | 'hash'>,
): AuditEvent {
  const previous = [...state.auditEvents]
    .reverse()
    .find(
      (event) => event.workspaceId === input.workspaceId && event.envelopeId === input.envelopeId,
    );
  const previousHash = previous?.hash ?? '0'.repeat(64);
  const eventWithoutHash = {
    ...input,
    payload: safeAuditPayload(input.payload),
    previousHash,
  };
  const event: AuditEvent = {
    ...eventWithoutHash,
    id: randomUUID(),
    hash: sha256(canonicalJson(eventWithoutHash)),
  };
  state.auditEvents.push(event);
  return event;
}

export function verifyAuditChain(events: AuditEvent[]): boolean {
  let previousHash = '0'.repeat(64);
  for (const event of events) {
    if (event.previousHash !== previousHash) return false;
    const { id: _id, hash, ...withoutHash } = event;
    if (sha256(canonicalJson(withoutHash)) !== hash) return false;
    previousHash = hash;
  }
  return true;
}

const transitions: Record<EnvelopeStatus, readonly EnvelopeStatus[]> = {
  DRAFT: ['PREPARED', 'VOIDED'],
  PREPARED: ['APPROVAL_PENDING', 'READY_TO_SEND', 'VOIDED'],
  APPROVAL_PENDING: ['READY_TO_SEND', 'PREPARED', 'VOIDED'],
  READY_TO_SEND: ['SENT', 'VOIDED'],
  SENT: ['IN_PROGRESS', 'DECLINED', 'VOIDED', 'EXPIRED'],
  IN_PROGRESS: ['FINALIZING', 'DECLINED', 'VOIDED', 'EXPIRED'],
  FINALIZING: ['COMPLETED', 'FAILED_FINALIZATION'],
  FAILED_FINALIZATION: ['FINALIZING', 'VOIDED'],
  COMPLETED: [],
  DECLINED: [],
  VOIDED: [],
  EXPIRED: [],
};

export function transitionEnvelope(
  envelope: Envelope,
  next: EnvelopeStatus,
  now: string,
): Envelope {
  if (!transitions[envelope.status].includes(next)) {
    throw new DomainError(
      'invalid_transition',
      `Envelope cannot transition from ${envelope.status} to ${next}.`,
      409,
    );
  }
  envelope.status = next;
  envelope.updatedAt = now;
  envelope.version += 1;
  if (next === 'SENT') envelope.sentAt = now;
  if (next === 'COMPLETED') envelope.completedAt = now;
  if (next === 'VOIDED') envelope.voidedAt = now;
  return envelope;
}

const rolePermissions: Record<StaffRole, readonly string[]> = {
  platform_admin: ['*'],
  workspace_admin: [
    'workspace.manage',
    'template.read',
    'template.manage',
    'transaction.read',
    'transaction.manage',
    'envelope.read',
    'envelope.manage',
    'envelope.send',
    'envelope.approve',
    'evidence.read',
    'audit.read',
  ],
  preparer: [
    'template.read',
    'template.manage',
    'transaction.read',
    'transaction.manage',
    'envelope.read',
    'envelope.manage',
    'envelope.send',
    'evidence.read',
  ],
  approver: ['envelope.read', 'envelope.approve', 'evidence.read'],
  auditor: ['template.read', 'transaction.read', 'envelope.read', 'evidence.read', 'audit.read'],
};

const delegatedPermissionScopes: Record<string, readonly ApplicationScope[]> = {
  'template.read': ['templates:read'],
  'template.manage': ['templates:write'],
  'transaction.read': ['transactions:read'],
  'transaction.manage': ['transactions:write'],
  'envelope.read': ['envelopes:read'],
  'envelope.manage': ['envelopes:write'],
  'envelope.send': ['envelopes:send'],
  'envelope.approve': ['envelopes:write'],
  'evidence.read': ['evidence:read'],
};

export function requirePermission(principal: StaffPrincipal, permission: string): void {
  const allowed = rolePermissions[principal.role];
  if (!allowed.includes('*') && !allowed.includes(permission)) {
    throw new DomainError('forbidden', 'You do not have permission for this operation.', 403);
  }
  if (
    principal.actorType === 'application' ||
    principal.actorType === 'integration' ||
    principal.actorType === 'portal'
  ) {
    const requiredScopes = delegatedPermissionScopes[permission] ?? [];
    const scopes = principal.delegatedScopes ?? [];
    if (requiredScopes.length === 0 || !requiredScopes.some((scope) => scopes.includes(scope))) {
      throw new DomainError('forbidden', 'Delegated access lacks the required scope.', 403);
    }
  }
}

export function requireWorkspace(principal: StaffPrincipal, workspaceId: string): void {
  if (principal.workspaceId !== workspaceId && principal.role !== 'platform_admin') {
    throw new DomainError('not_found', 'Resource not found.', 404);
  }
}

export function validateTemplateForPublication(version: TemplateVersion): void {
  const details: Array<{ field: string; message: string; code: string }> = [];
  if (version.documents.length === 0) {
    details.push({
      field: 'documents',
      message: 'At least one PDF is required.',
      code: 'required',
    });
  }
  if (version.roles.length === 0) {
    details.push({
      field: 'roles',
      message: 'At least one recipient role is required.',
      code: 'required',
    });
  }
  const roleIds = new Set(version.roles.map((role) => role.id));
  const documentIds = new Set(version.documents.map((document) => document.id));
  const fieldKeys = new Set<string>();
  for (const field of version.fields) {
    if (field.fieldKey) {
      if (fieldKeys.has(field.fieldKey)) {
        details.push({
          field: `fields.${field.id}.fieldKey`,
          message: `Field key ${field.fieldKey} must be unique within a template version.`,
          code: 'duplicate',
        });
      }
      fieldKeys.add(field.fieldKey);
    }
    if (!documentIds.has(field.documentId)) {
      details.push({
        field: `fields.${field.id}`,
        message: 'Document does not exist.',
        code: 'invalid_reference',
      });
    }
    if (!field.readOnly && (!field.roleId || !roleIds.has(field.roleId))) {
      details.push({
        field: `fields.${field.id}`,
        message: 'Recipient role is required.',
        code: 'invalid_role',
      });
    }
    if (field.rect.x + field.rect.width > 1 || field.rect.y + field.rect.height > 1) {
      details.push({
        field: `fields.${field.id}`,
        message: 'Field is outside the page.',
        code: 'out_of_bounds',
      });
    }
  }
  if (version.businessDomain === 'REAL_ESTATE' && version.jurisdiction === 'NONE') {
    details.push({
      field: 'jurisdiction',
      message: 'A supported jurisdiction is required.',
      code: 'required',
    });
  }
  if (details.length > 0) {
    throw new DomainError('template_invalid', 'Template cannot be published.', 422, details);
  }
}

export function validateRecipientCompletion(
  fields: TemplateField[],
  recipient: Recipient,
): Array<{ field: string; message: string; code: string }> {
  const assigned = fields.filter((field) => field.roleId === recipient.roleId && field.required);
  const details: Array<{ field: string; message: string; code: string }> = [];
  for (const field of assigned) {
    const value = recipient.values[field.id];
    const isEmpty =
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0) ||
      value === false;
    if (field.type === 'signature' || field.type === 'initials') {
      if (!recipient.signature)
        details.push({ field: field.id, message: `${field.label} is required.`, code: 'required' });
    } else if (isEmpty) {
      details.push({ field: field.id, message: `${field.label} is required.`, code: 'required' });
    }
  }
  if (!recipient.consentedAt) {
    details.push({
      field: 'consent',
      message: 'Electronic records consent is required.',
      code: 'required',
    });
  }
  return details;
}

export function applyMergeData(
  fields: TemplateField[],
  mergeData: Record<string, unknown>,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.readOnly && field.mergeKey && mergeData[field.mergeKey] !== undefined) {
      const value = mergeData[field.mergeKey];
      if (typeof value === 'string' || typeof value === 'boolean') values[field.id] = value;
      else if (typeof value === 'number') values[field.id] = String(value);
    }
  }
  return values;
}

export function seedState(now = new Date().toISOString()): PlatformState {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const workspace: Workspace = {
    id: workspaceId,
    name: 'Northstar Realty Operations',
    slug: 'northstar',
    enabledJurisdictions: ['NY', 'NJ', 'CA'],
    createdAt: now,
    members: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin@example.test',
        displayName: 'Demo Administrator',
        role: 'platform_admin',
        status: 'ACTIVE',
      },
    ],
  };
  return {
    workspaces: [workspace],
    applicationClients: [],
    templates: [],
    transactions: [],
    envelopes: [],
    recipientSessions: [],
    integrationLaunchSessions: [],
    staffSessions: [],
    auditEvents: [],
    evidencePackages: [],
    emailDeliveries: [],
    webhookSubscriptions: [],
    idempotency: {},
  };
}

export class InMemoryRepository implements PlatformRepository {
  constructor(private readonly state: PlatformState = seedState()) {}

  async read<T>(operation: (state: Readonly<PlatformState>) => T): Promise<T> {
    return operation(this.state);
  }

  async write<T>(operation: (state: PlatformState) => T): Promise<T> {
    return operation(this.state);
  }

  snapshot(): PlatformState {
    return structuredClone(this.state);
  }
}

export function findWorkspace(state: Readonly<PlatformState>, workspaceId: string): Workspace {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new DomainError('not_found', 'Resource not found.', 404);
  return workspace;
}

export function findTemplate(
  state: Readonly<PlatformState>,
  workspaceId: string,
  templateId: string,
): Template {
  const template = state.templates.find(
    (candidate) => candidate.id === templateId && candidate.workspaceId === workspaceId,
  );
  if (!template) throw new DomainError('not_found', 'Resource not found.', 404);
  return template;
}

export function findEnvelope(
  state: Readonly<PlatformState>,
  workspaceId: string,
  envelopeId: string,
): Envelope {
  const envelope = state.envelopes.find(
    (candidate) => candidate.id === envelopeId && candidate.workspaceId === workspaceId,
  );
  if (!envelope) throw new DomainError('not_found', 'Resource not found.', 404);
  return envelope;
}

export function findTransaction(
  state: Readonly<PlatformState>,
  workspaceId: string,
  transactionId: string,
): Transaction {
  const transaction = state.transactions.find(
    (candidate) => candidate.id === transactionId && candidate.workspaceId === workspaceId,
  );
  if (!transaction) throw new DomainError('not_found', 'Resource not found.', 404);
  return transaction;
}

export function findSession(
  state: Readonly<PlatformState>,
  sessionSecret: string,
  now: Date,
): RecipientSession {
  const session = state.recipientSessions.find((candidate) =>
    safeSecretEqual(sessionSecret, candidate.sessionHash),
  );
  if (!session || session.revokedAt || new Date(session.expiresAt) <= now) {
    throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
  }
  return session;
}

export function findStaffSession(
  state: Readonly<PlatformState>,
  sessionSecret: string,
  now: Date,
): StaffSession {
  const session = state.staffSessions.find((candidate) =>
    safeSecretEqual(sessionSecret, candidate.sessionHash),
  );
  if (!session || session.revokedAt || new Date(session.expiresAt) <= now) {
    throw new DomainError('staff_session_invalid', 'Staff session is unavailable.', 401);
  }
  return session;
}

export function normalizeRect(
  pixel: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  if (page.width <= 0 || page.height <= 0)
    throw new DomainError('invalid_page', 'Page dimensions are invalid.');
  return {
    x: pixel.x / page.width,
    y: pixel.y / page.height,
    width: pixel.width / page.width,
    height: pixel.height / page.height,
  };
}

export function denormalizeRect(
  normalized: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: normalized.x * page.width,
    y: normalized.y * page.height,
    width: normalized.width * page.width,
    height: normalized.height * page.height,
  };
}

export function hashRequest(input: unknown): string {
  return sha256(canonicalJson(input));
}

export function assertIdempotency(
  state: PlatformState,
  workspaceId: string,
  operation: string,
  key: string,
  request: unknown,
): unknown | undefined {
  const compound = `${workspaceId}:${operation}:${key}`;
  const existing = state.idempotency[compound];
  const requestHash = hashRequest(request);
  if (existing && existing.requestHash !== requestHash) {
    throw new DomainError(
      'idempotency_conflict',
      'Idempotency key was already used for another request.',
      409,
    );
  }
  return existing?.response;
}

export function recordIdempotency(
  state: PlatformState,
  workspaceId: string,
  operation: string,
  key: string,
  request: unknown,
  response: unknown,
  createdAt: string,
): void {
  state.idempotency[`${workspaceId}:${operation}:${key}`] = {
    requestHash: hashRequest(request),
    response,
    createdAt,
  };
}

export function newId(): string {
  return randomUUID();
}
