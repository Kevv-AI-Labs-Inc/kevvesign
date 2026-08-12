# Azure deployment handoff

The development environment is deployed in the `Azure subscription free` subscription under resource group `rg-kevvesign-dev`.

- Public application: `https://ca-web-kevvesign-dev.whitepond-3b391332.eastus2.azurecontainerapps.io`
- Web, API, jobs, storage, messaging, email, Key Vault, and registry: East US 2
- Azure SQL: Central US because this subscription currently restricts SQL creation in East US and East US 2
- Staff entry: delegated connector session; Homix is the first connector and ordinary users do not create an eSign login
- Recipient entry: one-time signing link; no recipient account

This is a development environment, not a legal or production release. It still needs a custom domain, verified email domain, final retention policy, production network isolation, monitoring/alerts, backup/recovery review, and NY/NJ/CA counsel/broker acceptance before real transactions or employee records are used.

## Deployed resources

- Container Apps: public Nginx/React Web and internal-only Fastify API with ClamAV sidecar
- Container Apps Job: event-driven PDF finalizer using the `pdf-finalize` Service Bus queue
- Azure SQL Database: Entra-only authentication, ledger audit table, separate API and finalizer managed identities
- Storage: OAuth-only access, no public blobs, versioning/change feed, and delete retention
- Key Vault: RBAC, purge protection, RSA manifest signing key, application secrets
- Azure Container Registry: Basic, local admin disabled, managed-identity image pulls
- Azure Communication Services Email: Azure-managed development sender
- Documenso dev: pinned `documenso/documenso:v2.11.0` container with a dedicated managed identity
- Documenso PostgreSQL: `pg-kevvesign-documenso-dev` in Central US, version 16, seven-day dev backups
- Log Analytics and Application Insights

Current image references are recorded in `infra/parameters.dev.json`. The Bicep template remains the source of truth for resource configuration; deployment-only credentials remain in Key Vault and are never stored in a parameters file.

## Repeatable deployment

Run validation before changing Azure:

```bash
pnpm verify
az bicep build --file infra/main.bicep --stdout >/dev/null
az deployment group validate \
  --resource-group rg-kevvesign-dev \
  --template-file infra/main.bicep \
  --parameters infra/parameters.dev.json \
  --parameters bootstrapSessionSecret="$KEVVESIGN_SESSION_SECRET"
```

For an existing environment, load the current session secret without printing it, run `what-if`, then deploy:

```bash
KEVVESIGN_SESSION_SECRET=$(az keyvault secret show \
  --vault-name kv-kevvesign-dev-lxgas2 \
  --name session-secret \
  --query value \
  --output tsv)

az deployment group what-if \
  --resource-group rg-kevvesign-dev \
  --template-file infra/main.bicep \
  --parameters infra/parameters.dev.json \
  --parameters bootstrapSessionSecret="$KEVVESIGN_SESSION_SECRET"

az deployment group create \
  --name kevvesign-dev-release \
  --resource-group rg-kevvesign-dev \
  --template-file infra/main.bicep \
  --parameters infra/parameters.dev.json \
  --parameters bootstrapSessionSecret="$KEVVESIGN_SESSION_SECRET"

unset KEVVESIGN_SESSION_SECRET
```

For a first deployment, generate a cryptographically random value instead and immediately store it in the environment's Key Vault. Never place it in source control, parameters JSON, shell history, CI output, or browser code.

## SQL bootstrap

`pnpm --filter @esign/infrastructure bootstrap:azure-sql` installs the schema, reapplies the idempotent least-privilege grants, reconciles managed-identity users by client ID, seeds the workspace administrator, and optionally seeds the first integration client. Run it with a short-lived Azure SQL access token and a temporary firewall rule limited to the operator's exact IP; remove that rule immediately afterward.

The API and finalizer use `DefaultAzureCredential` through the `azure-active-directory-default` driver mode. Their contained database users belong only to `esign_app_role`. The role can read/write application state and append audit events, but cannot delete ledger audit rows or control the schema.

## Connector and identity cutover

The Azure smoke credential is stored only in `kv-kevvesign-dev-lxgas2` as `portal-smoke-client-credential`. It is for deployment verification, not Homix Portal production use.

For Homix Portal or another connected application:

1. Register the exact Homix Portal HTTPS return URL.
2. Issue a dedicated environment-specific application credential with only the required scopes.
3. Store it in the Homix Portal backend secret store; never send it to browser JavaScript.
4. Have the connector backend call `POST /v1/integration-sessions`, then redirect the staff browser to the returned fragment-based `launchUrl`.
5. Verify rotation and revocation, then revoke the deployment smoke client.

Configure standalone access with either the paired legacy Entra parameters or `oidcProvidersJson`. Each JSON entry supplies a unique `id`, exact `issuer`, `audience`, and HTTPS `jwksUrl`; authentication is mapped to an active workspace member by email. For Google Workspace, set `emailVerifiedClaim` to `email_verified` so unverified email claims are rejected.

## Documenso cutover

The Documenso dev service is deployed independently from the Kevv eSign API. Its repeatable definition is `infra/documenso.bicep`; all credentials, encryption keys, and the development signing certificate are Key Vault references resolved through `id-documenso-kevvesign-dev`. Its public URL is `https://documenso.kevv.ai`. Account creation is limited to `homixny.com`, Google/Microsoft/OIDC sign-in is disabled for this initial bootstrap, and anonymous telemetry is disabled.

Keep `signingEngineProvider=native` until a Documenso administrator has created an API token and registered the Kevv eSign webhook. For the cutover, pass `documensoBaseUrl`, `documensoApiToken`, and a separately generated `documensoWebhookSecret`; Bicep places the two secrets in Key Vault and exposes them to the API through managed-identity secret references. Register the API webhook endpoint and shared header in Documenso, then test create, distribute, resend, reject, cancel, multi-recipient routing, completion download, replay, and provider-outage recovery with synthetic PDFs before real records are allowed.

The bound hostnames are `esign.kevv.ai` for Kevv eSign and `documenso.kevv.ai` for Documenso. Their Cloudflare CNAME records remain DNS-only so Azure Container Apps can issue and renew managed certificates directly. TXT records named `asuid.esign` and `asuid.documenso` contain the Container Apps environment custom-domain verification ID. Keep these records in place while the custom domains are active.

## Release checks completed

- Public `/health`: 200
- Static application root: 200
- Unauthenticated `/v1/me`: 401
- Integration launch/exchange/session/dashboard: 201/200/200/200
- One-time launch ticket replay: 410
- Integration logout and post-logout access: 200/401
- API and ClamAV containers: ready with zero restarts after final rollout
- Documenso public and internal `/api/health`: 200 with database and certificate checks both `ok`
- SQL temporary operator firewall rule: removed

The synthetic integration session was logged out after verification. No licensed real-estate form, customer document, recipient email, or employee record was used. Documenso is deployed as a standalone dev service, while Kevv eSign remains in native signing-engine mode until API/webhook configuration and an end-to-end synthetic signing test are complete.
