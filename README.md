# Kevv eSign · Documenso integration for Portal

Documenso is the sole signing engine for the new integration. `apps/bridge` provides the business API used by Homix Portal for agent onboarding, buyer/seller packages and custom documents. Documenso supplies its own editor, signer interface, delivery, completion and audit records. Portal owns onboarding business decisions, paper/historical contract verification, payments and access.

**Release status (2026-09-13):** real multi-recipient, sequential onboarding and custom signing completed in the pinned native engine. Sealed PDFs, cryptographic integrity, certificate/audit, Portal return and durable HR callbacks passed. `esign.kevv.ai` now serves Documenso through the existing TLS entry point; 11 approved HR packages and both company identities are verified on that domain. Both source PRs and main CI passed, and Portal is live through its existing Git deployment. The old API has zero replicas, the old finalizer automatic trigger is disabled, and 50 obsolete Portal settings are removed. Historical records remain preserved.

## Start here

- [Product and acceptance plan](docs/DOCUMENSO_PORTAL_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Production setup and cutover](docs/DEPLOYMENT.md)
- [Signing operations](docs/SIGNING_OPERATIONS.md)
- [Release and retirement evidence](docs/qa/2026-09-12-documenso-integration.md)

## Development

Use Node 22 and pnpm 10.4.1. Configure a **separate test** Documenso 2.18.0 instance and PostgreSQL database. Copy `.env.example` into an ignored local environment file, supply generated local secrets and start the bridge with the environment loaded:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm --filter @esign/bridge typecheck
pnpm exec vitest run apps/bridge/src/__tests__/contract.test.ts
pnpm --filter @esign/bridge build
```

The default development command starts the bridge. The custom signing API/UI, PDF finalizer, workflows and their packages have been removed. Their Git history and archived IaC remain available for recovery; they are not part of the build. `apps/gateway` is a small Nginx proxy for the existing public hostname, with upstream certificate validation and no PDF/signing logic.

The bridge listens on port 4100. `/health/live` identifies the engine/version; `/health/ready` checks its database and reconciliation loop. Backend callers authenticate with a bearer API key and a canonical Portal actor assertion; credentials never belong in browser code.

A customer editor needs a real Documenso user and its own isolated connection. Signer recipients use the exact document recipient URL and need no Portal account. There is no forged SSO cookie or shared HR credential for agents. Native login may be required before editing; Portal keeps the original task open and refreshes when the user returns.

The company publishes actual approved legal PDFs and roles. The buyer/seller package capability is implemented; no synthetic or invented legal package is published for real customers.

## License

Copyright 2026 Kevv AI Labs Inc. [AGPL-3.0-or-later](LICENSE). Keep the corresponding-source offer and [third-party notices](THIRD_PARTY_NOTICES.md) with network distributions. The official Documenso image is pinned by digest; the bridge does not fork its signature ceremony.
