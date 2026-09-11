import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { completionFontkit } from './pdf-font';

it('retains the visually verified CJK glyph outlines, not just a valid ToUnicode map', async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(completionFontkit);
  const font = await pdf.embedFont(
    await readFile(new URL('../assets/NotoSansCJKsc-Regular.otf', import.meta.url)),
    { subset: true },
  );
  pdf
    .addPage([612, 792])
    .drawText('张买家 测试客户 客户签署测试 — Listing 与 Buyer', { x: 40, y: 700, size: 20, font });
  const result = await PDFDocument.load(await pdf.save());
  const subset = result.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .find(
      (object) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of('Subtype'))?.toString() === '/CIDFontType0C',
    );
  expect(subset).toBeInstanceOf(PDFRawStream);
  // This golden subset was independently rendered by Poppler and visually checked.
  // Changing the font/encoder requires reviewing actual glyphs before updating the hash.
  expect(
    createHash('sha256')
      .update(decodePDFRawStream(subset as PDFRawStream).decode())
      .digest('hex'),
  ).toBe('d34e6cebeb33ca06305272ec2fb58e5cd9b0417e68c217b29817442174948699');
});
