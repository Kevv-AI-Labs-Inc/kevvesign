# Documenso / bridge / Portal architecture

The 2026-09-12 product plan and ADR 0002 replace the previous provider-neutral native platform. This document describes the new implementation. The old native engine source and dependencies have been removed. The new bridge cannot select or fall back to them.

## Boundaries

| Component                 | Responsibilities                                                                                                                                                                           | Storage                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Portal                    | Canonical agent identity and aliases; `/pending`, `/signing`, admin onboarding; actual receipts, manual contracts, access and activation                                                   | Existing Portal PostgreSQL; private R2 for manually uploaded HR PDFs         |
| `apps/bridge`             | Trusted caller authentication; per-agent/company native connections; versioned package references; idempotent preparation; task projections; authenticated webhook inbox and Portal outbox | Separate `esign_bridge` PostgreSQL database, AES-GCM encrypted native tokens |
| Official Documenso 2.18.0 | Native editor/signing UI, documents/templates, recipients/routing, invitations/reminders, signed PDF, certificate/audit                                                                    | Separate `documenso` database, database upload transport                     |

Portal and bridge do not mark a recipient signed. Browser return parameters do not establish signature facts. Manual contract verification satisfies an explicit business requirement without changing Documenso's electronic state.

## Identity and visibility

The bridge key identifies a trusted Portal backend. `X-Portal-Actor` is a base64url assertion produced server-side from the canonical agent ID, current admin permission and verified login aliases. It is not a browser authentication mechanism. Portal APIs independently authorize each operation and re-read limited access where necessary.

Customer connections bind the canonical agent to an actual native user/team and a real owned proof document. Customer documents are created with delegated ownership and `ADMIN` visibility; they must remain in isolated teams without ordinary cross-agent membership or inherited access. Each upstream document is checked against the connection owner and team. Registration requires independent native isolation evidence; it does not claim that matching an email alone proves isolation.

HR has one separate company connection per legal entity. Both currently use the user-confirmed **Si Zhang / hr@homixny.com**. This signing identity is independent of the Portal administrator's display name. An applicant can open only their assigned recipient link; the company signer can open their own link when their routing turn is current. Portal admin status does not impersonate Si Zhang.

An API token stays encrypted in the bridge database. Key Vault supplies the encryption key and runtime secrets through per-secret managed-identity grants. Customer tokens, HR tokens and shared webhook secrets never appear in ordinary Portal API responses or client bundles. The dedicated administrator connection setup UI may accept a token and show webhook configuration to an authorized administrator for setup.

## Packages and lifecycle

Published packages pin native template IDs, original PDF SHA-256 hashes, field/recipient metadata and roles. A package has a stable key, immutable version, company, scenario and selectors. Repeated business prefill keys must have compatible native types/options. Shared fields are entered once; role, file, page and coordinates disambiguate repeated labels.

Preparation snapshots the published definition and records a durable intent before creating upstream drafts. External IDs let retries locate already-created native documents. Sending re-reads native status; uncertain/partial operations stay recoverable. HR drafts are controlled: before bridge distribution, the recipients, routing, prefilled fields, geometry and original PDF hashes must still match the prepared package. HR admins remain privileged in native Documenso; the bridge guard is not a replacement for native administrator governance.

Customer drafts can be edited in the native editor. Exact document URLs are returned only after ownership checks; Portal remains at the same task and preserves its search/filter context. A signing continuation resolves the same active native document and exact recipient, rather than making a new document on every click.

Documenso events authenticate using the version-verified shared header. The bridge stores and deduplicates the event, then fetches authoritative native state. A periodic reconciliation loop repairs missed notifications. Portal callbacks carry HMAC authentication, are durable/retried and deduplicated again in Portal. Completed status, final files and account activation remain separate facts.

Original/completed PDF, native certificate and audit downloads are authorized per task and proxied as upstream bytes. There is no new custom PDF finalizer. Actual synthetic completion and cryptographic CMS integrity have been verified; native/bridge/Portal completed bytes match. See the QA report.

## Onboarding business state

Portal independently tracks contract requirements, payment facts, team terms, account access and unfinished tasks. Online eligible payment automatically activates; a matched offline payment requires the dedicated approval command. Actual receipts may be recorded before signature and stay unmatched when fee applicability is not established.

A paper/historical PDF is staged, read and hashed server-side, then copied to a new server-only key. Verification is a separate auditable action; replacing a verified file creates a new version. Existing-staff recognition records identity/terms and financial applicability. Limited access records allow only selected profile/training/resources capabilities, with deadline/revocation enforced from fresh database state. These actions do not fake payment or electronic signatures.

The queue includes active accounts with unfinished company countersignature, contract correction, receipt reconciliation or limited-access tasks. Deferral/restoration changes handling disposition, not contract/receipt facts.

## Deployment separation

New Documenso and bridge share a private PostgreSQL server but use separate databases and restricted runtime logins. Neither runtime can connect to the other's database. Portal's existing database remains separate. SMTP uses a dedicated application scoped to the existing ACS mail resource; the independent Email Service is unchanged. The service integrity seal is self-signed, not an AATL or individual certificate.

## Existing domain gateway

`esign.kevv.ai` retains its existing Cloudflare DNS and Azure managed TLS binding. The former web app resource now runs the fixed official Nginx gateway image from `apps/gateway`; no old web bundle or signing endpoint runs in it. It proxies to the new native Documenso app with verified upstream TLS, canonical forwarded host/protocol, upload support and original response bytes. Both Documenso's public URL and bridge base URL use `https://esign.kevv.ai`. This avoids a DNS/TLS interruption across the old and new Azure environments.

The gateway has no business database, signing credential or Portal key. Its existing registry configuration is preserved. Access URL logs are disabled because native recipient tokens occur in paths. `prepare-azure-update.py` creates a reviewable Azure update from a private snapshot while preserving the existing domain/certificate. It does not call Azure or modify other resources.
