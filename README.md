# Internal E-Sign Platform

Composable e-signature infrastructure for licensed NY, NJ, and CA real-estate forms and ordinary HR onboarding packets.

Homix Portal is the first connected application, not a hard-coded dependency. Any trusted backend can use a scoped application credential and one-time browser handoff; standalone staff access accepts a configurable set of OIDC providers such as Google Workspace or Entra. External recipients sign from one secure email link without an account.

The default signing engine remains available for development. Production can select the Documenso Envelope API adapter for the high-risk signing ceremony, routing, delivery, PDF sealing, and recipient UX while Kevv eSign retains business integrations, licensed-template governance, transaction mapping, and evidence projections. The boundary is provider-neutral so a future engine can replace Documenso without changing calling applications.

## Local development

```bash
cp .env.example .env
pnpm install
pnpm dev
```

- eSign administration and delegated editor: `http://localhost:5173`
- API: `http://localhost:4100`
- OpenAPI: `http://localhost:4100/docs/openapi.json`

Development mode uses a synthetic administrator, local private-file storage, a local email outbox, and no production forms or personal information. Azure deployment uses managed services. Delegated handoffs do not depend on the standalone administrator identity provider.

## Connect Homix Portal or another project

In **Workspace → Application credentials**, choose a stable connector key, register exact HTTPS return URLs, and issue a workspace-scoped credential. The plaintext credential is shown once; only its SHA-256 hash is stored. Keep it in the source project's backend secret store—never in browser JavaScript.

```bash
curl http://localhost:4100/v1/templates \
  --header "X-ESign-Key: $ESIGN_APPLICATION_KEY"
```

For a workflow that needs the eSign PDF editor, the connected backend creates a one-time handoff:

```bash
curl http://localhost:4100/v1/integration-sessions \
  --header "Content-Type: application/json" \
  --header "X-ESign-Key: $ESIGN_APPLICATION_KEY" \
  --data '{
    "actor": {
      "subject": "homix:user-42",
      "email": "agent@homixliving.com",
      "displayName": "Homix Agent",
      "role": "preparer"
    },
    "intent": { "kind": "prepare-envelope" },
    "returnUrl": "https://portal.homixliving.com/esign/return"
  }'
```

Redirect the employee's browser to the returned `launchUrl`. The five-minute ticket is one-time, is carried in a URL fragment so it is not sent in request logs, and is exchanged for a one-hour HttpOnly session with CSRF protection. The user can return to the registered source URL from the persistent sidebar action.

Scopes are `templates:read`, `templates:write`, `transactions:read`, `transactions:write`, `envelopes:read`, `envelopes:write`, `envelopes:send`, `evidence:read`, and `integration-sessions:create`. Delegated users are constrained by both their asserted role and the application's scopes. Credentials can be rotated or revoked; revocation invalidates associated sessions immediately. Envelope creation and send requests require an `Idempotency-Key` header. The old `/v1/portal-sessions` contract remains as a deprecated compatibility alias.

## Select a signing engine

Set `SIGNING_ENGINE_PROVIDER=native` for the local implementation or `documenso` for the adapter. Documenso mode additionally requires `DOCUMENSO_BASE_URL`, `DOCUMENSO_API_TOKEN`, and a random `DOCUMENSO_WEBHOOK_SECRET` of at least 32 characters. Configure Documenso to POST events to `/v1/signing-engine/webhooks/documenso` with that value in `X-Documenso-Secret`.

The adapter uses Documenso API v2 envelope endpoints. It creates multi-PDF envelopes, maps normalized drag/drop fields, distributes and redistributes requests, correlates provider recipients, ingests authenticated replay-safe events, downloads completed sealed PDFs, and preserves their exact bytes in the evidence package. Unsupported attachment fields fail before sending instead of being silently dropped.

The local release supports REST polling for source-project integration. Webhook HMAC and SSRF-defense primitives are included, while subscription delivery, retry, and dead-letter validation remain part of the Azure staging phase.

## Verification

```bash
pnpm verify
pnpm test:e2e
```

See [PLAN.md](PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License and source

Copyright 2026 Kevv AI Labs Inc. Kevv eSign is released under [AGPL-3.0-or-later](LICENSE). A running modified network service must offer its corresponding source as required by section 13. The application links back to this source repository; third-party acknowledgements are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
