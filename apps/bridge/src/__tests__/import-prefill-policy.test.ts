import { describe, expect, it } from 'vitest';
import { assertNativePrefillPolicy } from '../cli/import-prefill-policy.js';
import { prefillMeta } from '../packages.js';

function fixture() {
  return {
    context: { scenario: 'onboarding', companyKey: 'homix_realty' },
    field: {
      key: 'realty.libor_cell_phone',
      actor: 'owner' as 'owner' | 'company',
      mergeKey: 'agent_phone',
      required: false,
      native: {
        type: 'TEXT',
        fieldMeta: { type: 'text', readOnly: false, required: true },
      },
    },
    native: {
      id: 1,
      recipientId: 1,
      envelopeItemId: 'synthetic-file',
      type: 'TEXT',
      page: 19,
      positionX: 10,
      positionY: 20,
      width: 30,
      height: 5,
      inserted: false,
      fieldMeta: { type: 'text', readOnly: false, required: true },
    },
  };
}

describe('approved onboarding contact prefill exception', () => {
  it.each(['', '555-0100'])('permits an editable required phone prefilled with %j', (phone) => {
    const { field, native, context } = fixture();
    expect(() => assertNativePrefillPolicy(field, native, context)).not.toThrow();
    expect(prefillMeta(native, phone)).toEqual({
      type: 'text',
      readOnly: false,
      required: true,
      text: phone,
    });
  });

  const mutations: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
    ['another field', ({ field }) => (field.key = 'realty.libor_legal_name')],
    ['another merge key', ({ field }) => (field.mergeKey = 'agent_name')],
    ['company recipient', ({ field }) => (field.actor = 'company')],
    ['required package prefill', ({ field }) => (field.required = true)],
    ['another native type', ({ field }) => (field.native.type = 'DATE')],
    ['another metadata type', ({ field }) => (field.native.fieldMeta.type = 'date')],
    ['readonly manifest', ({ field }) => (field.native.fieldMeta.readOnly = true)],
    ['optional native field', ({ field }) => (field.native.fieldMeta.required = false)],
    ['another company', ({ context }) => (context.companyKey = 'homix_living')],
    ['another scenario', ({ context }) => (context.scenario = 'team_leader')],
    ['native type drift', ({ native }) => (native.type = 'DATE')],
    ['native metadata drift', ({ native }) => (native.fieldMeta.type = 'date')],
    ['native readonly drift', ({ native }) => (native.fieldMeta.readOnly = true)],
    ['native required drift', ({ native }) => (native.fieldMeta.required = false)],
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => assertNativePrefillPolicy(input.field, input.native, input.context)).toThrow(
      'Native business field must be readonly',
    );
  });

  it.each(['agent_id', 'agent_name', 'compensation_plan', 'sponsor_name', 'team_name'])(
    'keeps %s business prefills readonly',
    (key) => {
      const { field, native, context } = fixture();
      field.key = key;
      field.mergeKey = key;
      expect(() => assertNativePrefillPolicy(field, native, context)).toThrow();
      field.native.fieldMeta.readOnly = true;
      native.fieldMeta.readOnly = true;
      expect(() => assertNativePrefillPolicy(field, native, context)).not.toThrow();
      expect(() =>
        assertNativePrefillPolicy(field, { ...native, fieldMeta: null }, context),
      ).toThrow();
    },
  );

  it('does not change non-prefill signer fields', () => {
    const { field, native, context } = fixture();
    expect(() =>
      assertNativePrefillPolicy({ ...field, mergeKey: undefined }, native, context),
    ).not.toThrow();
  });
});
