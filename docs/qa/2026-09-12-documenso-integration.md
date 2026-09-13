# Documenso integration acceptance · 2026-09-12

Status (2026-09-13): **native signing acceptance complete; canonical eSign domain serves Documenso. Final Portal deployment and old API/finalizer shutdown remain pending.**

## Verified

| Area                       | Evidence / result                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native version             | Official Documenso 2.18.0 image digest pinned in deployment; real local API and native UI used                                                                                                                                          |
| Multi-document preparation | Two PDFs/two recipients created by native API; role and field placement retained; no replacement signing engine                                                                                                                         |
| Native editor              | Portal-created customer draft opens the exact native document; fields save and recover; Portal task remains open                                                                                                                        |
| Isolation                  | Synthetic A/B users cannot access each other's documents or HR documents in the native UI/API; Portal enforces matching owner and canonical verified aliases                                                                            |
| Continue signing           | Close native recipient tab, reload 390px Portal `/pending`, Continue returns the exact same recipient document; no duplicate envelope                                                                                                   |
| Delivery and callback      | Real local native distribution/webhooks, durable inbox, authenticated bridge→Portal callback, retry after failure; Mailpit captures only synthetic recipients                                                                           |
| HR package import          | 11 approved blank onboarding/Team Leader packages imported in local and production native instances; PDF hashes, explicit metadata, role/page/geometry mapping and restart checkpoints verified                                         |
| HR send controls           | Unit checks plus real native draft-shape validation; controlled HR fields, recipients, routing and original hashes checked before bridge send                                                                                           |
| eSign full verification    | After native source retirement, `pnpm verify` passed with 12 bridge boundary tests, formatting, lint, typechecks and build; the separate real-native API/DB regression passed. Previous 60-test results included the retired engine     |
| Portal regressions         | Complete npm test run against isolated PostgreSQL, build and typecheck pass; admin DB tests cover concurrent receipts, no early settlement, paper/historical requirements, scoped access, expiry/revocation and activation independence |
| Browser paper flow         | Real local S3-compatible upload, pending verification, missing-identity 409, accepted paper record with company signature still outstanding and account pending                                                                         |
| HR file authorization      | Actual uploaded PDF/download SHA-256 equal; unrelated agent receives 404; manual verification does not write an electronic signed state                                                                                                 |
| Limited access browser/API | Training-only grant saved in the mobile admin panel; limited workspace exposes training only; actual session denies resources/customer signing; revoking through UI immediately rejects the same old JWT at the training API            |
| Mobile UI                  | 390px pending resume, signing task/package preview and admin four-area forms exercised; submitted onboarding profile collapsed; paper dates and audit labels corrected                                                                  |
| Production services        | New private PG16 and separate runtime database logins; cross-database access denied; official native app and bridge healthy                                                                                                             |
| Company identity           | User confirmed Si Zhang / hr@homixny.com for both companies; real native account/team mappings created, separate team webhooks configured                                                                                               |
| SMTP                       | Dedicated ACS SMTP application, TLS/auth success, no actual email sent during production setup                                                                                                                                          |
| Portal candidate           | Vercel `--prod --skip-domain` candidate built Ready; signing API protected by login; canonical domains not promoted                                                                                                                     |
| Portal migration           | Additive migration applied to Supabase homix; five new tables RLS-enabled and no anon/authenticated grants                                                                                                                              |

Latest deployed bridge digest: `sha256:8350858e5f3b01b935a6abbb53082a1304b87014f707deb0145e4d80bfda8494`.

The local browser uses disposable `example.invalid` accounts, isolated PostgreSQL, Mailpit and local S3-compatible storage. No real employee was activated, no real payment executed and no company/person signature applied as QA. Production setup created approved blank templates and configuration, not new real employee signing requests.

## Remaining release work

1. Upload and promote the final Portal source (production build passed). Automatic approval review requires explicit permission to upload this specific source payload to the existing Vercel project; that question remains pending. The previously Ready candidate has not been promoted.
2. After Portal cutover, stop the old API revision, disable the old finalizer Event trigger and remove obsolete Portal native environment pins. Preserve business SQL, historical files/storage and the independent Email Service.
3. Company-approved buyer/seller files and roles are required before publishing real legal packages; per-agent native editor identities/connections must be set up before those users edit customer contracts.

The service P12 is a self-signed integrity seal, not an AATL/personal certificate. Actual native sealing and CMS verification passed on synthetic files. Existing unrelated Supabase advisor warnings are outside this change.

The following checkpoints are historical; current results and outstanding gates are recorded above and in `2026-09-12-production-candidate.json`.

## Historical candidate checkpoint

Portal source commits `6058df3` and `950cf19`; eSign bridge source commit `8d1c82d`. Latest local Portal production build and targeted storage/pending-session regressions passed. ESLint has zero errors and one pre-existing generated workflow warning. Per-agent real-session training authorization and same-JWT revocation both passed.

Final Portal candidate `dpl_5ECwL4pswEqL4UN7BRnSoZBi9q6b` / `https://homixliving-iwyama71e-erics-projects-9449aac9.vercel.app` is **Ready**; it includes the latest source fixes and was deployed with `--skip-domain`. No canonical domain promotion, actual signature or native retirement has occurred.

Candidate smoke found and fixed a middleware issue: the exact POST `/api/signing/events` must reach its HMAC handler without a browser session. All other signing routes remain protected. Regression tests verify the method/path boundary. Full local HTTP verifies unsigned callback 401, authenticated malformed payload 400, real native HR-state refresh, durable inbox and safe replay. The new production candidate containing this fix is Ready. Its real HTTP authentication test passes: missing signature 401 / INVALID_EVENT_SIGNATURE; correct production HMAC with malformed empty event 400 / INVALID_REQUEST. No production inbox/business row is created by that test. Bridge package API without credentials returns 401. Canonical domains remain unchanged.

## Historical preparation checkpoint

- Portal commit `242d387` removes the silent Homix Realty default for custom documents. The form requires an explicit company; selecting Homix Living was verified in the UI.
- Real local HTTP exercised custom upload through Portal, private local S3, bridge and Documenso. Request `1ec92d21-1647-49e2-afcd-da73a673e4aa` maps to native `envelope_zwsdnknzzkdokzrb`, retains Homix Living in its business snapshot, deduplicates retry, and returns the original PDF bytes and exact owner's editor URL.
- Native UI added Synthetic Custom Signer and two fields; both fields persisted after reload. Native Send changed the document to Pending; local Mailpit received one matching synthetic invitation. Portal returned to the same task and displayed the current recipient and waiting status. No final signature has been applied.
- eSign commit `0ab670e` changes `pnpm dev` and the root environment example to bridge defaults, retaining explicitly named legacy commands only until the retirement gate. CI compiles all seven old/new Bicep entry points. Frozen offline dependency resolution and the matching Bicep/format checks passed.
- The latest Portal candidate is Ready. Final native signature/seal acceptance, canonical cutover and removal of old native code/runtime remain outstanding pending the previously requested final-sign confirmation.

## 2026-09-13 final native signing acceptance

The user confirmed final synthetic signing. Three actual workflows completed in official Documenso 2.18.0: two recipients signing two buyer fixture PDFs; a custom Homix Living upload prepared in the native editor; and an onboarding applicant followed by a separate synthetic company signer. No real company/person contract or payment was executed.

The native `COMPLETED` state, signed timestamps, native certificate and audit downloads were verified. Signed files from Documenso and the bridge were identical; the custom signed file downloaded through Portal was also byte-identical. OpenSSL verified the CMS signature and full-file ByteRange coverage for both multi-file samples. See [synthetic completion evidence](../../../homixliving/docs/qa/2026-09-12-signing-integration/evidence/2026-09-13-native-completion/acceptance.json).

The real native onboarding recipient/completion events passed through the durable bridge inbox/outbox and actual Portal HMAC endpoint. After applicant signing, Portal recorded the applicant timestamp and kept company signature absent. After company signing, both signatures and completion time were populated. The unpaid synthetic account remained pending throughout. Native custom signing redirected to the exact Portal task, visibly showing completed status and signed file/certificate/audit links.

The original low-level buyer fixture redirected to an unused localhost:3000 harness after signing; the actual Portal custom flow correctly returned to localhost:3119. Production return origins are explicit trusted client configuration, not browser parameters.

Old Portal native client, publisher/verifier and unused native policy code were removed. Approved contract files and the Documenso package/geometry export remain. Production domain cutover and old runtime shutdown are being finalized; final release state is recorded in `2026-09-12-production-candidate.json`.

## 2026-09-13 canonical eSign verification

The official engine is live at `https://esign.kevv.ai` through a small Nginx gateway preserving the existing TLS binding. Gateway and bridge use pinned images; all 11 HR templates and both company identities were verified through the canonical path. See `evidence/2026-09-13-native-completion/canonical-native-proof.json`. No real request or email was created. Source retirement is committed in eSign `4800b44` and Portal `8902c23`; only the old API/finalizer runtime stop and Portal final release remain coordinated work.

Portal final source `586d621` passes the full Webpack production build, TypeScript, 120 static pages and targeted lint. The necessary rental-page component extraction preserves its form implementation unchanged. Final upload/promotion remains pending the requested specific Vercel payload authorization.
