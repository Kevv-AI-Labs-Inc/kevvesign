# Operational runbooks

## Recipient replacement or resend

Confirm envelope/recipient/workspace, verify the requester's authority, rotate the invitation, revoke prior sessions, preserve progress only when policy allows, send one new delivery, and confirm an audit event. Never reveal an invitation in production support logs.

## Void, correction, and supersession

Record a reason, transition through the guarded command, revoke every active session, notify parties, and keep the original immutable. A correction creates a linked envelope; it never edits bytes already presented.

## Failed finalization

Do not send completion. Inspect the safe correlation ID, source hash, PDF compatibility category, queue delivery count, and object availability. Retry the deterministic command. Escalate any hash mismatch as an integrity incident.

## Email outage

Leave envelope state intact, suppress duplicate recipients, allow bounded retry, monitor oldest queue age and dead letter, and use the operator resend only after provider recovery.

## Webhook replay

Confirm the subscription and event, preserve the original event ID, issue a new delivery ID/signature/timestamp, and record the operator/reason. The consumer must deduplicate by event ID.

## Key rotation

Create a new Key Vault version, sign/verify a synthetic manifest, switch new evidence to the version, retain historical public key/version access, and sample old/new package verification.

## Legal hold

Require authorized owner, case/reference, reason, scope, and review date. Apply hold to every evidence object, verify state, and audit placement/release. Release never shortens active time retention.

## Restore and integrity mismatch

Restore into an isolated environment, block outbound email/webhooks, verify SQL Ledger digest and sampled/full evidence packages, document RPO/RTO, and destroy the isolated copy under policy. Treat any mismatch as high severity and preserve affected data.
