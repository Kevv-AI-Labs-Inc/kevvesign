# Kevv eSign · Documenso integration for Portal

Documenso is the sole signing engine for the new integration. `apps/bridge` provides the business API used by Homix Portal for agent onboarding, buyer/seller packages and custom documents. Documenso supplies its own editor, signer interface, delivery, completion and audit records. Portal owns onboarding business decisions, paper/historical contract verification, payments and access.

**Release status (2026-09-12):** the new production Documenso and bridge are deployed, both company identities and 11 approved HR packages are configured, and the Portal candidate is built. Final synthetic signing/sealed-file acceptance and domain cutover are outstanding. The old production endpoints and native source remain until that acceptance passes; they are not a fallback in the new bridge.

## Start here

- [Product and acceptance plan](docs/DOCUMENSO_PORTAL_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Production setup and cutover](docs/DEPLOYMENT.md)
- [Signing operations](docs/SIGNING_OPERATIONS.md)
- [Release evidence and remaining gates](docs/qa/2026-09-12-documenso-integration.md)

## Development

Use Node 22 and pnpm 10.4.1. Configure a **separate test** Documenso 2.18.0 instance and PostgreSQL database. Copy `.env.example` into an ignored local environment file, supply generated local secrets and start the bridge with the environment loaded:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm --filter @esign/bridge typecheck
pnpm exec vitest run apps/bridge/src/__tests__/contract.test.ts
pnpm --filter @esign/bridge build
```

The default development command starts the bridge. `dev:legacy` and the old native source are retained only for the outstanding retirement/rollback gate; they are not a bridge fallback.

The bridge listens on port 4100. `/health/live` identifies the engine/version; `/health/ready` checks its database and reconciliation loop. Backend callers authenticate with a bearer API key and a canonical Portal actor assertion; credentials never belong in browser code.

A customer editor needs a real Documenso user and its own isolated connection. Signer recipients use the exact document recipient URL and need no Portal account. There is no forged SSO cookie or shared HR credential for agents. Native login may be required before editing; Portal keeps the original task open and refreshes when the user returns.

The company publishes actual approved legal PDFs and roles. The buyer/seller package capability is implemented; no synthetic or invented legal package is published for real customers.

## License

Copyright 2026 Kevv AI Labs Inc. [AGPL-3.0-or-later](LICENSE). Keep the corresponding-source offer and [third-party notices](THIRD_PARTY_NOTICES.md) with network distributions. The official Documenso image is pinned by digest; the bridge does not fork its signature ceremony.
