# Threat model

## Protected assets

- Licensed PDFs, completed agreements, HR records, signatures, recipient contact data, and field values.
- Invitation/session/API credentials, Key Vault signing keys, audit history, and evidence manifests.
- Workspace membership, retention, legal-hold, template edition, and workflow configuration.

## Principal abuse cases and controls

| Abuse case                                | Primary controls                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mail scanner consumes invitation          | Invitation GET is side-effect-free; only POST exchanges it for a session                                                              |
| Forwarded invitation is used              | Recipient-specific 256-bit link, expiry/revocation, accurate email-possession assurance, optional separately communicated access code |
| Cross-workspace IDOR                      | Workspace is part of every repository lookup; foreign IDs return generic 404; isolation tests                                         |
| CSRF against signer                       | SameSite cookies, server-stored session and CSRF hashes, matching custom header                                                       |
| Integration launch ticket leaks           | Five-minute one-time ticket in URL fragment, POST exchange, no body logging, ticket/hash redaction, exact HTTPS return URL allowlist  |
| Connector overstates employee role        | Delegated roles exclude administrators; eSign applies both role permissions and application scopes; every action has dual attribution |
| Connector credential is revoked           | New API calls fail and all associated delegated browser sessions are invalidated immediately                                          |
| Signing-engine webhook is forged/replayed | Constant-time shared-secret verification, bounded schema, event digest idempotency, provider/local ID correlation                     |
| Signing engine and local state diverge    | External ID recovery, synchronization lock, provider-owned resend/cancel, explicit status projection, retryable completion            |
| Token leakage through logs                | Structured logger redaction; no request body logging; URLs/cookies/auth/CSRF redacted                                                 |
| Malicious or pathological PDF             | Size/type/magic check, parser limits, quarantine boundary, XFA/encryption rejection; production malware scan release gate             |
| Webhook SSRF                              | HTTPS only, no credentials/custom ports, DNS resolution and private/link-local/loopback rejection, redirect disabled                  |
| Replay/duplicate commands                 | Workspace-scoped idempotency key plus request digest, queue duplicate detection, webhook event IDs                                    |
| Staff creates someone else's signature    | Recipient signature fields cannot be populated by staff merge data; signing mutation requires recipient session                       |
| Completed record is altered/deleted       | Source/output hashes, canonical manifest signature, SQL Ledger audit, Blob locked retention and legal hold                            |
| Sensitive values enter telemetry          | Redaction rules, safe audit payload allowlist behavior, tests scanning logs                                                           |
| Compromised workload crosses environments | Separate managed identities, resource groups/subscriptions, stores, vaults, app registrations, email senders                          |

## Accepted version-one limits

Email invitation possession does not prove a particular natural person's government identity. Shared mailboxes and forwarded links weaken assurance. The completion certificate states the actual method and never claims KBA, ID verification, notarization, or qualified/digital-certificate status. Documenso integration reduces implementation risk but does not by itself establish legal suitability; production use still requires counsel-approved forms, disclosures, retention, and operating procedures.
