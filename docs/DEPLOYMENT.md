# Documenso integration deployment

Last verified: 2026-09-13 UTC. **Documenso and Portal are live after the normal GitHub PR/CI release. Legacy API and finalizer automatic execution are stopped; production configuration cleanup is complete.**

## Current production services

Azure subscription `ba7a563d-3eaf-4ca6-8b22-c28a8d3b6b36`, resource group `rg-kevvesign-prod`, location `centralus`.

| Resource                   | Current configuration                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Container Apps environment | `cae-kevvesign-signing-prod`                                                                      |
| Private VNet               | `vnet-kevvesign-signing-prod` / `10.44.0.0/16`                                                    |
| PostgreSQL 16              | `pg-kevvesign-signing-prod`, B2s, 32 GB auto-grow, 14-day backup, HA off, public network disabled |
| Native app                 | `ca-documenso-kevvesign-prod`, 1 CPU / 2 GiB, min/max 1                                           |
| Bridge app                 | `ca-esign-bridge-prod`, 0.5 CPU / 1 GiB, min/max 1                                                |
| Key Vault                  | `kv-kevvesign-prod-umwk4u`, per-secret managed-identity RBAC                                      |
| ACR                        | `acrkevvesignprodcz3a2u4wwz27c.azurecr.io`                                                        |
| Logging                    | `log-kevvesign-signing-prod`                                                                      |

Native upstream URL: `https://ca-documenso-kevvesign-prod.victoriousbush-82cadf77.centralus.azurecontainerapps.io`.

Bridge URL: `https://ca-esign-bridge-prod.victoriousbush-82cadf77.centralus.azurecontainerapps.io`.

Pinned native image: `documenso/documenso@sha256:126976b9e3be54193e1a3be8d22130af1913aaa894c550b98870a2cc4c422650` (2.18.0, upstream commit `389390c884949fe27c240488a3259da3cdba93e0`).

Current bridge image: `acrkevvesignprodcz3a2u4wwz27c.azurecr.io/esign/bridge@sha256:8350858e5f3b01b935a6abbb53082a1304b87014f707deb0145e4d80bfda8494`; active revision `ca-esign-bridge-prod--documenso-only-20260913`, healthy.

The official image is unmodified. Bootstrap used a temporary image that calls the pinned upstream official account/organization/team/token helpers; the public native app uses the official digest above.

## Databases and secrets

The native app uses database `documenso` as `documenso_runtime`; bridge uses `esign_bridge` as `esign_bridge_runtime`. Cross-database connection is explicitly denied. Bootstrap administrator credentials must not be used by either runtime. Applications do not cross-write native tables.

IaC entry points:

1. `infra/signing-platform.bicep`: private network, PostgreSQL, environment and logging.
2. `infra/database-bootstrap.bicep`: one-time runtime users/databases and isolation verification.
3. `infra/documenso-runtime.bicep`: official native application.
4. `infra/bridge-runtime.bicep`: sole-engine bridge.
5. `infra/native-bootstrap.bicep`: one-time native organization setup job.

Supply secrets in private ignored parameter files or directly from a protected secret store. Never commit bootstrap credentials, native tokens, P12/private keys or `.local` checkpoints. Both app identities have only the required per-secret Key Vault grants. Both temporary bootstrap jobs succeeded and were removed after setup; their runtime credentials are no longer exposed through a retained job definition. Application databases and user storage were retained.

Native Key Vault prefix `documenso-prod`:
`database-url`, `nextauth-secret`, `encryption-key`, `encryption-secondary-key`, `signing-passphrase`, `signing-cert-base64`, `smtp-app-secret`.

Bridge prefix `esign-bridge-prod`:
`database-url`, `credential-key`, `portal-clients`, `webhook-secret`, `portal-api-key`, `portal-callback-secret`.

`portal-clients` contains hashed bearer keys and exact callback origins. Current client is `homix-portal`, origin `https://agents.homixny.com`. Portal sets `ESIGN_BRIDGE_BASE_URL`, `ESIGN_BRIDGE_API_KEY`, `ESIGN_PORTAL_CALLBACK_SECRET` in production Vercel environment; all are server-only.

## Native mail, signing identity and seal

Both legal entities use **Si Zhang <hr@homixny.com>** as the company signer (user-confirmed). The real native user ID is 3. Company teams:

- Homix Realty HR: team 3, URL `homix-realty-hr`.
- Homix Living HR: team 4, URL `homix-living-hr`.

Ordinary agents are not members of HR teams. HR login has no pre-set password; the user can use the native password reset flow at the canonical domain. Never send a shared password or sign on Si Zhang's behalf. Two team-scoped authenticated webhooks have been created and verified through the pinned official native helpers.

Documenso SMTP uses ACS resource `acs-kevvesign-prod-umwk4u3aag3g6`, username `documenso-prod`, SMTP resource `documenso-prod-smtp`. The dedicated Entra application has only the documented SMTP sender role on that ACS resource. SMTP TLS/auth succeeded without sending an email. Sender: `esign@esign.kevv.ai`. Existing verified domain linkage is retained. This does not change or merge the independent Email Service.

SMTP application credential expires **2027-09-13T01:22:32.419003Z**; rotate it ahead of expiry. Replace the Key Vault value and refresh the application revision; verify TLS/auth again without exposing the credential.

The generated 4096-bit RSA P12 is a **self-signed service integrity seal**, valid for 730 days from issuance. It is not an AATL certificate, a qualified signature, or Si Zhang's personal signature. Back up its private material under restricted access. Actual synthetic native signing, sealed PDF CMS/ByteRange verification and native certificate/audit downloads passed. Health checks alone are not used as signing evidence.

## Portal Git production release and additive migration

Supabase project `wnshsoxtxkfbphglyvmj` (homix) has migration `signing_onboarding_workspaces` applied. Five new tables have RLS enabled and no anon/authenticated grants; the server DB role supplies access after Portal authorization. No real agent state or existing contracts were changed by this migration.

The existing Vercel project `homixliving` is connected to `okjusthere/homixliving`; automatic Git deployments are enabled and the production branch is `main`. Portal PR #27 passed CI, then merged as `1f8e8108de95176f7454dbd3bec9667002163851`. Main CI passed. Git deployment `dpl_JCKosGCrTxwEgf3Dfsx697MTC37n` / `https://homixliving-6inn1hssl-erics-projects-9449aac9.vercel.app` is Ready and verified on `https://agents.homixny.com`. No direct source upload or candidate promotion was used for this release. eSign PR #12 merged as `b9fa1616743a5345e50a0c82022c908edd592e63` after all checks, and its main CI also passed.

Production checks verify protected routes, unsigned callback 401, and correctly authenticated malformed callback 400 without business mutations. An existing administrator session opened the signing workspace, 11 HR packages, both company connections and the onboarding four-area panel. Incomplete/unsigned onboarding could record receipts, but activation stayed disabled until eligible. See the safe aggregate evidence; no personal record or secret values are included.

## Cutover checklist

- [x] User-authorized synthetic final signing: two recipients, native completed state, exact PDF bytes, cryptographic integrity seal, certificate/audit and durable callback into Portal verified.
- [x] Sequential onboarding and custom-document native completion acceptance recorded separately from unit/DB coverage.
- [x] Rebuild final bridge/Portal source, check candidate health and protected routes, retain the old deployment IDs for rollback.
- [x] Serve official Documenso at `esign.kevv.ai` through the existing TLS binding and minimal gateway. Native public URL and bridge base URL use the canonical hostname; native login and template reads verified. No real password-reset email sent.
- [x] Merge the tested Portal source through CI and let Git integration deploy production; verify `/pending`, `/signing`, `/admin/agents?view=onboarding`, `/admin/signing` and authenticated callbacks on canonical domains.
- [x] Verify canonical production routes, existing admin UI, native templates and authenticated callbacks without creating real invitations, contracts or payments. Completed synthetic signing is verified separately against the same pinned official engine.
- [x] Stop the replaced native web/API/finalizer/workflows, remove their source, dependencies and obsolete Portal native environment pins. Preserve business records, historical files, SQL/storage and the independent Email Service.
- [x] Record resource states, remaining retained costs and restore procedure.

For a rollback after this release, pause creation of new signing tasks before any rollback decision; do not send new work into two engines. Restore a tested prior bridge/Portal revision and diagnose Documenso rather than inventing native fallback. Old pending native drafts do not need migration, per the user's direction.

## 2026-09-13 canonical native cutover

The synthetic final-sign gate is complete: real multi-recipient, sequential onboarding and custom signing, native seal/CMS verification, certificate/audit, byte-identical downloads and actual Portal HR completion callbacks passed.

The canonical domain is live on Documenso. Rather than move DNS between Azure environments, the existing `ca-web-kevvesign-prod` resource now runs only `apps/gateway`, preserving its already-valid `esign.kevv.ai` domain/certificate. Upstream TLS verification is enabled. It serves the new official native app; the old web bundle is absent. Gateway image: `sha256:bfec08cf750ee3c71375952537afcc10db7c9ac0dfb8b583b6624865f1bb7224`, revision `ca-web-kevvesign-prod--documenso-gw-20260913`. Native public URL is `https://esign.kevv.ai`, revision `ca-documenso-kevvesign-prod--canonical-20260913`.

Bridge image after dependency retirement: `sha256:8350858e5f3b01b935a6abbb53082a1304b87014f707deb0145e4d80bfda8494`, revision `ca-esign-bridge-prod--documenso-only-20260913`, base URL `https://esign.kevv.ai`. Canonical smoke verifies health, native login, both company identities, all 11 approved packages and real native template reads.

Use `apps/gateway/prepare-azure-update.py` with an `az containerapp show` snapshot, the pinned image, verified native hostname and unique revision suffix. It writes a private update file; review it before `az containerapp update --yaml`. Keep the private pre-cutover snapshot. The live gateway needs only registry pull access and no signing/API/database secret environment. Upstream host and canonical public host are explicit deployment values.

The code retirement removed old applications/packages and archived old IaC without deleting historical SQL or file storage. The API/finalizer runtime stop and final Portal Git release are verified in the release record. No native fallback is included in any new artifact.

## Verified legacy runtime retirement

`ca-api-kevvesign-prod--recovery-1d3e1bd` is inactive with zero replicas. `job-pdf-kevvesign-prod` is provisioned successfully with trigger type Manual and no running executions. There are no Azure Function apps in this resource group. The former web app resource remains the current Nginx gateway and must stay running.

Before the change, restricted snapshots were saved for the API, finalizer and Portal environment. The finalizer update preserved identity, image, template and secret references. The application/job resources, historical SQL, Service Bus and blob data were retained. The 50 obsolete production Portal signing settings were removed; only the three bridge settings listed above remain. Existing Email Service and payment configuration were not changed by this cleanup.

API replica execution and event-driven finalizer execution are stopped. Historical SQL, storage, Service Bus, old environment/network infrastructure, registry/logging and gateway resources can still incur charges. No zero-cost claim, billing amount or automatic resource deletion is implied.

## Recovery procedure

1. Pause creation of new signing tasks while diagnosing a serious incident. Preserve current upstream and bridge records and take restricted snapshots before changes.
2. Restore only a tested compatible Documenso/bridge revision and a known Documenso-enabled Portal Git revision through the standard PR/CI flow. Keep the gateway TLS binding and canonical origins. Do not restore the pre-integration Portal or reactivate the old engine as a fallback.
3. Restore PostgreSQL from the configured 14-day backup only when a data recovery is required; coordinate the native and mapping stores, compare native document IDs and reconcile callbacks before resuming creation. Never overwrite production with synthetic fixtures or directly manufacture native signing state.
4. Re-run health, real-template reads, HMAC boundary and read-only workspace checks. Resume work only after the matching records and official signing engine are verified.

For historical investigation, recover source from Git history/archived IaC and use an isolated environment. Private pre-retirement snapshots and historical storage are retained; do not put their credentials into Git. Any future deletion of history or restoration of old public signing services is a separate operational decision.
