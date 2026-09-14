import type { NativeEnvelope, NativeField } from './documenso.js';
export function safeFilename(title: string) {
  // Strip filesystem and HTTP control characters from archive entry names.
  return (
    title
      .replace(/\.pdf$/i, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120) || 'document'
  );
}
// Only display values and geometry; never expose native recipient tokens or storage IDs.
export function previewField(field: NativeField, document: NativeEnvelope) {
  const meta = field.fieldMeta ?? {};
  const choices = Array.isArray(meta.values)
    ? (meta.values as Array<{ value: string; checked?: boolean }>)
    : [];
  const value =
    field.type === 'TEXT'
      ? meta.text
      : field.type === 'NUMBER'
        ? meta.value
        : field.type === 'DROPDOWN'
          ? meta.defaultValue
          : ['CHECKBOX', 'RADIO'].includes(field.type)
            ? choices
                .filter((v) => v.checked)
                .map((v) => v.value)
                .join(' / ')
            : '';
  return {
    id: field.id,
    page: field.page,
    x: field.positionX,
    y: field.positionY,
    width: field.width,
    height: field.height,
    type: field.type,
    value: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
    readOnly: Boolean(meta.readOnly),
    required: meta.required !== false,
    recipient: document.recipients.find((r) => r.id === field.recipientId)?.name ?? '',
    label: typeof meta.label === 'string' ? meta.label : '',
  };
}

export function attachmentDisposition(name: string) {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="signing-document.${name.endsWith('.zip') ? 'zip' : 'pdf'}"; filename*=UTF-8''${encoded}`;
}
