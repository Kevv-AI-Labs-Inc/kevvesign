## ADDED Requirements

### Requirement: Environment isolation
The system SHALL isolate development, staging, and production identities, data stores, storage, keys, email configuration, application registrations, and deployment permissions.

#### Scenario: Staging workload requests production secret
- **WHEN** a staging managed identity attempts to access production Key Vault or storage
- **THEN** Azure authorization denies access and the attempt is observable

### Requirement: Managed secrets and cryptographic keys
The system SHALL use managed identities where supported and SHALL keep manifest-signing keys, credentials, and certificates in Key Vault with least-privilege RBAC and rotation procedures.

#### Scenario: Application instance accesses signing key
- **WHEN** an authorized finalizer requests a manifest signature
- **THEN** Key Vault performs the allowed operation without exposing private key bytes to source control or configuration files

### Requirement: Secure upload pipeline
The system SHALL enforce file count and size limits, declared and detected type checks, PDF structural validation, malware scanning, quarantine, and safe rejection before an upload becomes usable.

#### Scenario: Malicious upload is detected
- **WHEN** scanning or parsing identifies a malicious or disallowed file
- **THEN** the system quarantines or deletes it according to policy, blocks template use, and alerts without logging document content

### Requirement: Web application protections
The system SHALL enforce TLS, secure cookies, CSRF defenses, strict CORS, Content Security Policy, frame restrictions, input validation, output encoding, rate limiting, and safe redirect rules.

#### Scenario: Untrusted origin submits a signing mutation
- **WHEN** a cross-site request lacks valid session and CSRF context
- **THEN** the system rejects the request without changing recipient or envelope state

### Requirement: Sensitive telemetry exclusion
The system MUST NOT record invitation secrets, session tokens, API credentials, signature images, document bodies, field values, SSNs, bank values, or other classified content in ordinary logs or traces.

#### Scenario: API validation error contains sensitive input
- **WHEN** a request with a sensitive field fails validation
- **THEN** telemetry records the safe field identifier and error category but not the submitted value

### Requirement: Operational monitoring and alerts
The system SHALL monitor API health, authentication failures, email bounce, queue backlog, workflow age, PDF finalization, webhook dead letters, SQL and Blob availability, Key Vault errors, and ledger verification.

#### Scenario: PDF jobs accumulate
- **WHEN** queue age or failed-finalization count exceeds the configured threshold
- **THEN** an actionable alert reaches the designated operator with safe correlation identifiers

### Requirement: Backup and restore verification
The system SHALL maintain supported database backups and evidence recovery material and SHALL perform documented periodic restores into an isolated environment.

#### Scenario: Restore exercise is executed
- **WHEN** the scheduled recovery test occurs
- **THEN** operators restore metadata, verify sampled evidence packages and manifests, and record achieved RPO/RTO and remediation actions

### Requirement: Ledger and evidence integrity verification
The system SHALL schedule database ledger verification and sampled/full evidence package verification and SHALL alert on any mismatch.

#### Scenario: Digest verification fails
- **WHEN** recomputed ledger or evidence hashes differ from trusted digests
- **THEN** the system raises a high-severity incident and preserves the affected data for investigation

### Requirement: Privileged action audit
The system SHALL record configuration changes, credential lifecycle, retention changes, legal holds, support access, exports, restores, and production deployment actions with responsible identity.

#### Scenario: Retention policy is extended
- **WHEN** an authorized administrator extends a policy
- **THEN** the system records the old value, new value, actor, reason, and effective time

### Requirement: Incident and operational runbooks
The system SHALL maintain tested runbooks for recipient replacement, resend, void, failed finalization, webhook replay, key rotation, legal hold, export, restore, email outage, and security incident response.

#### Scenario: Outbound email provider is unavailable
- **WHEN** invitation delivery fails due to provider outage
- **THEN** the runbook and workflow preserve the envelope, retry safely, alert operators, and avoid duplicate recipients

### Requirement: Data lifecycle enforcement
The system SHALL delete eligible mutable drafts and expired operational data according to approved policy while preserving protected evidence and active legal holds.

#### Scenario: Draft reaches cleanup age
- **WHEN** an unsent draft reaches its configured retention age without a hold
- **THEN** the system deletes eligible objects and metadata through an auditable cleanup job
