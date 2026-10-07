import type { NativeField } from './documenso.js';

// These are prompts in the approved legacy seller disclosures, not answers.
// Keep the seller's choice and explanatory text editable by that same signer.
const legacyDisclosurePrompts: Record<string, string> = {
  'Lead (a)：选择 (i) 已知含铅风险 / (ii) 卖家不知有风险':
    'Lead (a): select (i) known hazards or (ii) no known hazards',
  'Lead (a)：已知风险说明；选择 (i) 时填写': 'Lead (a): explain known hazards if (i) is selected',
  'Lead (b)：选择 (i) 已提供记录 / (ii) 没有记录':
    'Lead (b): select (i) records provided or (ii) no records',
  'Lead (b)：已提供的报告名称；选择 (i) 时填写':
    'Lead (b): list reports provided if (i) is selected',
};
const signerLabels: Record<string, string> = {
  SIGNATURE: 'Signature',
  INITIALS: 'Initials',
  DATE: 'Date',
  NAME: 'Full name',
  EMAIL: 'Email',
};

export function customerFieldMeta(
  field: NativeField,
  meta: Record<string, unknown> | undefined,
  optionalPrefill: boolean,
): Record<string, unknown> | undefined | null {
  if (!meta) return meta;
  const result = { ...meta };
  if (result.readOnly === true) {
    // Native 2.18 renders label before text until a field is inserted. Internal
    // authoring labels must not cover the actual value for another recipient.
    delete result.label;
    delete result.placeholder;
    // An empty read-only field cannot be completed in native signing and would
    // render a generic "Text" placeholder. Only omit optional mapped inputs;
    // never remove an editable disclosure answer or an unmapped template field.
    if (
      optionalPrefill &&
      field.type === 'TEXT' &&
      (result.text === undefined ||
        result.text === null ||
        (typeof result.text === 'string' && !result.text.trim()))
    )
      return null;
  } else if (typeof result.label === 'string' && legacyDisclosurePrompts[result.label]) {
    result.label = legacyDisclosurePrompts[result.label];
    delete result.placeholder;
  } else if (
    typeof result.label === 'string' &&
    /\p{Script=Han}/u.test(result.label) &&
    signerLabels[field.type]
  ) {
    result.label = signerLabels[field.type];
    delete result.placeholder;
  }
  return result;
}
