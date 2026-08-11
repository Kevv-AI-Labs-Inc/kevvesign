## ADDED Requirements

### Requirement: Workspace data isolation
The system SHALL associate every business record and object reference with exactly one workspace and SHALL enforce workspace scope in every staff and application-client request.

#### Scenario: Member accesses own workspace
- **WHEN** an authenticated member requests an envelope belonging to a workspace in which the member has a permitted role
- **THEN** the system returns only the data allowed by that role

#### Scenario: Cross-workspace identifier is supplied
- **WHEN** a caller supplies an otherwise valid identifier belonging to another workspace
- **THEN** the system denies access without revealing whether the target exists

### Requirement: Portal-first staff access
The system SHALL use a source-Portal delegated session as the normal access path for preparers, approvers, and auditors and SHALL not require those users to maintain a separate eSign login.

#### Scenario: Valid Portal handoff
- **WHEN** a registered application presents a one-time handoff for a permitted actor and return URL
- **THEN** the system establishes a bounded staff session whose authority is the intersection of the actor role and application scopes

### Requirement: Exceptional administrator authentication
The system SHALL support a configured organization identity provider for the small standalone administrator group and SHALL keep administrator authority unavailable to Portal-delegated roles.

#### Scenario: Portal claims an administrator role
- **WHEN** a source application attempts to create a delegated platform or workspace administrator
- **THEN** the system rejects the request and creates no delegated session

### Requirement: Role-based staff authorization
The system SHALL support platform administrator, workspace administrator, preparer, approver, and auditor roles with deny-by-default permissions.

#### Scenario: Preparer attempts an administrator action
- **WHEN** a preparer attempts to manage workspace credentials or retention policies
- **THEN** the system denies the operation and records the authorization failure without sensitive request content

### Requirement: Application client credentials
The system SHALL issue independently revocable application credentials scoped to an environment, workspace, and allowed API operations, and SHALL store only protected credential material.

#### Scenario: Scoped client creates an envelope
- **WHEN** an active client credential with envelope-create scope calls the correct workspace endpoint
- **THEN** the system accepts the request and records the client identity in the audit trail

#### Scenario: Revoked client is used
- **WHEN** a revoked or expired client credential is presented
- **THEN** the system rejects the request and does not execute a partial operation

### Requirement: Controlled privileged support access
The system SHALL require a reason, bounded expiration, and audit record for any platform administrator access to a workspace's business data.

#### Scenario: Administrator enters support mode
- **WHEN** a platform administrator requests workspace support access with an approved reason
- **THEN** the system grants only the configured temporary permissions and records grant, use, and expiration events

### Requirement: Membership lifecycle
The system SHALL make membership suspension and removal effective for new requests immediately and SHALL allow administrators to revoke active staff sessions.

#### Scenario: Departed staff member is removed
- **WHEN** a workspace administrator removes a staff member
- **THEN** the member cannot create, view, send, or download workspace records on subsequent requests
