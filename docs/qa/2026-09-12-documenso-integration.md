# Documenso integration acceptance · 2026-09-12

Status: **implementation and candidate deployment in progress; not a completed public release**.

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
| eSign full verification    | `pnpm verify` passed: formatting, ESLint, all workspace typechecks, 60 tests / 13 test files, coverage and full workspace builds; bridge tests included, native legacy coverage is not evidence of final Documenso completion           |
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

Latest deployed bridge digest: `sha256:b17f6f0a77eb8e880d1052e6ba5f51ff05a0e9060b716f769557aefb0fb28905`.

The local browser uses disposable `example.invalid` accounts, isolated PostgreSQL, Mailpit and local S3-compatible storage. No real employee was activated, no real payment executed and no company/person signature applied as QA. Production setup created approved blank templates and configuration, not new real employee signing requests.

## Still required

1. The final synthetic **Sign** confirmation previously requested from the user is still pending. Do not treat selecting a signature mark, opening a signer UI or distributing a document as completed signing.
2. Finish actual multi-recipient completion; verify native completed status, sealed PDF integrity, native certificate/audit and byte-preserving downloads through both services. Record native completion and Portal callback separately.
3. Complete remaining native onboarding/custom acceptance, final build and protected candidate smoke after the last local fixes.
4. Bind the canonical eSign domain and promote the final Portal candidate. Verify links and native sign-in after the domain change.
5. Retire the replaced native code/runtime/defaults and record the stopped resources, preserving original business data/storage.
6. Before enabling actual buyer/seller packages, obtain the company's approved files/roles and publish validated versions. The capability exists; legal content is not invented.
7. Customer editor accounts require per-agent native identity/team setup and a verified connection. HR is configured; ordinary agent connections have not been mass-created.

The service P12 is a self-signed integrity seal, not an AATL/personal certificate. Final sealing remains unverified until real synthetic completion. Existing Supabase security-advisor warnings predate this change (mutable search paths and an unrelated RLS helper executable by public app roles); the new tables' no-policy INFO is intentional server-only access.

## Final source checkpoint

Portal source commits `6058df3` and `950cf19`; eSign bridge source commit `8d1c82d`. Latest local Portal production build and targeted storage/pending-session regressions passed. ESLint has zero errors and one pre-existing generated workflow warning. Per-agent real-session training authorization and same-JWT revocation both passed.

Final Portal candidate `dpl_5ECwL4pswEqL4UN7BRnSoZBi9q6b` / `https://homixliving-iwyama71e-erics-projects-9449aac9.vercel.app` is **Ready**; it includes the latest source fixes and was deployed with `--skip-domain`. No canonical domain promotion, actual signature or native retirement has occurred.

Candidate smoke found and fixed a middleware issue: the exact POST `/api/signing/events` must reach its HMAC handler without a browser session. All other signing routes remain protected. Regression tests verify the method/path boundary. Full local HTTP verifies unsigned callback 401, authenticated malformed payload 400, real native HR-state refresh, durable inbox and safe replay. The new production candidate containing this fix is Ready. Its real HTTP authentication test passes: missing signature 401 / INVALID_EVENT_SIGNATURE; correct production HMAC with malformed empty event 400 / INVALID_REQUEST. No production inbox/business row is created by that test. Bridge package API without credentials returns 401. Canonical domains remain unchanged.

## Custom document and developer-entry follow-up

- Portal commit `242d387` removes the silent Homix Realty default for custom documents. The form requires an explicit company; selecting Homix Living was verified in the UI.
- Real local HTTP exercised custom upload through Portal, private local S3, bridge and Documenso. Request `1ec92d21-1647-49e2-afcd-da73a673e4aa` maps to native `envelope_zwsdnknzzkdokzrb`, retains Homix Living in its business snapshot, deduplicates retry, and returns the original PDF bytes and exact owner's editor URL.
- Native UI added Synthetic Custom Signer and two fields; both fields persisted after reload. Native Send changed the document to Pending; local Mailpit received one matching synthetic invitation. Portal returned to the same task and displayed the current recipient and waiting status. No final signature has been applied.
- eSign commit `0ab670e` changes `pnpm dev` and the root environment example to bridge defaults, retaining explicitly named legacy commands only until the retirement gate. CI compiles all seven old/new Bicep entry points. Frozen offline dependency resolution and the matching Bicep/format checks passed.
- The latest Portal candidate is Ready. Final native signature/seal acceptance, canonical cutover and removal of old native code/runtime remain outstanding pending the previously requested final-sign confirmation.
