# Internal E-Sign Platform

Private, Portal-first e-signature infrastructure for licensed NY, NJ, and CA real-estate forms and ordinary HR onboarding packets.

Homix Portal is the normal entry point for HR, agents, and managers. eSign owns templates, signing sessions, completed files, and evidence; ordinary staff receive a short-lived delegated session and do not create or use a second eSign login. External recipients continue to sign from one secure email link without an account.

## Local development

```bash
cp .env.example .env
pnpm install
pnpm dev
```

- eSign administration and delegated editor: `http://localhost:5173`
- API: `http://localhost:4100`
- OpenAPI: `http://localhost:4100/docs/openapi.json`

Development mode uses a synthetic administrator, local private-file storage, a local email outbox, and no production forms or personal information. Azure deployment uses managed services. The normal Portal handoff does not depend on the standalone administrator identity provider; the current fallback administrator adapter is Entra and will be switched or extended to Google Workspace during the deployment identity gate.

## Connect Homix Portal or another internal project

In **Workspace → Application credentials**, register the Portal's exact HTTPS return URL and issue a workspace-scoped credential. The plaintext credential is shown once; only its SHA-256 hash is stored. Keep it in the source project's backend secret store—never in browser JavaScript.

```bash
curl http://localhost:4100/v1/templates \
  --header "X-ESign-Key: $ESIGN_APPLICATION_KEY"
```

For a workflow that needs the eSign PDF editor, the Portal backend creates a one-time handoff:

```bash
curl http://localhost:4100/v1/portal-sessions \
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

Redirect the employee's browser to the returned `launchUrl`. The five-minute ticket is one-time, is carried in a URL fragment so it is not sent in request logs, and is exchanged for a one-hour HttpOnly session with CSRF protection. The user can return to the registered Portal URL from the persistent sidebar action.

Scopes are `templates:read`, `templates:write`, `transactions:read`, `transactions:write`, `envelopes:read`, `envelopes:write`, `envelopes:send`, `evidence:read`, and `portal-sessions:create`. Delegated users are constrained by both their Portal role and the application's scopes. Credentials can be rotated or revoked; revocation invalidates associated Portal sessions immediately. Envelope creation and send requests require an `Idempotency-Key` header.

The local release supports REST polling for source-project integration. Webhook HMAC and SSRF-defense primitives are included, while subscription delivery, retry, and dead-letter validation remain part of the Azure staging phase.

## Verification

```bash
pnpm verify
pnpm test:e2e
```

See [PLAN.md](PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
