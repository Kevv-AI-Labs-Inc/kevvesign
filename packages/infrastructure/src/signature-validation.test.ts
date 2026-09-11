import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { validateSignatureMark } from './signature-validation';

function drawn(visible = false, white = false) {
  const png = new PNG({ width: 32, height: 12 });
  png.data.fill(white ? 255 : 0);
  if (visible)
    for (let x = 4; x < 28; x++) {
      const i = (6 * 32 + x) * 4;
      png.data[i] = 18;
      png.data[i + 1] = 60;
      png.data[i + 2] = 51;
      png.data[i + 3] = 255;
    }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
const intentText = 'I intend this to be my electronic signature.';
describe('signature input validation', () => {
  it('accepts a visible PNG stroke and multilingual typed names', () => {
    expect(() =>
      validateSignatureMark({ kind: 'drawn', value: drawn(true), intentText }),
    ).not.toThrow();
    expect(() =>
      validateSignatureMark({ kind: 'typed', value: '测试客户', intentText }),
    ).not.toThrow();
  });
  it.each([
    drawn(),
    drawn(false, true),
    'data:image/png;base64,aGVsbG8=',
    'data:image/svg+xml,<svg/>',
  ])('rejects blank or malformed drawn marks', (value) => {
    expect(() => validateSignatureMark({ kind: 'drawn', value, intentText })).toThrow();
  });
  it('bounds decompression and rejects forged typed image values', () => {
    const bytes = Buffer.from(drawn(true).split(',')[1]!, 'base64');
    bytes.writeUInt32BE(100_000, 16);
    expect(() =>
      validateSignatureMark({
        kind: 'drawn',
        value: `data:image/png;base64,${bytes.toString('base64')}`,
        intentText,
      }),
    ).toThrow();
    for (const value of ['   ', drawn(true), 'A'.repeat(201)]) {
      expect(() => validateSignatureMark({ kind: 'typed', value, intentText })).toThrow();
    }
    expect(() =>
      validateSignatureMark({ kind: 'typed', value: 'Alex', intentText: ' ' }),
    ).toThrow();
  });
});
