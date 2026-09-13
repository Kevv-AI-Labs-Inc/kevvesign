# Documenso integration acceptance · 2026-09-12

Status (2026-09-13): **Released through both GitHub PR/CI workflows. Canonical Portal and eSign serve the Documenso integration; legacy API has zero replicas, legacy finalizer automatic execution is disabled, and 50 obsolete Portal settings are removed.**

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
| Portal production          | Git integration on `main`; PR #27 and main CI passed, deployment `dpl_JCKosGCrTxwEgf3Dfsx697MTC37n` Ready on `agents.homixny.com`; actual admin session and authenticated callback boundary verified                                    |
| Portal migration           | Additive migration applied to Supabase homix; five new tables RLS-enabled and no anon/authenticated grants                                                                                                                              |

Latest deployed bridge digest: `sha256:8350858e5f3b01b935a6abbb53082a1304b87014f707deb0145e4d80bfda8494`.

The local browser uses disposable `example.invalid` accounts, isolated PostgreSQL, Mailpit and local S3-compatible storage. No real employee was activated, no real payment executed and no company/person signature applied as QA. Production setup created approved blank templates and configuration, not new real employee signing requests.

## Production release and retirement

- Portal [PR #27](https://github.com/okjusthere/homixliving/pull/27), head `0455b8c`, merged to `main` as `1f8e810`. PR CI [34739792119](https://github.com/okjusthere/homixliving/actions/runs/34739792119) and main CI [34739954893](https://github.com/okjusthere/homixliving/actions/runs/34739954893) passed. The existing Vercel `homixliving` Git integration uses `main` and assigned the canonical domain to the resulting Ready Git deployment; no direct source upload or candidate promotion was used for this release.
- eSign [PR #12](https://github.com/Kevv-AI-Labs-Inc/kevvesign/pull/12), head `95659a8`, merged to `main` as `b9fa161`. Verify, IaC and secret scanning passed on PR run [34739630403](https://github.com/Kevv-AI-Labs-Inc/kevvesign/actions/runs/34739630403) and main run [34739720635](https://github.com/Kevv-AI-Labs-Inc/kevvesign/actions/runs/34739720635).
- CI now also exercises admin onboarding against an empty schema-only PostgreSQL database. The fixture creates its synthetic company reference row. Database safety allows only explicitly named local disposable databases; remote/app databases remain rejected. Agreement recovery, signing access and admin onboarding passed against fresh independent databases.
- Production read-only browser verification used an existing administrator session: `/signing` loaded, `/admin/signing` showed 11 HR packages and two company connections, and the onboarding panel showed the four independent areas. An unsigned person with incomplete profile could record an actual receipt, while ineligible activation remained disabled. No business form was submitted. Public evidence omits personal records.
- After canonical verification, the old API revision was deactivated and has zero replicas. The old PDF finalizer is Manual with no running executions; no Azure Function apps exist in this resource group. The former web resource is the current Nginx gateway and remains running.
- All 50 obsolete production `ESIGN_*` settings were removed. Only `ESIGN_BRIDGE_BASE_URL`, `ESIGN_BRIDGE_API_KEY`, and `ESIGN_PORTAL_CALLBACK_SECRET` remain for signing. Historical SQL/files, resource definitions and independent Email Service are preserved. Retained infrastructure can still incur charges.
- Post-retirement canonical checks passed: official native login, all 11 real templates, bridge authentication and Portal HMAC boundary (unsigned 401; authenticated malformed event 400). These checks create no contracts or emails.

Safe release evidence is in [the production evidence directory](evidence/2026-09-13-production-release/). `2026-09-12-production-candidate.json` records the functional release; later documentation-only Git deployments preserve that application source.

## Operational inputs

Company-approved buyer/seller files and roles are required before publishing real legal packages. The implemented package capability has been tested using synthetic fixtures. Each agent who edits customer contracts needs a separately verified native identity/connection; HR accounts are not shared with agents. These are business configuration steps, not unimplemented signing engines.

The service P12 is a self-signed integrity seal, not an AATL/personal certificate. Actual native sealing and CMS verification passed on synthetic files. Existing unrelated Supabase advisor warnings are outside this change.

## 2026-09-13 final native signing acceptance

The user confirmed final synthetic signing. Three actual workflows completed in official Documenso 2.18.0: two recipients signing two buyer fixture PDFs; a custom Homix Living upload prepared in the native editor; and an onboarding applicant followed by a separate synthetic company signer. No real company/person contract or payment was executed.

The native `COMPLETED` state, signed timestamps, native certificate and audit downloads were verified. Signed files from Documenso and the bridge were identical; the custom signed file downloaded through Portal was also byte-identical. OpenSSL verified the CMS signature and full-file ByteRange coverage for both multi-file samples. See [synthetic completion evidence](evidence/2026-09-13-native-completion/acceptance.json).

The real native onboarding recipient/completion events passed through the durable bridge inbox/outbox and actual Portal HMAC endpoint. After applicant signing, Portal recorded the applicant timestamp and kept company signature absent. After company signing, both signatures and completion time were populated. The unpaid synthetic account remained pending throughout. Native custom signing redirected to the exact Portal task, visibly showing completed status and signed file/certificate/audit links.

The original low-level buyer fixture redirected to an unused localhost:3000 harness after signing; the actual Portal custom flow correctly returned to localhost:3119. Production return origins are explicit trusted client configuration, not browser parameters.

Old Portal native client, publisher/verifier and unused native policy code were removed. Approved contract files and the Documenso package/geometry export remain. Canonical production cutover and old runtime shutdown are complete; release state is recorded in `2026-09-12-production-candidate.json`.

## 2026-09-13 canonical eSign verification

The official engine is live at `https://esign.kevv.ai` through a small Nginx gateway preserving the existing TLS binding. Gateway and bridge use pinned images; all 11 HR templates and both company identities were verified through the canonical path. See `evidence/2026-09-13-native-completion/canonical-native-proof.json`. No real request or email was created. Source retirement was implemented in eSign `4800b44` and Portal `8902c23`; both are now included in merged production releases. Runtime retirement is verified separately in the production evidence.

## Final build checkpoint

Portal `586d621` passes `next build --webpack`: compilation, TypeScript, all 120 static pages and final tracing. Targeted ESLint passes. The build exposed an existing invalid named component export in the rental route; the shared form was moved unchanged to `rental-deal-form.tsx` and both routes reuse it. This is a build compatibility fix with no form behavior change. This pre-release build checkpoint was followed by the passing GitHub CI and canonical Git deployment recorded above.
