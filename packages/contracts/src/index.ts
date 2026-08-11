import { z } from 'zod';

export const JurisdictionSchema = z.enum(['NY', 'NJ', 'CA', 'NONE']);
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

export const BusinessDomainSchema = z.enum(['REAL_ESTATE', 'HR']);
export type BusinessDomain = z.infer<typeof BusinessDomainSchema>;

export const StaffRoleSchema = z.enum([
  'platform_admin',
  'workspace_admin',
  'preparer',
  'approver',
  'auditor',
]);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const ApplicationScopeSchema = z.enum([
  'templates:read',
  'templates:write',
  'transactions:read',
  'transactions:write',
  'envelopes:read',
  'envelopes:write',
  'envelopes:send',
  'evidence:read',
  'portal-sessions:create',
]);
export type ApplicationScope = z.infer<typeof ApplicationScopeSchema>;

export const RecipientKindSchema = z.enum([
  'signer',
  'approver',
  'countersigner',
  'viewer',
  'copy',
]);
export type RecipientKind = z.infer<typeof RecipientKindSchema>;

export const FieldTypeSchema = z.enum([
  'signature',
  'initials',
  'signed_date',
  'full_name',
  'email',
  'title',
  'company',
  'text',
  'multiline',
  'number',
  'currency',
  'address',
  'phone',
  'checkbox',
  'radio',
  'dropdown',
  'attachment',
  'merge',
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const EnvelopeStatusSchema = z.enum([
  'DRAFT',
  'PREPARED',
  'APPROVAL_PENDING',
  'READY_TO_SEND',
  'SENT',
  'IN_PROGRESS',
  'FINALIZING',
  'COMPLETED',
  'DECLINED',
  'VOIDED',
  'EXPIRED',
  'FAILED_FINALIZATION',
]);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatusSchema>;

export const RecipientStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'VIEWED',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'REVOKED',
]);
export type RecipientStatus = z.infer<typeof RecipientStatusSchema>;

export const TemplateVersionStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']);
export type TemplateVersionStatus = z.infer<typeof TemplateVersionStatusSchema>;

export const NormalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
});
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

export const FieldOptionSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().max(200),
});
export type FieldOption = z.infer<typeof FieldOptionSchema>;

export const TemplateFieldSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  page: z.number().int().min(1),
  type: FieldTypeSchema,
  roleId: z.string().uuid().nullable(),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  readOnly: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  tabIndex: z.number().int().min(0),
  rect: NormalizedRectSchema,
  validation: z
    .object({
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().positive().optional(),
      pattern: z.string().max(300).optional(),
    })
    .optional(),
  options: z.array(FieldOptionSchema).max(100).optional(),
  mergeKey: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/)
    .max(120)
    .optional(),
});
export type TemplateField = z.infer<typeof TemplateFieldSchema>;

export const RecipientRoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  kind: RecipientKindSchema,
  routingOrder: z.number().int().min(1).max(100),
});
export type RecipientRole = z.infer<typeof RecipientRoleSchema>;

export const TemplateDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(180),
  objectKey: z.string().min(1).max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pageCount: z.number().int().positive(),
  order: z.number().int().min(0),
  retentionClass: z.string().min(1).max(80),
  detectedMime: z.literal('application/pdf'),
});
export type TemplateDocument = z.infer<typeof TemplateDocumentSchema>;

export interface TemplateVersion {
  id: string;
  version: number;
  status: TemplateVersionStatus;
  createdAt: string;
  publishedAt?: string;
  retiredAt?: string;
  sourceName: string;
  licenseOwner: string;
  edition: string;
  effectiveDate: string;
  jurisdiction: Jurisdiction;
  businessDomain: BusinessDomain;
  approvalRequired: boolean;
  retentionPolicyId: string;
  documents: TemplateDocument[];
  roles: RecipientRole[];
  fields: TemplateField[];
  schemaHash?: string;
}

export interface Template {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  activeVersionId?: string;
  versions: TemplateVersion[];
}

export interface WorkspaceMember {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  members: WorkspaceMember[];
  enabledJurisdictions: Jurisdiction[];
  createdAt: string;
}

export interface ApplicationClient {
  id: string;
  workspaceId: string;
  name: string;
  secretHash: string;
  scopes: ApplicationScope[];
  allowedReturnUrls: string[];
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  expiresAt?: string;
  rotatedAt?: string;
}

export const PortalActorSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/),
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(160),
  role: z.enum(['preparer', 'approver', 'auditor']),
});
export type PortalActor = z.infer<typeof PortalActorSchema>;

export const PortalIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dashboard') }),
  z.object({ kind: z.literal('prepare-envelope'), templateId: z.string().uuid().optional() }),
  z.object({ kind: z.literal('edit-template'), templateId: z.string().uuid() }),
  z.object({ kind: z.literal('view-envelope'), envelopeId: z.string().uuid() }),
]);
export type PortalIntent = z.infer<typeof PortalIntentSchema>;

export interface PortalLaunchSession {
  id: string;
  ticketHash: string;
  workspaceId: string;
  applicationClientId: string;
  actor: PortalActor;
  intent: PortalIntent;
  returnUrl: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface StaffSession {
  id: string;
  sessionHash: string;
  csrfHash: string;
  workspaceId: string;
  applicationClientId: string;
  actor: PortalActor;
  intent: PortalIntent;
  returnUrl: string;
  scopes: ApplicationScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface Transaction {
  id: string;
  workspaceId: string;
  kind: 'PROPERTY' | 'HR_PACKET';
  name: string;
  jurisdiction: Jurisdiction;
  externalReference?: string;
  propertyAddress?: string;
  envelopeIds: string[];
  createdAt: string;
}

export interface SignatureAdoption {
  kind: 'typed' | 'drawn';
  value: string;
  adoptedAt: string;
  intentText: string;
}

export type FieldValue = string | boolean | string[];

export interface Recipient {
  id: string;
  roleId: string;
  name: string;
  email: string;
  kind: RecipientKind;
  routingOrder: number;
  status: RecipientStatus;
  assuranceMethod: 'email_invitation' | 'access_code' | 'internal_account';
  invitationHash?: string;
  invitationExpiresAt?: string;
  accessCodeHash?: string;
  accessCodeFailures: number;
  consentedAt?: string;
  disclosureVersion?: string;
  signature?: SignatureAdoption;
  values: Record<string, FieldValue>;
  viewedAt?: string;
  completedAt?: string;
  declineReason?: string;
}

export interface EnvelopeDocument extends TemplateDocument {
  sourceSha256: string;
}

export interface Envelope {
  id: string;
  workspaceId: string;
  transactionId?: string;
  templateId: string;
  templateVersionId: string;
  externalReference?: string;
  subject: string;
  message: string;
  status: EnvelopeStatus;
  jurisdiction: Jurisdiction;
  businessDomain: BusinessDomain;
  approvalRequired: boolean;
  approvedAt?: string;
  approvedBy?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  completedAt?: string;
  voidedAt?: string;
  voidReason?: string;
  version: number;
  documents: EnvelopeDocument[];
  fields: TemplateField[];
  recipients: Recipient[];
  retentionPolicyId: string;
  evidencePackageId?: string;
  supersedesEnvelopeId?: string;
}

export interface RecipientSession {
  id: string;
  sessionHash: string;
  csrfHash: string;
  envelopeId: string;
  recipientId: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  envelopeId?: string;
  actorType: 'staff' | 'recipient' | 'application' | 'portal' | 'system';
  actorId: string;
  sourceApplicationClientId?: string;
  type: string;
  occurredAt: string;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface EvidenceFile {
  name: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface EvidencePackage {
  id: string;
  workspaceId: string;
  envelopeId: string;
  createdAt: string;
  files: EvidenceFile[];
  manifestObjectKey: string;
  manifestSha256: string;
  signature: string;
  signatureAlgorithm: string;
  signingKeyId: string;
  retentionUntil: string;
  legalHold: boolean;
  verificationStatus: 'VERIFIED' | 'FAILED';
}

export interface EmailDelivery {
  id: string;
  envelopeId: string;
  recipientId: string;
  kind: 'invitation' | 'reminder' | 'completion' | 'decline' | 'void' | 'expiration';
  to: string;
  providerMessageId: string;
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'BOUNCED' | 'FAILED';
  createdAt: string;
}

export interface WebhookSubscription {
  id: string;
  workspaceId: string;
  url: string;
  secretHash: string;
  encryptedSecret: string;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  eventTypes: string[];
  createdAt: string;
}

export interface PlatformState {
  workspaces: Workspace[];
  applicationClients: ApplicationClient[];
  templates: Template[];
  transactions: Transaction[];
  envelopes: Envelope[];
  recipientSessions: RecipientSession[];
  portalLaunchSessions: PortalLaunchSession[];
  staffSessions: StaffSession[];
  auditEvents: AuditEvent[];
  evidencePackages: EvidencePackage[];
  emailDeliveries: EmailDelivery[];
  webhookSubscriptions: WebhookSubscription[];
  idempotency: Record<string, { requestHash: string; response: unknown; createdAt: string }>;
}

export const CreateTemplateInputSchema = z.object({
  name: z.string().min(2).max(120),
  sourceName: z.string().min(2).max(180),
  licenseOwner: z.string().min(2).max(180),
  edition: z.string().min(1).max(80),
  effectiveDate: z.string().date(),
  jurisdiction: JurisdictionSchema,
  businessDomain: BusinessDomainSchema,
  approvalRequired: z.boolean().default(false),
  retentionPolicyId: z.string().min(1).max(80),
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateInputSchema>;

export const UpdateTemplateDraftInputSchema = z.object({
  roles: z.array(RecipientRoleSchema).min(1).max(30),
  fields: z.array(TemplateFieldSchema).max(1000),
});
export type UpdateTemplateDraftInput = z.infer<typeof UpdateTemplateDraftInputSchema>;

export const RecipientInputSchema = z.object({
  roleId: z.string().uuid(),
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  accessCode: z
    .string()
    .min(4)
    .max(32)
    .regex(/^[\w -]+$/)
    .optional(),
});

export const CreateEnvelopeInputSchema = z.object({
  templateId: z.string().uuid(),
  transactionId: z.string().uuid().optional(),
  externalReference: z.string().min(1).max(120).optional(),
  subject: z.string().min(2).max(180),
  message: z.string().max(2000).default(''),
  expiresAt: z.string().datetime(),
  recipients: z.array(RecipientInputSchema).min(1).max(50),
  mergeData: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type CreateEnvelopeInput = z.infer<typeof CreateEnvelopeInputSchema>;

export const CreateTransactionInputSchema = z.object({
  kind: z.enum(['PROPERTY', 'HR_PACKET']),
  name: z.string().min(2).max(180),
  jurisdiction: JurisdictionSchema,
  externalReference: z.string().min(1).max(120).optional(),
  propertyAddress: z.string().min(2).max(300).optional(),
});
export type CreateTransactionInput = z.infer<typeof CreateTransactionInputSchema>;

export const CreateApplicationClientInputSchema = z.object({
  name: z.string().min(2).max(120),
  scopes: z.array(ApplicationScopeSchema).min(1).max(ApplicationScopeSchema.options.length),
  allowedReturnUrls: z.array(z.string().url().max(500)).max(10).default([]),
  expiresAt: z.string().datetime().optional(),
});
export type CreateApplicationClientInput = z.infer<typeof CreateApplicationClientInputSchema>;

export const CreatePortalSessionInputSchema = z.object({
  actor: PortalActorSchema,
  intent: PortalIntentSchema,
  returnUrl: z.string().url().max(500),
});
export type CreatePortalSessionInput = z.infer<typeof CreatePortalSessionInputSchema>;

export const SaveSigningProgressSchema = z.object({
  expectedEnvelopeVersion: z.number().int().positive(),
  values: z.record(
    z.string().uuid(),
    z.union([z.string().max(5000), z.boolean(), z.array(z.string().max(300)).max(100)]),
  ),
  signature: z
    .object({
      kind: z.enum(['typed', 'drawn']),
      value: z.string().min(1).max(250_000),
      intentText: z.string().min(5).max(500),
    })
    .optional(),
});
export type SaveSigningProgress = z.infer<typeof SaveSigningProgressSchema>;

export const ConsentInputSchema = z.object({
  disclosureVersion: z.string().min(1).max(80),
  accepted: z.literal(true),
});

export interface StaffPrincipal {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  workspaceId: string;
  actorType?: 'staff' | 'application' | 'portal';
  sourceApplicationClientId?: string;
  sourceApplicationName?: string;
  delegatedScopes?: ApplicationScope[];
  returnUrl?: string;
}

export interface ApplicationPrincipal extends StaffPrincipal {
  actorType: 'application';
  scopes: ApplicationScope[];
}

export interface PortalSessionExchange {
  principal: StaffPrincipal;
  csrfToken: string;
  destination: string;
  returnUrl: string;
  expiresAt: string;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Array<{ field: string; message: string; code: string }>;
  };
}

export interface InvitationDelivery {
  recipientId: string;
  email: string;
  token: string;
  invitationUrl: string;
}

export interface SigningContext {
  envelope: Pick<
    Envelope,
    'id' | 'subject' | 'message' | 'status' | 'expiresAt' | 'version' | 'documents'
  >;
  recipient: Pick<
    Recipient,
    'id' | 'name' | 'email' | 'status' | 'consentedAt' | 'signature' | 'values'
  >;
  fields: TemplateField[];
  csrfToken: string;
  disclosure: { version: string; title: string; body: string };
}

export const WebhookEventSchema = z.object({
  id: z.string().uuid(),
  apiVersion: z.literal('2026-08-01'),
  type: z.string().min(3).max(100),
  occurredAt: z.string().datetime(),
  workspaceId: z.string().uuid(),
  envelopeId: z.string().uuid().optional(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
