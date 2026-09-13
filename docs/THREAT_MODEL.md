# Documenso integration threat model

## Boundaries

Documenso owns electronic signing, recipient authentication, the final PDF and its audit. The bridge does not create signatures, rewrite sealed files or implement a fallback engine. Portal owns business approval, actual payments, manual contracts and limited access.

| Risk                                           | Current control                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Forged Portal identity                         | Hashed client bearer key plus validated canonical actor assertion; server-only credentials                                           |
| Cross-agent or HR access                       | Native delegated owner, separate private teams, verified connection proof, fresh ownership checks and Portal authorization           |
| Wrong signer receives an HR action             | Exact verified email and bound recipient role; company identity from the verified company connection                                 |
| Approved contract changes after publication    | PDF and native layout fingerprints; every role and required field validated; HR draft shape checked again before sending             |
| Timeout creates duplicate envelopes            | Durable request intent, unique business idempotency keys, provider external ID recovery, exclusive operation leases                  |
| Forged or repeated native webhook              | Connection-specific secret, team/owner/ID correlation, bounded payload and durable digest inbox                                      |
| Dropped completion event                       | Native reconciliation, durable Portal outbox and HMAC callback with retries; Portal re-fetches authoritative state                   |
| Completion or finance is invented              | Applicant, company and file readiness are independent; callback never fabricates a payment; Portal activation checks remain separate |
| Sealed PDF is modified in transit              | Native bytes forwarded unchanged; completed status and exact native file membership checked before download                          |
| Recipient tokens leak in logs                  | Bridge request/body redaction and minimized state projection; gateway access URL logs disabled                                       |
| Customer changes business company accidentally | Explicit company selection for custom uploads; published package owns its company selection                                          |
| Gateway intercepts upstream traffic            | Upstream TLS hostname and certificate validation enabled; canonical forwarded host/protocol fixed in deployment                      |
| Runtime reaches unrelated database             | Separate PostgreSQL runtime accounts, cross-database connect denied and private network                                              |

## Limits

A recipient link establishes the assurance Documenso actually records; it does not establish government identity. The configured P12 is a self-signed service integrity seal, not an AATL or personal identity certificate. HR verification and any exception authorization are separate audited Portal facts and never rewrite electronic signing state.

Formal buyer/seller files must be supplied and approved by the company before publication. Historical SQL and file storage are preserved after engine retirement; no legacy WORM/SQL Ledger claim is made for the new Documenso database transport.

Unit coverage measures the bridge identity, native API, package and recipient-action boundaries. SQL/orchestration and actual native signing are verified separately against isolated PostgreSQL and the pinned official Documenso service; unit mocks do not establish final signing acceptance.
