# Third-party notices

Kevv eSign uses the packages listed in `pnpm-lock.yaml`, each under its own license.

Documenso is the sole signing engine. The production image is the unmodified official Documenso 2.18.0 distribution, pinned by digest. Corresponding source: https://github.com/documenso/documenso/tree/389390c884949fe27c240488a3259da3cdba93e0. Preserve Documenso's AGPL-3.0 notices and source links. This repository does not vendor its signing or editor code.

The optional domain gateway uses the official Nginx stable Alpine image pinned in `apps/gateway/Dockerfile`. Nginx and Alpine retain their upstream license notices in the image. The gateway only forwards HTTP requests; it does not modify PDFs or implement signatures.
