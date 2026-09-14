type ImportField = {
  key: string;
  actor: 'owner' | 'company';
  mergeKey?: string;
  required: boolean;
  native: { type: string; fieldMeta: Record<string, unknown> };
};

export function assertNativePrefillPolicy(
  field: ImportField,
  native: { type: string; fieldMeta: Record<string, unknown> | null },
  context: { scenario: string; companyKey: string },
) {
  if (!field.mergeKey) return;
  // Only this approved contact field may be filled/corrected by the applicant.
  // Blank contact data may enter preparation, but native signing requires it.
  const editableContact =
    context.scenario === 'onboarding' &&
    context.companyKey === 'homix_realty' &&
    field.key === 'realty.libor_cell_phone' &&
    field.actor === 'owner' &&
    field.mergeKey === 'agent_phone' &&
    field.required === false &&
    field.native.type === 'TEXT' &&
    field.native.fieldMeta.type === 'text' &&
    field.native.fieldMeta.readOnly === false &&
    field.native.fieldMeta.required === true;
  if (
    editableContact &&
    native.type === 'TEXT' &&
    native.fieldMeta?.type === 'text' &&
    native.fieldMeta.readOnly === false &&
    native.fieldMeta.required === true
  )
    return;
  if (native.fieldMeta?.readOnly !== true || field.native.fieldMeta.readOnly === false)
    throw new Error(`Native business field must be readonly: ${field.key}`);
}
