# Company standard packages — Phase 1

2026-09-13. Implemented against Documenso 2.18.0. Local synthetic acceptance passed; this change has not deployed or published real company contracts.

This document supersedes the older requirement to connect each agent's native account for buyer/seller packages in `DOCUMENSO_PORTAL_PLAN.md`. Personal PDF editing/account lifecycle remains Phase 2.

## Ownership and scope

- New `buyer`/`seller` requests use the same company connection as the published source package. Listing and direct-buyer packages are company-defined variants of these scenarios. Templates and envelopes remain owned by the company native user/team.
- The trusted Portal actor includes `allowedCompanyKeys` from the current active agent record. Bridge independently checks this list for standard-package creation/catalog and verifies source/target company and connection equality. `ownerAgentId` remains task authorization, not native ownership. Existing saved connection IDs are not rewritten.
- A task owner can obtain only their own current verified signer role's link; administrator access does not permit customer impersonation. Standard tasks never grant native editor access. Company administrators may open company **template** editors using their existing administrative login.
- New `custom` tasks, multipart personal document creation and new customer connection registration return `PERSONAL_SIGNING_UNAVAILABLE`. Existing legacy connections can be rotated/revoked and historical tasks read under their saved ownership. No account provisioning or SSO is introduced.

## Company publishing

1. Portal `/admin/signing` stages administrator PDFs in the existing private object store. A validated company-specific finalize route forwards the files to `POST /v1/connections/:id/templates`.
2. Bridge requires a company connection, administrator principal, PDF magic bytes, at most 10 files / 25 MiB each / 100 MiB total. Metadata includes a stable `uploadId` and title. Durable `template_uploads` stores intent/hash and native external ID before creation; uncertain outcomes reconcile that external ID before permitting another create.
3. Administrator configures native template recipients, fields and routing, then maps semantic roles/prefills and publishes through the existing package API. Upload/configuration does not send invitations.
4. Customer packages require **one native template/envelope containing all relevant PDFs**. This gives each recipient one signing flow. Separate published variants encode one/two clients and distinct business situations; do not silently remove fixed recipients at send time.
5. Sequential non-CC recipient ranks must be distinct and non-null. Documenso 2.18.0 can disagree between invitation and current-turn logic for equal ranks. Use strict sequential order or fully parallel recipients. Invalid templates fail publication with `SEQUENTIAL_ORDER_MUST_BE_DISTINCT`.

Do not publish draft legal material. Company approval covers PDFs, company/scenario, signer roles/order, per-page geometry, required/readonly values and choice options. Copy templates and publish a new version for changes. Retired packages cannot send an unsent prepared task; issued tasks retain their saved state.

## Request operations

All request routes retain caller/client/owner checks; part/item IDs must belong to that request.

| Route                                                            | Contract                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/requests/:id/review`                                    | Unsent standard request only. Verify native draft snapshot; return review hash and allowlisted geometry/display values, never recipient tokens or storage IDs. Original PDFs remain authenticated per-file downloads. |
| Existing part `command` with `action: send`                      | Standard drafts require `reviewHash` matching current review. Revalidate source template, original PDF hashes, roles, fields, prefill and routing. Retain operation/idempotency protection.                           |
| `GET /v1/requests/:id/reissue`                                   | Refresh and validate closed/completed state, return safe previous input for new preparation. Unknown/open work is blocked.                                                                                            |
| `POST /v1/requests` with `predecessorRequestId`, `reissueReason` | Validate predecessor ownership/scenario/company, prepare a new unsigned attempt and record `request.reprepared`. Never copy signatures or overwrite old evidence.                                                     |
| `GET /v1/requests/:id/bundle`                                    | Completion only. ZIP contains unchanged sealed PDFs, native completion certificate/audit and SHA-256 manifest. Meaningful safe UTF-8 filenames, bounded 200 MiB total.                                                |

Client completion does not redirect to Portal login. HR retains its prior redirect/projection/payment boundaries. Expired recipients can be reminded/renewed subject to throttling; uncertain sends must reconcile or explicitly close before replacement. Read-only file/review operations briefly retry request leases (up to five seconds), while mutations retain exclusive fail-fast behavior.

## Persistence and rollout

`BridgeStore.migrate()` adds `signing.template_uploads`, webhook `next_attempt_at`, part `next_reconcile_at`/`reconcile_attempts`, and scheduling/list indexes. Changes are additive. Portal has no new SQL migration. Lists filter/count in PostgreSQL with stable `(updated_at DESC, id DESC)` pagination, without the previous 500-row truncation. Failed webhook/part reconciliation uses scheduled exponential retry (30 seconds to one hour) so a failing first batch cannot starve later work.

Deploy Bridge first, check migrations and native/company bindings, then Portal. Portal's pinned PDF.js assets are copied by `predev`/`prebuild` to `/signing-pdf/` and loaded as self-hosted native ESM; this avoids rebundling PDF.js in Next's browser runtime. Verify private storage, worker/font/wasm asset delivery, package scope and the no-personal-editor policy before publishing approved templates.

A rollback should first stop new preparation/sending while preserving in-flight queries and completion files. Do not move historical envelopes, retarget their connections, switch to the old dev instance or remove the additive tables as an application rollback shortcut.

## Validation

`pnpm test`: 19 contract and send-boundary tests. `pnpm lint`, `pnpm typecheck`, `pnpm build` passed. The review gate checks the freshly read native draft even when its cached projection is null or stale; already-issued/completed send retries remain idempotent.

The local integration suites use fixed isolated endpoints and a private local fixture; they are not stand-alone CI setup scripts. They intentionally create and sign only synthetic documents via local Documenso/Mailpit. Run with the isolated stack established:

```sh
node --import tsx apps/bridge/src/__tests__/company-packages.integration.ts
node --import tsx apps/bridge/src/__tests__/company-state.integration.ts
```

They cover company PDF upload/publication, agents without native accounts, one/two client completion, native signed PDF byte equality inside ZIP, no-account client downloads, authorization, review/send gating, reissue/decline/cancellation/expiry/unknown/retired state, 615 rows over 21 pages, category/count parity and 101 failing webhooks preceding a healthy event.

Portal additionally passed actual HTTP/private-S3 integration, HR preparation/callback retry regression and an actual 390×844 final-client signing flow across two PDFs. Formal company PDFs and production mail/payment were not tested in this change. The companion Portal record is `docs/qa/2026-09-13-company-packages/README.md`.
