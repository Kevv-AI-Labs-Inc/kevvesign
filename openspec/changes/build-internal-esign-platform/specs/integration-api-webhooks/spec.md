## ADDED Requirements

### Requirement: Versioned REST API
The system SHALL expose documented `/v1` resources for workspaces, transactions, templates, envelopes, recipients, documents, evidence, application clients, and webhook subscriptions without exposing internal database schemas.

#### Scenario: Client creates an envelope
- **WHEN** an authorized application submits a valid envelope request to `/v1/envelopes`
- **THEN** the system returns a stable envelope identifier, current status, external reference, and authorized next-action links

### Requirement: Idempotent write operations
The system SHALL support idempotency keys for create, send, void, resend, and other repeat-prone commands and SHALL reject conflicting reuse.

#### Scenario: Create request is retried
- **WHEN** a client repeats the same valid request with the same idempotency key
- **THEN** the system returns the original operation result without creating a duplicate envelope

### Requirement: Scoped API authorization
The system SHALL authenticate every API request and authorize it against client workspace, environment, and operation scopes.

#### Scenario: Read-only client attempts send
- **WHEN** a client without send scope calls the send command
- **THEN** the system denies the request and leaves the envelope unchanged

### Requirement: External references and correlation
The system SHALL support caller-provided external references and correlation IDs so a source project can reconcile transactions, envelopes, and events without relying on document names.

#### Scenario: Source project queries by external reference
- **WHEN** an authorized client queries a unique reference in its workspace
- **THEN** the system returns the associated resource and correlation metadata

### Requirement: Signed webhook events
The system SHALL sign every webhook delivery using an independently rotatable subscription secret over the timestamp and exact request body and SHALL include unique event and delivery identifiers.

#### Scenario: Completion webhook is delivered
- **WHEN** an envelope becomes completed after evidence finalization
- **THEN** the system sends an `envelope.completed` event whose signature can be verified without fetching the document

### Requirement: Webhook retry and replay
The system SHALL persist delivery attempts, retry transient failures with bounded exponential backoff, mark terminal failures, and allow controlled replay without changing the event ID.

#### Scenario: Consumer returns a server error
- **WHEN** a webhook endpoint returns a retryable failure
- **THEN** the system records the attempt and retries according to policy until success or terminal dead-letter state

### Requirement: Webhook replay protection contract
The system SHALL document timestamp tolerance and event-id deduplication so consumers can reject stale or duplicate deliveries safely.

#### Scenario: Consumer receives a duplicate event
- **WHEN** the same event is delivered again after a timeout
- **THEN** the consumer can identify it by event ID and return success without applying the business action twice

### Requirement: Consistent API errors and pagination
The system SHALL use a documented machine-readable error envelope, request ID, validation details without secrets, and cursor pagination for collection endpoints.

#### Scenario: Request validation fails
- **WHEN** a client submits invalid recipient or template data
- **THEN** the API returns the documented validation code, safe field errors, and request ID without partial creation

### Requirement: Completed-document retrieval
The system SHALL let authorized clients retrieve evidence metadata and obtain a bounded download grant after finalization without exposing Blob credentials.

#### Scenario: Client requests document before finalization
- **WHEN** an authorized client requests the completed document while finalization is pending
- **THEN** the API returns the current non-completed state and does not expose an incomplete object

### Requirement: Portal-delegated editor launch
The system SHALL let an authorized source-project backend create a short-lived, one-time eSign staff handoff for a stable actor, bounded role, explicit intent, and exact pre-registered return URL.

#### Scenario: Homix agent opens envelope preparation
- **WHEN** Homix Portal creates a valid preparation handoff and redirects the agent to its launch URL
- **THEN** eSign exchanges the fragment-carried ticket once for a bounded HttpOnly session without asking the agent to log in again

#### Scenario: Unregistered return URL is supplied
- **WHEN** a source application requests a handoff to a URL that is not an exact registered return URL
- **THEN** eSign rejects the request without creating any browser authority

### Requirement: Delegated actor attribution
The system SHALL constrain a delegated session by both actor role and application scopes and SHALL attribute audited actions to both the Portal actor and source application client.

#### Scenario: Portal preparer performs a scoped action
- **WHEN** a delegated preparer creates an allowed transaction or envelope
- **THEN** the audit event records the stable Portal actor subject and application-client ID without recording the credential
