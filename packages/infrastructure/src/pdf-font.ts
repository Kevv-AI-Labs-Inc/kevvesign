import { Readable } from 'node:stream';
import { create } from 'fontkit';
import type { PDFDocument } from 'pdf-lib';
type Fontkit = Parameters<PDFDocument['registerFontkit']>[0];

/** Bridge fontkit 2's synchronous subset encoder to pdf-lib's stream interface.
 * The old pdf-lib fork emits invalid CJK subsets; keep the upstream glyph encoder.
 */
export const completionFontkit: Fontkit = {
  create(bytes: Uint8Array) {
    const font = create(Buffer.from(bytes));
    if ('fonts' in font) throw new Error('PDF completion requires a single font.');
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => {
      const subset = createSubset();
      return Object.assign(subset, { encodeStream: () => Readable.from([subset.encode()]) });
    };
    // Upstream types omit the CFF/head/post tables that pdf-lib reads at runtime.
    return font as unknown as ReturnType<Fontkit['create']>;
  },
};
