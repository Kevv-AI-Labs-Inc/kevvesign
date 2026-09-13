# ADR 0002: Documenso is the only signing engine; Kevv eSign is a Portal integration tool

- Date: 2026-09-12
- Status: Accepted product direction by the user; implementation pending.
- Supersedes: the custom signing-platform scope in PLAN.md and build-internal-esign-platform; ADR 0001 only where it prescribes a separate authoritative signing/evidence platform. Azure hosting itself is not rejected.

## Decision

Serve three company workflows: agent onboarding contracts, buyer/seller signing packages, and occasional custom documents prepared by agents. Use Documenso for document/template editing, recipient signing, signing order, reminders, PDF sealing, signature audit and completed-document delivery.

Retain only the integration responsibilities that Documenso cannot infer: Portal authentication/authorization, company package definitions, business-to-provider identity and document mappings, idempotent orchestration of API calls, status synchronization and controlled access to provider output. Documenso is authoritative for electronic signing facts and provider-signed files; Portal is authoritative for business/account/payment decisions, verified offline or historical contracts, and scoped temporary access grants.

Use upstream native interfaces first. Embedded editing is optional and requires verified capability and licensing, not a justification to build another editor. Validate real per-agent ownership on both surfaces before rollout. Keep HR records isolated from agent client documents.

No legacy native signing compatibility is required. The user explicitly excludes the current one or two pending onboardings as a cutover constraint. Remove native engine fallback rather than retaining two engines. This does not instruct deletion of business accounts or stored records.

## Portal product surfaces and administrator scope

Onboarding is automatically surfaced after login according to the current server-side onboarding state. It does not require the newcomer to choose templates from a generic signing dashboard. Client packages and ad hoc documents belong to a dedicated Portal file-signing workspace (proposed `/signing`) that uses Documenso native authoring and signing interfaces.

The same implementation scope includes `/admin/agents?view=onboarding`: explicit next actions, tasks counted by unresolved work even after activation, verified paper/historical contracts, recognition of existing agents, receipt recording independent of signature state, and auditable capability-limited temporary access with expiry. Contract facts, payment facts and effective access remain separate. No manual decision fabricates Documenso completion or payment. Existing editor-bypass protections and company countersign tasks must remain covered by regression tests.

Verified historical contracts are a new supported business path, not a requirement to migrate existing native signing sessions. Portal owns these administrative records; eSign remains a thin Documenso integration service.

## Consequences

The existing custom signer, field editor, invitation/session engine, signature rendering, PDF finalizer, and placeholder signing workflows are retirement targets. Existing Portal onboarding/payment/approval integration, useful authorization and idempotency checks, business package mappings, and the Documenso adapter are candidates for reuse.

Do not claim completion based on simulated upstream tests or a healthy container. Completion requires all three workflows running against a real, version-pinned Documenso deployment, correct privacy/ownership, return-to-Portal behavior, reliable status recovery and unchanged signed bytes.

See [the implementation and acceptance plan](../DOCUMENSO_PORTAL_PLAN.md).
