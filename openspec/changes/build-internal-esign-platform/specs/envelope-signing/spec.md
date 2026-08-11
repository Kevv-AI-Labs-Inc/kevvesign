## ADDED Requirements

### Requirement: Guarded envelope lifecycle
The system SHALL enforce the defined envelope state machine and SHALL reject invalid, stale, or repeated transitions without corrupting state.

#### Scenario: Draft is sent successfully
- **WHEN** a prepared envelope has valid documents, recipients, fields, policies, and optional approval
- **THEN** the system freezes the envelope version and transitions it to sent exactly once

#### Scenario: Completed envelope is modified
- **WHEN** any caller attempts to change documents, fields, recipients, or values on a completed envelope
- **THEN** the system rejects the mutation and requires a linked correction or superseding envelope

### Requirement: Immutable sent snapshot
The system SHALL bind every recipient action to the exact document and field-schema hashes frozen at send time.

#### Scenario: Recipient signs a field
- **WHEN** a recipient completes an assigned signature field
- **THEN** the audit event records the recipient, field, action time, and frozen document digest

### Requirement: Recipient routing
The system SHALL support sequential routing groups and parallel recipients within a routing group for signer, approver, countersigner, view-only, and receives-copy roles.

#### Scenario: Sequential routing is configured
- **WHEN** all required recipients in routing group one finish
- **THEN** the system activates routing group two and sends its invitations

#### Scenario: Parallel routing is configured
- **WHEN** one of several active parallel signers finishes
- **THEN** the other parallel signers remain active and the next routing group waits for all required completions

### Requirement: Explicit consent and signing intent
The system SHALL record the disclosure version and explicit electronic-record consent before accepting signature fields, and SHALL require an explicit Finish action to complete a recipient.

#### Scenario: Recipient has not accepted consent
- **WHEN** a recipient attempts to apply a signature before accepting the current disclosure
- **THEN** the system blocks the signature and presents the disclosure and paper/withdrawal information

### Requirement: Recipient field validation
The system SHALL allow a recipient to edit only assigned active fields and SHALL validate all required fields before recipient completion.

#### Scenario: Required initials are missing
- **WHEN** a recipient selects Finish while an assigned required initials field is empty
- **THEN** the system keeps the recipient in progress and navigates to the missing field

### Requirement: Resumable signing session
The system SHALL persist recipient progress safely and allow an unexpired recipient to resume without changing already-frozen document content.

#### Scenario: Mobile browser closes mid-signing
- **WHEN** the recipient later reopens a valid invitation
- **THEN** the system restores permitted field progress and continues the same signing ceremony

### Requirement: Decline, void, and expiration
The system SHALL support recipient decline with a recorded reason policy, authorized sender void with reason, and automatic expiration at the envelope deadline.

#### Scenario: Envelope expires before completion
- **WHEN** the configured expiration time passes with required recipients incomplete
- **THEN** the system prevents further signing, records expiration, and notifies configured parties

### Requirement: Reminder orchestration
The system SHALL schedule configurable reminders only for active incomplete recipients and SHALL stop reminders after completion, decline, void, or expiration.

#### Scenario: Recipient completes before reminder
- **WHEN** a pending reminder becomes due after the recipient has completed
- **THEN** the workflow suppresses the reminder and records no outbound reminder delivery

### Requirement: Completion waits for evidence finalization
The system SHALL announce envelope completion only after all required recipients finish and the final PDF and evidence package have been verified and committed.

#### Scenario: PDF finalization fails
- **WHEN** all recipients have finished but deterministic PDF finalization fails
- **THEN** the system enters failed-finalization state, alerts operators, and does not send a completed-envelope notice

### Requirement: Completion delivery
The system SHALL provide each entitled party with a completed copy or secure download link according to document sensitivity policy.

#### Scenario: Sensitive HR packet completes
- **WHEN** a sensitive HR packet is finalized
- **THEN** the completion email contains a secure access link and does not attach the sensitive PDF
