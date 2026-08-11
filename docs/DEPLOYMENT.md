# Azure deployment handoff

Cloud deployment is intentionally deferred until Azure CLI access, subscription/resource-group scope, administrator identity choice, domains, and production owners are supplied. Homix Portal users do not need an eSign identity-provider registration because they enter through delegated Portal sessions.

## Required inputs

- Subscription and resource group for development/staging/production.
- Primary region and recovery decision.
- Entra SQL administrator group object ID. Choose Google Workspace (preferred) or Entra for the small standalone eSign administrator group.
- Container registry/image destinations.
- Staff console/API hostnames and Communication Services sending domain.
- Exact HTTPS Portal return URLs for each source project and environment.
- Named product, technical, security/privacy, operations, HR-policy, and NY/NJ/CA broker/counsel owners.
- Approved retention matrix and pilot documents.

## Deployment sequence

1. Build and scan the three container images.
2. Run `az deployment group what-if` against `infra/main.bicep` with environment-specific parameters.
3. Review resource tiers, public-network flags, role assignments, budgets, and diagnostic settings. Private endpoints/VNet restrictions are a production release gate.
4. Deploy infrastructure and run SQL migrations with an Entra administrator.
5. Configure custom domains, SPF/DKIM, the selected administrator redirect URIs, registered Portal return URLs, and Key Vault secret values.
6. Deploy applications with no customer data and run the synthetic smoke journey.
7. Verify evidence hashes, Key Vault signature, Blob immutability, SQL Ledger digest, alerts, email status, and rollback.

## Integration credential cutover

After staging is healthy, issue separate application credentials for each source project and environment. Store each value in that project's Azure Key Vault or equivalent backend secret store, register exact environment-specific return URLs, grant only required scopes, exercise rotation/revocation, and confirm the old value and associated delegated sessions immediately fail. Never reuse one credential across development, staging, and production or expose it to browser code.

REST polling is the supported integration mode for the first staging cutover. Do not enable production webhook subscriptions until delivery persistence, retry/dead-letter behavior, replay controls, and a reference signature-verifying consumer pass Azure integration tests.

Never place a production secret in a parameters JSON file, command history, source control, or CI log.
