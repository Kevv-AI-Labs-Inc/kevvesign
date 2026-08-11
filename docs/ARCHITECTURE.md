# Architecture

The system is a TypeScript modular monolith with four deployable units: the React web surface, Fastify API, Durable Functions workflow host, and isolated PDF finalizer job. Shared packages own public contracts, domain rules, and Azure/local adapters.

## Trust boundaries

1. HR, agents, and managers normally authenticate in Homix Portal. The Portal backend uses its `X-ESign-Key` to issue a five-minute, one-time eSign launch for a named Portal actor and a registered exact return URL.
2. The launch ticket is placed after `#` in the redirect URL, exchanged once through POST, and replaced by a one-hour HttpOnly `esign_staff` cookie plus CSRF token. The resulting principal is constrained by the Portal actor role and the source application's scopes.
3. Internal project API calls use separately scoped `X-ESign-Key` credentials. Only a SHA-256 secret hash is stored; credentials are workspace-bound, scoped, expirable, rotatable, and revocable. Revocation also invalidates delegated sessions.
4. A standalone administrator identity provider is an exception path for template governance, credential management, audit, and recovery. The current deployment adapter is Entra; Google Workspace is the preferred administrator provider before production staging.
5. Recipients enter through a high-entropy invitation. The GET route is side-effect-free. JavaScript exchanges the invitation through POST for a bounded HttpOnly session and CSRF token.
6. PDF source and evidence objects are private. Only the API/finalizer managed identities can access them. Queue messages carry object references and expected hashes, never raw documents or signing credentials.

## State invariants

- Published template versions and sent envelope content are immutable.
- All commands are transition-checked and repeat-prone writes require idempotency keys.
- A routing group activates only after all required recipients in the previous group complete.
- Completion is visible only after PDF generation, hash verification, manifest signing, and evidence commit.
- Audit payloads exclude document content, signature marks, tokens, access codes, and field values.

## Local substitutes

Local development stores state in an atomic JSON file, private objects under `.data/objects`, email messages under `.data/outbox`, and manifests with a development HMAC. These substitutes exercise the same interfaces as Azure and are prohibited in production by configuration validation.

## Source-project integration boundary

Calling applications can list published templates, create property/HR transaction folders, create and send envelopes, query status, void envelopes, and retrieve evidence when their credential includes the corresponding scope. For interactive PDF field placement or envelope preparation, the source backend creates a one-time Portal session with `dashboard`, `prepare-envelope`, `edit-template`, or `view-envelope` intent and redirects the browser to eSign. Version one uses a top-level redirect rather than an iframe to avoid third-party-cookie and framing-policy failures.

Every delegated audit event records both the stable Portal actor subject and the source application-client ID. The source credential is never exposed. Workspace administration and credential management cannot be delegated through a Portal session.
