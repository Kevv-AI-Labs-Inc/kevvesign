import { describe, expect, it } from 'vitest';
import {
  assertTemplateLayout,
  templateLayoutSchema,
  templateRecipients,
} from '../template-layout.js';
import type { NativeEnvelope } from '../documenso.js';

const signature = {
  identifier: 0,
  type: 'SIGNATURE',
  page: 1,
  positionX: 10,
  positionY: 70,
  width: 30,
  height: 8,
  fieldMeta: { type: 'signature', label: 'Consumer signature' },
};
const input = { recipients: [{ name: 'Consumer', role: 'SIGNER', fields: [signature] }] };

describe('new company template layouts', () => {
  it('generates non-deliverable placeholder addresses and fixed distinct signing ranks', () => {
    const layout = templateLayoutSchema.parse(input);
    expect(templateRecipients(layout)[0]).toMatchObject({
      email: 'template-role-1@example.invalid',
      signingOrder: 1,
    });
    for (const extra of [
      { email: 'customer@example.com' },
      { token: 'secret' },
      { signingOrder: 8 },
    ])
      expect(
        templateLayoutSchema.safeParse({ recipients: [{ ...input.recipients[0], ...extra }] })
          .success,
      ).toBe(false);
    expect(templateLayoutSchema.safeParse({ ...input, status: 'PENDING' }).success).toBe(false);
    expect(
      templateLayoutSchema.safeParse({ ...input, meta: { redirectUrl: 'https://evil.invalid' } })
        .success,
    ).toBe(false);
  });
  it('rejects unfinishable, out-of-page, overlapping duplicate and signed fields', () => {
    for (const replacement of [
      { ...signature, positionX: 95 },
      { ...signature, height: 31 },
      { ...signature, page: 0 },
      { ...signature, identifier: -1 },
      { ...signature, fieldMeta: { ...signature.fieldMeta, text: 'forged' } },
      { ...signature, fieldMeta: { ...signature.fieldMeta, readOnly: true } },
      { ...signature, type: 'DATE', fieldMeta: { type: 'date' } },
    ])
      expect(
        templateLayoutSchema.safeParse({
          recipients: [{ ...input.recipients[0], fields: [replacement] }],
        }).success,
      ).toBe(false);
    expect(
      templateLayoutSchema.safeParse({ recipients: [{ ...input.recipients[0], role: 'APPROVER' }] })
        .success,
    ).toBe(false);
    expect(
      templateLayoutSchema.safeParse({
        recipients: [{ ...input.recipients[0], fields: [signature, signature] }],
      }).success,
    ).toBe(false);
  });
  it('checks actual native recipient identity, geometry, field ownership and metadata after upload', () => {
    const layout = templateLayoutSchema.parse(input);
    const native = {
      recipients: [{ id: 5, ...templateRecipients(layout)[0] }],
      envelopeItems: [{ id: 'first' }],
      fields: [{ ...signature, id: 9, recipientId: 5, envelopeItemId: 'first' }],
    } as unknown as NativeEnvelope;
    expect(() => assertTemplateLayout(native, layout)).not.toThrow();
    for (const mutate of [
      (n: NativeEnvelope) => {
        n.recipients[0].email = 'other@example.invalid';
      },
      (n: NativeEnvelope) => {
        n.recipients[0].signingOrder = 2;
      },
      (n: NativeEnvelope) => {
        n.fields[0].recipientId = 6;
      },
      (n: NativeEnvelope) => {
        n.fields[0].page = 2;
      },
      (n: NativeEnvelope) => {
        n.fields[0].positionX = 15;
      },
      (n: NativeEnvelope) => {
        n.fields[0].fieldMeta = { type: 'signature', label: 'Changed' };
      },
      (n: NativeEnvelope) => {
        n.fields = [];
      },
    ]) {
      const altered = structuredClone(native);
      mutate(altered);
      expect(() => assertTemplateLayout(altered, layout)).toThrow('TEMPLATE_LAYOUT_MISMATCH');
    }
  });
});
