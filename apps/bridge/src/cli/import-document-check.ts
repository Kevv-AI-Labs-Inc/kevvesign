import { Documenso, sha256 } from '../documenso.js';

/** A TEMPLATE and a DOCUMENT can normalize the same PDF differently (AcroForm).
 * Check the actual native conversion before publishing. No recipients or mail.
 */
export async function verifyDocumentRoundTrip(
  provider: Pick<Documenso, 'list' | 'create' | 'get' | 'document' | 'deleteDraft'>,
  externalId: string,
  file: { name: string; bytes: Uint8Array },
) {
  const found: string[] = [];
  for (let page = 1; ; page++) {
    const result = await provider.list({ type: 'DOCUMENT', query: externalId, page });
    found.push(
      ...result.data.filter((item) => item.externalId === externalId).map((item) => item.id),
    );
    if (page >= result.totalPages) break;
  }
  if (found.length > 1)
    throw new Error('Duplicate import preflight drafts require operator review');
  const id =
    found[0] ||
    (await provider.create(
      {
        title: 'Template import verification — no recipients',
        type: 'DOCUMENT',
        visibility: 'ADMIN',
        externalId,
        recipients: [],
      },
      [file],
    ));
  const document = await provider.get(id);
  if (
    document.externalId !== externalId ||
    document.status !== 'DRAFT' ||
    document.recipients.length
  )
    throw new Error('Unexpected import preflight document; left untouched');
  try {
    if (
      document.envelopeItems.length !== 1 ||
      sha256(await provider.document(id, document.envelopeItems[0].id, 'original')) !==
        sha256(file.bytes)
    )
      throw new Error(
        'Native DOCUMENT changes the approved PDF. Remove PDF form structures (including empty AcroForm dictionaries), reapprove the static PDF, and use a new manifest version. Nothing was published or sent.',
      );
  } finally {
    await provider.deleteDraft(id);
  }
}
