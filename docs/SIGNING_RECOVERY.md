# Signing recovery

Native signing saves draft fields and adopted signature marks after editing, before the recipient explicitly finishes. Closing the page after “All changes saved” preserves progress. Unsaved edits stay in memory during network failures, and leaving the page warns before discarding them.

Invitation links are reusable until they expire or are replaced. A finished recipient sees a completion message when revisiting. Network errors and rate limits offer retry instead of claiming the invitation expired. Expired browser sessions are exchanged once again using the invitation, with the original envelope and recipient checked before retrying any mutation.

Draft writes include a per-recipient revision and envelope/recipient identifiers. A concurrent browser cannot silently overwrite a newer draft. These additive fields remain optional in the API during rolling deployment; the new UI always supplies them.

## Source-application continuation

`POST /v1/envelopes/:envelopeId/recipients/:recipientId/access` accepts `{ "authenticatedEmail": "..." }` from a trusted application with `envelopes:send`. The application must independently authenticate the person and verify ownership before calling. Staff sessions cannot call this endpoint. The email must match an active signer within the caller's allowed workspace and business domain.

The response contains a private signing URL. Never log, cache, email to a different person, or put it in an audit record. The server stores only token hashes and keeps at most five continuation links per recipient. Issuance is rate limited. Existing email invitations remain valid. Explicit resend rotates the invitation and revokes earlier links and sessions while retaining draft progress.

Provider-bound envelopes remain with their original provider. They return `email_resume_required`; use the provider invitation or resend. Deploying this change does not switch any workspace to Documenso.

## Read-only contract access

`GET /v1/envelopes/:envelopeId/documents/:documentId` requires `envelopes:read` and checks the envelope's workspace and business domain. It serves the original PDF without adopted signatures, with `private, no-store`. Completed PDFs continue to use the verified evidence package and `evidence:read`.

## Verification

Run `pnpm verify`, then `pnpm exec playwright test tests/e2e/signing-recovery.spec.ts tests/e2e/signing.spec.ts`. The tests use synthetic PDFs and local delivery, covering desktop Chrome, mobile Chrome and mobile Safari; reopening, network loss, session renewal, separate-device conflicts, explicit signing, completed revisits, and multi-document/multi-recipient completion. They do not send real invitations or sign production contracts.
