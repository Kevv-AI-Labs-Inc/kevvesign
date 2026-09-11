import { PNG } from 'pngjs';
import type { SignatureAdoption } from '@esign/contracts';
import { DomainError } from '@esign/domain';

export function validateSignatureMark(
  signature: Pick<SignatureAdoption, 'kind' | 'value' | 'intentText'>,
): void {
  const invalid = () =>
    new DomainError(
      'invalid_signature',
      'Enter a name or draw a visible signature and accept the signing intent.',
      422,
    );
  if (!signature.intentText.trim() || signature.value.length > 250_000) throw invalid();
  if (signature.kind === 'typed') {
    if (
      !signature.value.trim() ||
      signature.value.length > 200 ||
      signature.value.startsWith('data:')
    )
      throw invalid();
    return;
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signature.value)) throw invalid();
  const bytes = Buffer.from(signature.value.slice('data:image/png;base64,'.length), 'base64');
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw invalid();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000)
    throw invalid();
  try {
    const { data } = PNG.sync.read(bytes, { checkCRC: true });
    for (let i = 0; i < data.length; i += 4) {
      // Invisible/white canvases would leave no discernible mark on the signed PDF.
      if (data[i + 3]! > 16 && Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < 240) return;
    }
  } catch {
    throw invalid();
  }
  throw invalid();
}
