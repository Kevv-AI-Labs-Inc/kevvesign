import { Documenso, templateFingerprint } from './documenso.js';
import type { NativeEnvelope, NativeField } from './documenso.js';
import {
  BridgeError,
  type CreateInput,
  type Connection,
  type TemplatePart,
  type PublishedPart,
  type PreparedPart,
} from './model.js';

const editablePrefills = new Set(['TEXT', 'NUMBER', 'RADIO', 'CHECKBOX', 'DROPDOWN']);
const nullableMeta = new Set([
  'emailId',
  'emailReplyTo',
  'emailSettings',
  'envelopeExpirationPeriod',
  'reminderSettings',
]);
const createMetaKeys = new Set([
  'subject',
  'message',
  'timezone',
  'dateFormat',
  'distributionMethod',
  'signingOrder',
  'allowDictateNextSigner',
  'redirectUrl',
  'language',
  'typedSignatureEnabled',
  'uploadSignatureEnabled',
  'drawSignatureEnabled',
  ...nullableMeta,
]);
export function createMeta(meta: Record<string, unknown> | null) {
  // GET returns nullable database values, while the public create contract uses
  // optional strings. Preserve intentional null settings only where allowed.
  return Object.fromEntries(
    Object.entries(meta || {}).filter(
      ([key, value]) => createMetaKeys.has(key) && (value !== null || nullableMeta.has(key)),
    ),
  );
}
export function validateTemplate(
  document: NativeEnvelope,
  part: TemplatePart,
  connection: Connection,
) {
  if (
    document.type !== 'TEMPLATE' ||
    document.deletedAt ||
    document.teamId !== connection.team_id ||
    document.userId !== connection.native_user_id ||
    document.user.email.toLowerCase() !== connection.native_email ||
    document.visibility !== 'ADMIN'
  )
    throw new BridgeError('TEMPLATE_ACCESS_MISMATCH', 409);
  // Native 2.18 uses a strict sequential recipient list, not parallel groups.
  // Equal ranks can disagree between turn checks and the invitation job.
  if (document.documentMeta?.signingOrder === 'SEQUENTIAL') {
    const ranks = document.recipients.filter((r) => r.role !== 'CC').map((r) => r.signingOrder);
    if (ranks.some((rank) => rank === null) || new Set(ranks).size !== ranks.length)
      throw new BridgeError('SEQUENTIAL_ORDER_MUST_BE_DISTINCT', 400);
  }
  const roleIds = part.roles.map((r) => r.templateRecipientId);
  if (
    new Set(roleIds).size !== roleIds.length ||
    new Set(part.roles.map((r) => r.key)).size !== part.roles.length ||
    document.recipients.length !== roleIds.length ||
    document.recipients.some((r) => !roleIds.includes(r.id))
  )
    throw new BridgeError('EVERY_TEMPLATE_RECIPIENT_NEEDS_A_DISTINCT_ROLE', 400);
  if (new Set(part.prefill.map((p) => p.templateFieldId)).size !== part.prefill.length)
    throw new BridgeError('DUPLICATE_PREFILL_FIELD', 400);
  for (const prefill of part.prefill) {
    const field = document.fields.find((f) => f.id === prefill.templateFieldId);
    if (!field || !editablePrefills.has(field.type))
      throw new BridgeError('INVALID_PREFILL_FIELD', 400);
  }
  for (const recipient of document.recipients) {
    if (
      recipient.role === 'SIGNER' &&
      !document.fields.some((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE')
    )
      throw new BridgeError('SIGNER_MISSING_SIGNATURE_FIELD', 400);
  }
}

export async function readTemplate(
  provider: Documenso,
  part: TemplatePart,
  connection: Connection,
) {
  const document = await provider.get(part.templateId);
  validateTemplate(document, part, connection);
  // Keep native array order for fingerprint and use explicit indices for files.
  const files = [];
  for (const item of document.envelopeItems)
    files.push({
      name: item.title,
      bytes: await provider.document(document.id, item.id, 'original'),
    });
  return { document, files };
}

export function prefillMeta(field: NativeField, value: string | string[]) {
  const meta = { ...(field.fieldMeta || {}), type: field.type.toLowerCase() };
  if (!editablePrefills.has(field.type)) throw new BridgeError('INVALID_PREFILL_FIELD', 400);
  if (field.type === 'CHECKBOX' ? !Array.isArray(value) : typeof value !== 'string')
    throw new BridgeError('INVALID_PREFILL_VALUE', 400);
  if (field.type === 'TEXT') return { ...meta, text: value };
  if (field.type === 'NUMBER') {
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value)))
      throw new BridgeError('INVALID_NUMBER_PREFILL', 400);
    return { ...meta, value };
  }
  const options = Array.isArray(field.fieldMeta?.values)
    ? (field.fieldMeta.values as Array<{ value: string; id?: number; checked?: boolean }>)
    : [];
  const choices = Array.isArray(value) ? value : [value];
  if (choices.some((choice) => !options.some((o) => o.value === choice)))
    throw new BridgeError('INVALID_PREFILL_OPTION', 400);
  return field.type === 'DROPDOWN'
    ? { ...meta, defaultValue: value }
    : { ...meta, values: options.map((o) => ({ ...o, checked: choices.includes(o.value) })) };
}

export function compileTemplate(
  document: NativeEnvelope,
  files: PreparedPart['files'],
  part: PublishedPart,
  input: CreateInput,
  target: Connection,
  redirectUrl: string | null,
): PreparedPart {
  const activeRoles = part.roles.filter(
    (role) => !role.optional || input.recipients.some((recipient) => recipient.key === role.key),
  );
  const activeRecipientIds = new Set(activeRoles.map((role) => role.templateRecipientId));
  const bindings = activeRoles.map((role) => {
    const recipient = input.recipients.find((r) => r.key === role.key);
    const native = document.recipients.find((r) => r.id === role.templateRecipientId)!;
    if (!recipient) throw new BridgeError(`MISSING_RECIPIENT:${role.key}`, 400);
    return { ...recipient, role: native.role, actor: role.actor };
  });
  // Same email may be an owner and company signer, but not two indistinguishable
  // native slots in one envelope. Separate parts retain both responsibilities.
  if (new Set(bindings.map((r) => `${r.email}:${r.role}:${r.name}`)).size !== bindings.length)
    throw new BridgeError('INDISTINGUISHABLE_RECIPIENT_ROLES', 400);
  for (const prefill of part.prefill)
    if (
      activeRecipientIds.has(
        document.fields.find((field) => field.id === prefill.templateFieldId)!.recipientId,
      ) &&
      prefill.required &&
      (input.values[prefill.key] === undefined ||
        (typeof input.values[prefill.key] === 'string'
          ? !(input.values[prefill.key] as string).trim()
          : input.values[prefill.key].length === 0))
    )
      throw new BridgeError(`MISSING_VALUE:${prefill.key}`, 400);
  const recipients = activeRoles.map((role, index) => {
    const native = document.recipients.find((r) => r.id === role.templateRecipientId)!;
    return {
      email: bindings[index].email,
      name: bindings[index].name,
      role: native.role,
      signingOrder: native.signingOrder ?? undefined,
      fields: document.fields
        .filter((f) => f.recipientId === native.id)
        .map((field) => {
          const prefill = part.prefill.find((p) => p.templateFieldId === field.id);
          const value = prefill ? input.values[prefill.key] : undefined;
          const identifier = document.envelopeItems.findIndex(
            (item) => item.id === field.envelopeItemId,
          );
          if (identifier < 0) throw new BridgeError('TEMPLATE_ITEM_MISMATCH', 409);
          return {
            identifier,
            type: field.type,
            page: field.page,
            positionX: field.positionX,
            positionY: field.positionY,
            width: field.width,
            height: field.height,
            fieldMeta:
              value === undefined ? (field.fieldMeta ?? undefined) : prefillMeta(field, value),
          };
        }),
    };
  });
  const meta = createMeta(document.documentMeta);
  delete meta.redirectUrl;
  if (redirectUrl) meta.redirectUrl = redirectUrl;
  return {
    files,
    bindings,
    connection: target,
    payload: {
      title: `${input.title} — ${part.title}`,
      type: 'DOCUMENT',
      visibility: 'ADMIN',
      delegatedDocumentOwner: target.native_email,
      recipients,
      meta: { ...meta, distributionMethod: 'EMAIL' },
    },
  };
}

export function assertTemplateVersion(
  document: NativeEnvelope,
  part: PublishedPart,
  hashes: string[],
) {
  if (templateFingerprint(document, hashes) !== part.fingerprint)
    throw new BridgeError('PUBLISHED_TEMPLATE_CHANGED', 409);
}

// Company drafts are generated from an approved package. A native administrator
// edit must not silently change its fields or routing before Portal sends it.
export function assertHrDraft(document: NativeEnvelope, snapshot: Record<string, unknown>) {
  type Field = {
    identifier: number;
    type: string;
    page: number;
    positionX: number;
    positionY: number;
    width: number;
    height: number;
    fieldMeta?: Record<string, unknown>;
  };
  type Recipient = {
    email: string;
    name: string;
    role: string;
    signingOrder?: number;
    fields: Field[];
  };
  const recipients = snapshot.recipients as Recipient[];
  function includes(actual: unknown, expected: unknown): boolean {
    if (expected === undefined) return true;
    if (Array.isArray(expected))
      return (
        Array.isArray(actual) &&
        actual.length === expected.length &&
        expected.every((value, index) => includes(actual[index], value))
      );
    if (expected !== null && typeof expected === 'object')
      return (
        actual !== null &&
        typeof actual === 'object' &&
        Object.entries(expected).every(([key, value]) =>
          includes((actual as Record<string, unknown>)[key], value),
        )
      );
    return actual === expected;
  }
  const valid =
    document.status === 'DRAFT' &&
    document.recipients.length === recipients.length &&
    document.fields.length ===
      recipients.reduce((count, recipient) => count + recipient.fields.length, 0) &&
    includes(document.documentMeta, snapshot.meta) &&
    recipients.every((expected) => {
      const native = document.recipients.find(
        (r) =>
          r.email.toLowerCase() === expected.email &&
          r.name === expected.name &&
          r.role === expected.role &&
          (expected.signingOrder === undefined || r.signingOrder === expected.signingOrder),
      );
      if (!native) return false;
      return expected.fields.every(
        (field) =>
          document.fields.filter(
            (candidate) =>
              candidate.recipientId === native.id &&
              candidate.envelopeItemId === document.envelopeItems[field.identifier]?.id &&
              candidate.type === field.type &&
              candidate.page === field.page &&
              (['positionX', 'positionY', 'width', 'height'] as const).every(
                (key) => Math.abs(candidate[key] - field[key]) <= 0.03,
              ) &&
              includes(candidate.fieldMeta, field.fieldMeta),
          ).length === 1,
      );
    });
  if (!valid) throw new BridgeError('HR_DRAFT_CHANGED', 409);
}

// One native envelope, independent PDF items. Roles are unified by the reviewed
// business key, never by email or by native template recipient IDs.
export function composePreparedParts(
  parts: PreparedPart[],
  title: string,
  signingOrder: 'PARALLEL' | 'SEQUENTIAL',
): PreparedPart {
  if (!parts.length) throw new BridgeError('EMPTY_PACKAGE', 400);
  type Recipient = {
    email: string;
    name: string;
    role: string;
    signingOrder?: number;
    fields: Array<Record<string, unknown> & { identifier: number }>;
  };
  const bindings: PreparedPart['bindings'] = [];
  const recipients: Recipient[] = [];
  const files: PreparedPart['files'] = [];
  for (const part of parts) {
    if (part.connection.id !== parts[0].connection.id)
      throw new BridgeError('PACKAGE_COMPANY_MISMATCH', 409);
    const offset = files.length;
    const native = part.payload.recipients as Recipient[];
    part.bindings.forEach((binding, index) => {
      if (!['SIGNER', 'APPROVER'].includes(binding.role))
        throw new BridgeError('PACKAGE_ROLE_NOT_SUPPORTED', 400);
      const fields = native[index].fields.map((field) => ({
        ...field,
        identifier: field.identifier + offset,
      }));
      const found = bindings.findIndex((b) => b.key === binding.key);
      if (found < 0) {
        bindings.push({ ...binding });
        recipients.push({ ...native[index], fields });
      } else {
        const previous = bindings[found];
        if (
          previous.actor !== binding.actor ||
          previous.email !== binding.email ||
          previous.name !== binding.name
        )
          throw new BridgeError('PACKAGE_ROLE_MISMATCH', 400);
        // The same agent can acknowledge a disclosure and sign an agreement.
        // Their signature duty wins; no approval or signature is fabricated.
        if (binding.role === 'SIGNER') previous.role = 'SIGNER';
        recipients[found].role = previous.role;
        recipients[found].fields.push(...fields);
      }
    });
    files.push(...part.files);
  }
  if (new Set(bindings.map((r) => `${r.email}:${r.role}:${r.name}`)).size !== bindings.length)
    throw new BridgeError('INDISTINGUISHABLE_RECIPIENT_ROLES', 400);
  if (
    files.length > 10 ||
    files.reduce((size, file) => size + file.bytes.length, 0) > 100 * 1024 * 1024
  )
    throw new BridgeError('PACKAGE_TOO_LARGE', 413);
  recipients.forEach((recipient, index) => {
    if (signingOrder === 'SEQUENTIAL') recipient.signingOrder = index + 1;
    else delete recipient.signingOrder;
  });
  return {
    connection: parts[0].connection,
    files,
    bindings,
    payload: {
      ...parts[0].payload,
      title,
      recipients,
      meta: {
        ...(parts[0].payload.meta as Record<string, unknown>),
        signingOrder,
        allowDictateNextSigner: false,
      },
    },
  };
}
