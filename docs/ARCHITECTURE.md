# Architecture

The system is a TypeScript modular monolith with four deployable units: the React web surface, Fastify API, Durable Functions workflow host, and isolated PDF finalizer job. Shared packages own public contracts, domain rules, and Azure/local adapters.

## Trust boundaries

1. HR, agents, and managers normally authenticate in a connected system. Homix Portal is the first connector. Any connector backend uses its own scoped `X-ESign-Key` and stable `connectorKey` to issue a five-minute, one-time eSign launch for a named actor and an exact allowlisted return URL.
2. The launch ticket is placed after `#` in the redirect URL, exchanged once through POST, and replaced by a one-hour HttpOnly `esign_staff` cookie plus CSRF token. The resulting principal is constrained by the asserted non-admin role and the source application's scopes.
3. Internal project API calls use separately scoped `X-ESign-Key` credentials. Each credential is workspace-bound and assigned exactly one business domain, `HR` or `REAL_ESTATE`; domain checks apply in addition to scopes on every template, transaction, envelope, integration-session, and evidence path. Only a SHA-256 secret hash is stored. Credentials are expirable, rotatable, and revocable, and revocation also invalidates delegated sessions.
4. Standalone administrator access is an exception path for template governance, credential management, audit, and recovery. A provider registry verifies configured OIDC issuers and audiences; Google Workspace, Entra, or another standards-compliant provider can be added without changing authorization code.
5. Recipients enter through a high-entropy invitation. The GET route is side-effect-free. JavaScript exchanges the invitation through POST for a bounded HttpOnly session and CSRF token.
6. PDF source and evidence objects are private. Only the API/finalizer managed identities can access them. Queue messages carry object references and expected hashes, never raw documents or signing credentials.

## State invariants

- Published template versions and sent envelope content are immutable.
- All commands are transition-checked and repeat-prone writes require idempotency keys.
- A routing group activates only after all required recipients in the previous group complete.
- Completion is visible only after PDF generation, hash verification, manifest signing, and evidence commit.
- Audit payloads exclude document content, signature marks, tokens, access codes, and field values.
- An envelope sent through an external provider freezes its `signingProviderConnectionId`; changing the workspace mapping cannot move that envelope to another provider account.

## Local substitutes

Local development stores state in an atomic JSON file, private objects under `.data/objects`, email messages under `.data/outbox`, and manifests with a development HMAC. These substitutes exercise the same interfaces as Azure and are prohibited in production by configuration validation.

## Source-project integration boundary

Calling applications can list published templates, create property/HR transaction folders, create and send envelopes, query status, void envelopes, and retrieve evidence when their credential includes the corresponding scope. For interactive PDF field placement or envelope preparation, the source backend creates a one-time integration session with `dashboard`, `prepare-envelope`, `edit-template`, or `view-envelope` intent and redirects the browser to eSign. Version one uses a top-level redirect rather than an iframe to avoid third-party-cookie and framing-policy failures.

Every delegated audit event records both the stable external actor subject and the source application-client ID. The source credential is never exposed. Workspace administration and credential management cannot be delegated through an integration session.

## Signing-engine boundary

The domain depends on a small `SigningEngine` port, not Documenso types. A runtime connection registry resolves `Workspace.signingProviderConnectionId` to a configured adapter. An unmapped workspace uses the native engine; merely deploying or configuring the Homix Documenso service does not opt a workspace into it. On the first external send, the resolved connection ID is copied to the envelope and remains authoritative for every later provider operation. Moving new work to another Documenso account therefore means registering a new connection ID and updating the workspace mapping while retaining the old connection for in-flight and completed envelopes.

In Documenso mode, the adapter owns creation, delivery, routing, resend, cancellation, signing status, and retrieval of sealed PDFs. Kevv eSign owns connector identities, template licensing metadata, real-estate/HR transaction context, local projections, audit correlation, retention, and evidence manifests. Provider IDs are stored explicitly so duplicate/shared email addresses do not become the primary identity key. Provider API tokens and webhook secrets are deployment secrets: Azure stores them only in Key Vault and resolves them through managed identity; they never enter workspace state, application credentials, source-control files, or browser code.

Webhook authentication happens before state lookup or event processing. Event digests provide replay protection. A completed event is acknowledged only after every expected PDF has been retrieved, validated as a PDF, hashed, stored, and finalized; provider-sealed PDFs are never rewritten because doing so would invalidate their digital seal.
