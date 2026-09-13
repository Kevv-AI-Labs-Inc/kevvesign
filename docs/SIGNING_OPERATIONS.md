# Signing operations

## Daily work

Use Portal as the business workbench. New agents continue from `/pending`; customer packages and individual files live at `/signing`. Administrators use `/admin/agents?view=onboarding` for missing information, signatures, real receipts and access, and `/admin/signing` for company packages and native account connections.

Signing, payment and account activation are separate. A received check can be recorded immediately, even before signature. It remains unmatched until the relevant fee is known; matching a receipt does not replace the dedicated approval command. A verified paper/historical contract is labeled accordingly and never appears as a fabricated Documenso signature. Company countersignature remains a task after an agent is active.

## Connect an agent's native editor account

This is a one-time administrator setup per canonical Portal agent. Production HR connections are already configured; ordinary customer-editor accounts are not automatically provisioned in this release.

1. Resolve the canonical Portal agent and verified email aliases. Use the account with the intended owner after any duplicate-email merge.
2. Create/invite the corresponding real Documenso user through official native administration. Let that person establish their own native login. An invitation sends email and must be an intended operational invitation, not an unannounced QA message.
3. Create an isolated customer team/space under the appropriate organization. Restrict membership and inherited organization access so no ordinary agent can see another agent's customer documents. Do not add the person to either HR team. Treat native organization admins as privileged.
4. With that user's native identity, create a disposable clearly labeled setup draft with `ADMIN` visibility. Create a team-scoped API token, and record its real proof document ID. An administrator token that can merely read the draft is not a substitute for the owner's token.
5. In `/admin/signing` → account connections, select the canonical agent, submit that token and proof ID, and record the actual isolation check. The server verifies native document owner, team and email against verified Portal aliases. It encrypts the token; do not store it in screenshots or support tickets.
6. Show that connection's webhook configuration in the admin UI. Configure the displayed URL and `X-Documenso-Secret` in the matching native team's webhook settings. Subscribe to relevant document events. This is a shared-secret header, not an invented provider HMAC.
7. Verify A cannot open B's customer documents or HR drafts in both systems. Verify the mapped agent can create a custom draft from Portal, edit that exact native draft and return to the same Portal task.

Client signing links are recipient-specific and do not require a Portal account. If the native editor asks for login, use the mapped account. An unopened email or closed browser does not mean a new envelope is needed: select Continue in the existing task. Do not share another recipient's URL.

## Publish a company package

Obtain company-approved actual files and roles first. No buyer/seller legal bundle is inferred by the application.

Edit templates in the company Documenso space. In `/admin/signing`, choose a company connection, inspect templates, map recipient roles and reusable business fields, select scenario/company/selectors, then publish a new version. A published reference pins PDF hashes and field metadata. Edit a copy and publish a new version for changes; retire the prior version for new preparations without rewriting existing signed requests.

The import CLI supports a protected operator workstation with a private native-credentials file and an authenticated remote bridge API, so production databases stay private:

- `ESIGN_IMPORT_BRIDGE_URL`, `ESIGN_BRIDGE_API_KEY`, `DOCUMENSO_BASE_URL`
- `ESIGN_OPERATOR_AGENT_ID`, `ESIGN_OPERATOR_EMAIL`, `ESIGN_OPERATOR_CLIENT_ID`
- `ESIGN_IMPORT_NATIVE_CREDENTIALS` (private JSON file)
- `HOMIX_PACKAGE_MANIFEST` (approved manifest path), optional `HOMIX_IMPORT_COMPANY`
- `pnpm --filter @esign/bridge import:packages` validates only; add `--publish` to import and publish without sending invitations.

Read `apps/bridge/src/cli/import-packages.ts` for the validated manifest shape. Preserve its ignored checkpoint file when retrying; it checks existing publications and source hashes before reuse. Never publish synthetic QA files as company legal packages. The 11 approved onboarding/TL packages are already imported for both companies; import is not proof that a person has signed.

## Recovery and operational checks

| Symptom                                                        | Check and action                                                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Continue signing fails                                         | Refresh the existing Portal task; inspect the native document, recipient identity and routing turn. Retry without changing business idempotency keys. Ended/expired tasks require an explicit restart decision. |
| Company signer cannot open                                     | Verify current routing turn and that logged-in verified email is the configured native company signer. Being a Portal admin alone grants no signing identity.                                                   |
| HR draft changed                                               | Restore or explicitly restart from an approved package; do not bypass field/original checks or edit the signed facts.                                                                                           |
| Native document created but Portal reports pending preparation | Reconcile the recorded external ID; retries recover that document rather than create another.                                                                                                                   |
| Signature appears delayed                                      | Check authenticated native webhook inbox and bridge reconciliation, then Portal outbox/inbox. A browser success screen does not directly activate accounts.                                                     |
| Completed document but download unavailable                    | Retry file access/reconciliation and inspect native completion jobs. Preserve upstream bytes; do not regenerate a replacement PDF in Portal.                                                                    |
| API credential expired                                         | Rotate through the connection admin action with a new token and proof from the same native user/team. Do not repoint a historical connection to another person.                                                 |
| Compromised connection                                         | Revoke it in Portal and revoke its native token; inspect the audit log. Revocation intentionally makes its operations unavailable until corrected.                                                              |
| Duplicate receipt                                              | Find the existing receipt by normalized reference/idempotency key. Correct or void with a reason; do not record a second payment to get around a conflict.                                                      |
| Paper contract replaced                                        | Upload as a new version and verify again. Accepted stored bytes are not edited in place.                                                                                                                        |
| Temporary access expired                                       | Review and issue a new scoped decision if appropriate; never make the agent active through ordinary profile editing.                                                                                            |

Bridge health checks: `/health/live` and `/health/ready`. Follow app logs without printing tokens, raw signed URLs, personal PDFs or full environment values. Alert on stale inbox/outbox attempts, repeated native/API errors, expiring SMTP/API credentials, and PostgreSQL capacity. Single replicas and HA-off PostgreSQL are the current deployment size; load/HA planning is separate from functional acceptance.
