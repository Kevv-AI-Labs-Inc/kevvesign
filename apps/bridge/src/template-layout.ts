import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { BridgeError } from './model.js';
import { canonical, type NativeEnvelope } from './documenso.js';

const geometry = {
  identifier: z.number().int().min(0).max(9),
  page: z.number().int().min(1).max(500),
  positionX: z.number().min(0).max(100),
  positionY: z.number().min(0).max(100),
  width: z.number().positive().max(100),
  height: z.number().positive().max(100),
};
const label = z.string().max(100).optional();
const fontSize = z.number().min(8).max(96).optional();
const field = z
  .discriminatedUnion('type', [
    z
      .object({
        ...geometry,
        type: z.literal('TEXT'),
        fieldMeta: z
          .object({
            type: z.literal('text'),
            label,
            fontSize,
            readOnly: z.boolean(),
            text: z.string().max(10000).optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...geometry,
        type: z.literal('SIGNATURE'),
        fieldMeta: z
          .object({
            type: z.literal('signature'),
            label,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...geometry,
        type: z.literal('DATE'),
        fieldMeta: z
          .object({
            type: z.literal('date'),
            label,
            fontSize,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...geometry,
        type: z.literal('INITIALS'),
        fieldMeta: z
          .object({
            type: z.literal('initials'),
            label,
            fontSize,
          })
          .strict(),
      })
      .strict(),
  ])
  .refine(
    (f) => f.positionX + f.width <= 100 && f.positionY + f.height <= 100,
    'Field must fit inside the page',
  );

// Draft company templates only. Recipient email addresses, native IDs, document
// status, callbacks and signature contents cannot be supplied by the uploader.
export const templateLayoutSchema = z
  .object({
    recipients: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            role: z.enum(['SIGNER', 'APPROVER']),
            fields: z.array(field).min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((layout, ctx) => {
    if (layout.recipients.reduce((n, r) => n + r.fields.length, 0) > 500)
      ctx.addIssue({ code: 'custom', message: 'Too many fields' });
    for (const recipient of layout.recipients) {
      if (recipient.role === 'SIGNER' && !recipient.fields.some((f) => f.type === 'SIGNATURE'))
        ctx.addIssue({ code: 'custom', message: 'Signer needs a signature field' });
      if (recipient.role === 'APPROVER' && recipient.fields.some((f) => f.type !== 'TEXT'))
        ctx.addIssue({ code: 'custom', message: 'Approval does not create a signature' });
      const locations = recipient.fields.map((f) =>
        canonical([f.identifier, f.page, f.type, f.positionX, f.positionY, f.width, f.height]),
      );
      if (new Set(locations).size !== locations.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate field placement' });
    }
  });
export type TemplateLayout = z.infer<typeof templateLayoutSchema>;

export async function assertTemplatePages(
  layout: TemplateLayout,
  files: Array<{ bytes: Uint8Array }>,
) {
  const counts: number[] = [];
  try {
    for (const file of files)
      counts.push((await PDFDocument.load(file.bytes, { updateMetadata: false })).getPageCount());
  } catch {
    throw new BridgeError('INVALID_PDF_UPLOAD', 400);
  }
  if (
    layout.recipients.some((r) =>
      r.fields.some((f) => !counts[f.identifier] || f.page > counts[f.identifier]),
    )
  )
    throw new BridgeError('TEMPLATE_PAGE_MISMATCH', 400);
}

export function templateRecipients(layout: TemplateLayout) {
  return layout.recipients.map((recipient, index) => ({
    ...recipient,
    email: `template-role-${index + 1}@example.invalid`,
    signingOrder: index + 1,
  }));
}

export function assertTemplateLayout(native: NativeEnvelope, layout: TemplateLayout) {
  const expected = templateRecipients(layout);
  if (
    native.recipients.length !== expected.length ||
    native.fields.length !== expected.reduce((n, r) => n + r.fields.length, 0)
  )
    throw new BridgeError('TEMPLATE_LAYOUT_MISMATCH', 409);
  for (const recipient of expected) {
    const actual = native.recipients.find((r) => r.email === recipient.email);
    if (
      !actual ||
      actual.name !== recipient.name ||
      actual.role !== recipient.role ||
      actual.signingOrder !== recipient.signingOrder
    )
      throw new BridgeError('TEMPLATE_LAYOUT_MISMATCH', 409);
    const fields = native.fields.filter((f) => f.recipientId === actual.id);
    if (fields.length !== recipient.fields.length)
      throw new BridgeError('TEMPLATE_LAYOUT_MISMATCH', 409);
    for (const field of recipient.fields) {
      const matches = fields.filter(
        (f) =>
          f.type === field.type &&
          f.page === field.page &&
          f.envelopeItemId === native.envelopeItems[field.identifier]?.id &&
          (['positionX', 'positionY', 'width', 'height'] as const).every(
            (k) => Math.abs(f[k] - field[k]) <= 0.03,
          ),
      );
      if (
        matches.length !== 1 ||
        Object.entries(field.fieldMeta).some(
          ([k, v]) => canonical(matches[0].fieldMeta?.[k]) !== canonical(v),
        )
      )
        throw new BridgeError('TEMPLATE_LAYOUT_MISMATCH', 409);
    }
  }
}
