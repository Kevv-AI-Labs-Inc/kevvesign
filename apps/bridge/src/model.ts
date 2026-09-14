import { z } from 'zod';
import type { NativeEnvelope } from './documenso.js';

export class BridgeError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
export const email = z.email().transform((value) => value.trim().toLowerCase());
export const businessSchema = z
  .object({
    customer: z.string().max(200).default(''),
    property: z.string().max(500).default(''),
    reference: z.string().max(200).default(''),
  })
  .strict();
export const recipientInput = z
  .object({ key, name: z.string().trim().min(1).max(200), email })
  .strict();
export const createInput = z
  .object({
    idempotencyKey: key,
    externalReference: key,
    title: z.string().trim().min(1).max(200),
    scenario: z.enum(['onboarding', 'team_leader', 'buyer', 'seller', 'custom']),
    packageId: z.uuid().optional(),
    predecessorRequestId: z.uuid().optional(),
    reissueReason: z.string().trim().min(5).max(2000).optional(),
    companyKey: key,
    ownerAgentId: z.number().int().positive(),
    business: businessSchema.default({ customer: '', property: '', reference: '' }),
    recipients: z.array(recipientInput).max(50),
    values: z
      .record(key, z.union([z.string().max(10000), z.array(z.string().max(1000)).max(50)]))
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scenario !== 'custom' && !value.packageId)
      ctx.addIssue({
        code: 'custom',
        message: 'A published package is required',
        path: ['packageId'],
      });
    if (value.scenario === 'custom' && value.packageId)
      ctx.addIssue({
        code: 'custom',
        message: 'Custom documents do not use a package',
        path: ['packageId'],
      });
    if (new Set(value.recipients.map((r) => r.key)).size !== value.recipients.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Recipient keys must be distinct',
        path: ['recipients'],
      });
  });
export type CreateInput = z.infer<typeof createInput>;
export const templatePartInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    templateId: z.string().min(1).max(200),
    roles: z
      .array(
        z
          .object({
            key,
            templateRecipientId: z.number().int().positive(),
            actor: z.enum(['owner', 'company', 'customer']),
            label: z.string().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    prefill: z
      .array(
        z
          .object({
            key,
            templateFieldId: z.number().int().positive(),
            required: z.boolean().default(true),
            label: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export const publishInput = z
  .object({
    packageKey: key,
    version: z.number().int().positive().max(2147483647),
    title: z.string().trim().min(1).max(200),
    scenario: z.enum(['onboarding', 'team_leader', 'buyer', 'seller']),
    companyKey: key,
    selectors: z.record(key, z.string().max(200)).default({}),
    parts: z.array(templatePartInput).min(1).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const actors = new Map<string, string>();
    for (const [index, part] of value.parts.entries())
      for (const role of part.roles) {
        if (actors.has(role.key) && actors.get(role.key) !== role.actor)
          ctx.addIssue({
            code: 'custom',
            message: 'A role key must identify the same actor across all package parts',
            path: ['parts', index, 'roles'],
          });
        actors.set(role.key, role.actor);
      }
  });
export type TemplatePart = z.infer<typeof templatePartInput>;
export type PublishedPart = TemplatePart & {
  fingerprint: string;
  files: Array<{ title: string; hash: string }>;
  connectionId: string;
};
export type PackageRow = {
  id: string;
  client_id: string;
  package_key: string;
  version: number;
  title: string;
  scenario: CreateInput['scenario'];
  company_key: string;
  selectors: Record<string, string>;
  definition: PublishedPart[];
  retired_at: Date | null;
};
export type Connection = {
  id: string;
  client_id: string;
  scope: 'customer' | 'company';
  owner_agent_id: number | null;
  company_key: string | null;
  native_user_id: number;
  native_email: string;
  team_id: number;
  team_url: string;
  token_ciphertext: string;
  revoked_at: Date | null;
};
export type RecipientBinding = {
  key: string;
  email: string;
  name: string;
  role: string;
  actor: 'owner' | 'company' | 'customer';
  nativeId?: number;
};
export type FileInput = { name: string; bytes: Uint8Array };
export type PreparedPart = {
  payload: Record<string, unknown>;
  files: FileInput[];
  bindings: RecipientBinding[];
  connection: Connection;
};
export type PartRow = {
  id: string;
  request_id: string;
  part_index: number;
  connection_id: string;
  external_id: string;
  provider_id: string | null;
  folder_id: string | null;
  operation_state: 'prepared' | 'creating' | 'unknown' | 'linked' | 'failed' | 'discarded';
  delivery_state: 'idle' | 'sending' | 'unknown' | 'sent';
  snapshot: Record<string, unknown>;
  recipients: RecipientBinding[];
  projection: Projection | null;
  last_error: string | null;
  last_synced_at: Date | null;
};
export type RequestRow = {
  id: string;
  client_id: string;
  owner_agent_id: number;
  scenario: CreateInput['scenario'];
  title: string;
  business: z.infer<typeof businessSchema>;
  input_snapshot: CreateInput;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
};
export type Projection = ReturnType<typeof projectEnvelope>;

// Explicit allowlist: upstream recipient tokens, PDF storage IDs and access
// authentication options must never leak into lists or human-readable events.
export function projectEnvelope(
  document: NativeEnvelope,
  bindings: RecipientBinding[],
  now = Date.now(),
) {
  const recipients = document.recipients.map((recipient) => {
    const binding = bindings.find((b) => b.nativeId === recipient.id);
    return {
      id: recipient.id,
      key: binding?.key ?? null,
      actor: binding?.actor ?? 'customer',
      name: recipient.name,
      email: recipient.email,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
      signingStatus: recipient.signingStatus,
      signedAt: recipient.signedAt,
      expiresAt: recipient.expiresAt,
      sendStatus: recipient.sendStatus,
    };
  });
  return {
    id: document.id,
    title: document.title,
    status: document.status,
    signingOrder: document.documentMeta?.signingOrder === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'PARALLEL',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    completedAt: document.status === 'COMPLETED' ? document.completedAt : null,
    expired:
      document.status === 'PENDING' &&
      recipients.some(
        (r) =>
          r.role !== 'CC' &&
          r.signingStatus === 'NOT_SIGNED' &&
          r.expiresAt &&
          Date.parse(r.expiresAt) <= now,
      ),
    recipients,
    files: document.envelopeItems.map(({ id, title, order }) => ({ id, title, order })),
    completionFilesReady: document.status === 'COMPLETED',
  };
}

export function bindRecipients(document: NativeEnvelope, expected: RecipientBinding[]) {
  const used = new Set<number>();
  return expected.map((binding) => {
    const matches = document.recipients.filter(
      (r) =>
        !used.has(r.id) &&
        r.email.toLowerCase() === binding.email &&
        r.role === binding.role &&
        r.name === binding.name,
    );
    // A published template must use distinct email+role slots. Never resolve
    // an ambiguous mapping by array position and hand out another signer's URL.
    if (matches.length !== 1) throw new BridgeError('RECIPIENT_MAPPING_MISMATCH', 409);
    used.add(matches[0].id);
    return { ...binding, nativeId: matches[0].id };
  });
}

export function assertNativeOwner(
  document: NativeEnvelope,
  connection: Connection,
  expectedType: 'DOCUMENT' | 'TEMPLATE' = 'DOCUMENT',
) {
  if (
    document.deletedAt ||
    document.type !== expectedType ||
    document.teamId !== connection.team_id ||
    document.userId !== connection.native_user_id ||
    document.user.email.toLowerCase() !== connection.native_email ||
    document.visibility !== 'ADMIN'
  )
    throw new BridgeError('NATIVE_OWNERSHIP_MISMATCH', 409);
}
