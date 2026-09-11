# PDF completion font

Noto Sans CJK SC Regular, unmodified, from the [Noto CJK project](https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf). Retrieved 2026-09-11.

SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.

The original SIL Open Font License is included in `OFL.txt`; copyright metadata is preserved in the font. Both API and finalizer images copy this directory. The renderer embeds a subset containing the characters used in each completed PDF, including Chinese names and certificate text. It does not depend on system fonts or fetch fonts at runtime.

Subsetting uses upstream `fontkit` 2 through `src/pdf-font.ts`. The legacy `@pdf-lib/fontkit` encoder produced missing CJK outlines even when the PDF ToUnicode map was correct; the actual rendered signed page and certificate must be checked when changing this bridge or font asset.
