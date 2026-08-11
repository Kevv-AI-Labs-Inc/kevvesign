## ADDED Requirements

### Requirement: Complete evidence package
The system SHALL generate an evidence package containing original documents, completed documents, completion certificate, canonical manifest, audit export, consent record, recipient assurance methods, and relevant email delivery events.

#### Scenario: Envelope finalizes successfully
- **WHEN** all required recipients finish and PDF validation succeeds
- **THEN** the system commits every required evidence component and records their immutable object identifiers

### Requirement: Deterministic document hashing
The system SHALL compute and record SHA-256 digests for original, sent, and completed document bytes and SHALL verify expected source hashes before finalization.

#### Scenario: Source object changed unexpectedly
- **WHEN** the finalizer reads source bytes whose digest differs from the frozen envelope digest
- **THEN** finalization fails without publishing a completed document

### Requirement: Append-only audit history
The system SHALL store security- and evidence-relevant events in append-only ledger tables with canonical payloads, actor identity, server time, request correlation, document context, and previous-event hash.

#### Scenario: Administrative void is recorded
- **WHEN** an authorized user voids an envelope
- **THEN** an immutable event records the actor, reason, prior state, resulting state, and correlation identifier

### Requirement: Signed evidence manifest
The system SHALL sign the canonical final manifest with a Key Vault-held organizational key and SHALL store the algorithm and key version required for future verification.

#### Scenario: Manifest is verified after key rotation
- **WHEN** an auditor verifies a historical package after the active key has changed
- **THEN** the system uses the recorded historical public-key material or key version to validate the signature

### Requirement: Immutable retention
The system SHALL apply the selected time-based immutable retention policy to verified completed documents and evidence objects only after successful finalization.

#### Scenario: Administrator attempts early deletion
- **WHEN** any user or service attempts to delete a completed object before its locked retention expires
- **THEN** storage rejects deletion and the system surfaces the protected status

### Requirement: Legal holds
The system SHALL allow authorized legal/compliance users to place and release a reasoned legal hold without shortening any active time-based retention.

#### Scenario: Complaint creates a legal hold
- **WHEN** an authorized user applies a hold to a transaction
- **THEN** all covered evidence objects remain protected until the hold is explicitly released and every hold action is audited

### Requirement: Policy-based retention
The system SHALL select retention by workspace, jurisdiction, workflow, and document class, with completed real-estate packages defaulting to seven years until an approved policy changes.

#### Scenario: HR documents have different policies
- **WHEN** one HR packet contains documents assigned different retention classes
- **THEN** the system records and enforces the correct retention basis for each completed document or separated evidence object

### Requirement: Evidence verification and export
The system SHALL provide an authorized verification operation that checks file hashes, manifest signature, audit chain, ledger digest, object retention state, and package completeness.

#### Scenario: Package passes verification
- **WHEN** an auditor requests verification for an intact completed envelope
- **THEN** the system returns a machine-readable and human-readable successful verification report without modifying the evidence

### Requirement: Authorized evidence retrieval
The system SHALL keep evidence storage private and SHALL require current authorization or a recipient completion entitlement for every retrieval.

#### Scenario: Expired download URL is reused
- **WHEN** a caller presents an expired short-lived download grant
- **THEN** access is denied and the underlying Blob object remains private
