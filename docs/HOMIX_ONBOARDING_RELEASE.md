# Homix onboarding production release

This runbook prepares the eSign producer for Homix Portal. It does not approve
the legal form and does not permit development resources to hold real agent data.

## Required business inputs

Before a real onboarding envelope is created, obtain:

- one final broker/counsel-approved PDF per contracting legal entity
- the agreement edition and effective date
- the company countersigner name, title, and email, when countersigning is required
- the approved production application hostname and email sender domain
- the approved retention/legal-hold policy owner
- the production signing-provider account and webhook owner

Homix Realty Inc. and Homix Living Inc. must remain separate templates and Portal
pins. Agent/Team Member affiliation and Team Leader responsibilities are also
separate legal purposes. Production therefore needs up to four published template
pins; do not swap the company name or contract purpose inside a published PDF.

### Confirmed Homix inputs (2026-08-26)

- Approved PDFs for Realty Agent, Living Agent, Realty Team Leader, and Living
  Team Leader are published as four immutable production template versions.
- Current plans are Solo, Solo Pro, and Team Member. Non-producing remains a
  Solo operational status; Holding is not a template choice.
- Company countersigner for both entities: Si Zhang, Broker,
  `sunnyz@homixny.com`.
- Company countersign is mandatory and manual. It represents the company review
  step; Portal activation occurs only after the fully completed envelope and
  required payment are verified.
- Public signing hostname remains `https://esign.kevv.ai`.
- Approved synthetic recipient list:
  `okjusthere@gmail.com`, `kertweller@gmail.com`,
  `wellerkert@gmail.com`, and `eric.wei@homixny.com`.

## Production environment

Current audit status (2026-08-26): the isolated production resource group
`rg-kevvesign-prod` is deployed with its own Container Apps environment, managed
identities, VNet/NAT egress, Azure SQL database, storage, Key Vault, and HR
application credential. Homix Portal Production has all required `ESIGN_*`
template pins and countersigner settings. `ONBOARDING_V2_ENFORCED` remains `0`.

`esign.kevv.ai` is still bound to the development Web Container App. Before a
Portal envelope is created, move the DNS record and custom-domain binding to the
production Web Container App, issue its managed certificate, and verify `/health`
through the public hostname. The production stack must continue using its own
application credential, database, storage, identities, and secrets.

1. Copy `infra/parameters.prod.example.json` to an untracked deployment parameter
   file and replace every placeholder. Do not add credentials to the file.
2. Create a dedicated production resource group. Do not reuse
   `rg-kevvesign-dev` or its SQL, storage, Key Vault, smoke credential, or signing
   provider connection.
   The already verified `esign.kevv.ai` ACS Email domain may be linked by resource
   ID so production keeps the same public From address; this does not reuse the
   development ACS connection string or application credential.
3. Supply `bootstrapSessionSecret`, Documenso API token, and webhook secret only
   through secure deployment inputs. Rotate them into the production Key Vault
   immediately after bootstrap.
4. Run Bicep build, resource-group validation, and `what-if` before creation.
   Azure SQL must use exact IP firewall rules or private networking; do not use
   the broad `Allow Azure Services` rule. A temporary operator IP may be added
   for schema bootstrap and must be removed immediately afterward.
5. Complete DNS, email-domain verification, private storage, SQL backup/restore,
   monitoring/alerts, malware scanning, and retention/legal-hold acceptance.
6. Run `pnpm verify` and synthetic signing tests before any real PDF or email is
   used.

Steps 1-4 and the application/template configuration are complete. DNS/custom
domain cutover, one manual signer/countersigner/evidence cycle, and final
operational acceptance remain open.

The example parameter file intentionally cannot be deployed unchanged. This
prevents an accidental production stack from inheriting development identities,
domains, image tags, or regional assumptions.

## Workspace and Portal credential

Create a production Homix workspace, then issue one application credential with:

- business domain `HR`
- exact Portal return URLs only
- `templates:read`
- `transactions:read`
- `transactions:write`
- `envelopes:read`
- `envelopes:write`
- `envelopes:send`
- `evidence:read`

Store the plaintext credential once in Vercel Production as
`ESIGN_APPLICATION_KEY`. Never expose it to the browser and never reuse the
development smoke credential.

## Publish each contract

For each legal entity, publish the Agent/Team Member agreement and the Team Leader
agreement as separate templates:

1. Upload the approved, native-text, non-password-protected PDF.
2. Set business domain `HR`, jurisdiction `NY`, and `approvalRequired=false`.
3. Add exactly one agent signer and at most one company countersigner.
4. Place the required signature/date, acknowledgement, and read-only Portal merge
   fields using the Portal contract handoff document.
5. Publish the immutable version and record template ID, version ID, and schema
   hash.
6. Put those three pins and any countersigner identity in the matching
   `ESIGN_ONBOARDING_HOMIX_REALTY_*` or
   `ESIGN_ONBOARDING_HOMIX_LIVING_*` Vercel variables.

Team Leader agreement pins use `ESIGN_TEAM_LEADER_HOMIX_REALTY_*` or
`ESIGN_TEAM_LEADER_HOMIX_LIVING_*`. The Portal handoff document is authoritative
for each purpose's exact read-only merge keys. A Team Leader agreement must never
be sent using an Agent/Team Member pin, or vice versa.

Any PDF or field-layout change requires a new version, a new schema hash, review,
and an explicit Portal repin.

## Cutover gate

Keep Portal `ONBOARDING_V2_ENFORCED=0` while running synthetic invited-agent tests
for both legal entities, Solo and Team plans, Stripe payment, verified offline
payment, team split, sponsor reward, evidence retrieval, and administrator
approval. Also run the Team Leader chain: application approval creates a forming
team, Team Leader evidence unlocks recruiting, and the first Team Member evidence
activates the team. Production enforcement is a separate business decision after
these checks pass.

The Portal rollback-only production smoke already passes Solo, Team Member with
the Team Leader as Sponsor, Team Member with a different Sponsor, the default 10%
Team Split with no Team Cap, and administrator-verified offline payment. These
checks validate routing and finance logic but do not replace the remaining manual
recipient signature, Si Zhang countersignature, sealed PDF, and evidence retrieval
cycle for each legal template purpose.
