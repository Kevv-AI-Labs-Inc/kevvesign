## ADDED Requirements

### Requirement: Jurisdiction-aware transactions
The system SHALL require each real-estate transaction and production template to identify NY, NJ, or CA and SHALL apply the currently approved versioned jurisdiction pack.

#### Scenario: Unsupported jurisdiction is selected
- **WHEN** a preparer attempts to send a real-estate envelope for an unapproved jurisdiction
- **THEN** the system blocks sending and does not imply that the workflow is supported

### Requirement: Transaction folders and related envelopes
The system SHALL group listing, offer, counteroffer, amendment, disclosure, and other envelopes under one property transaction while preserving each envelope as an independent immutable record.

#### Scenario: Counteroffer follows an offer
- **WHEN** an authorized agent creates a counteroffer from a completed or declined offer
- **THEN** the system links both envelopes in the transaction history without modifying the original offer

### Requirement: Real-estate party roles
The system SHALL support configurable buyer, seller, spouse/co-owner, authorized entity signatory, agent, broker/approver, attorney/viewer, and receives-copy roles.

#### Scenario: Multiple sellers sign in parallel
- **WHEN** a template assigns two seller signers to the same routing group
- **THEN** each receives recipient-specific fields and both must finish before the next required group activates

### Requirement: Broker approval policy
The system SHALL allow workspace and template policies to require broker approval before an envelope may be sent externally.

#### Scenario: Required broker approval is missing
- **WHEN** an agent attempts to send a prepared envelope that requires approval
- **THEN** the system transitions to approval pending and withholds all external invitations

### Requirement: Real-estate deadlines
The system SHALL support explicit offer, irrevocable, and envelope expiration timestamps with timezone display and immutable audit recording.

#### Scenario: Recipient opens after deadline
- **WHEN** a recipient opens an invitation after the binding envelope expiration
- **THEN** the portal shows the expired status and does not permit signing

### Requirement: Initials and repeated field placement
The system SHALL allow templates to require initials on selected or all pages for a role and SHALL validate each required initial independently.

#### Scenario: Buyer misses one required page initial
- **WHEN** the buyer selects Finish with one assigned page initial incomplete
- **THEN** the system prevents completion and navigates to that page

### Requirement: Form license and edition governance
The system SHALL store source/license owner, edition, effective date, retirement date, and internal publication approval for every real-estate template version.

#### Scenario: Form edition is retired
- **WHEN** a newer reviewed edition becomes active
- **THEN** new envelopes cannot use the retired edition while historical envelopes remain reproducible

### Requirement: Real-estate retention baseline
The system SHALL apply a seven-year default retention to completed initial-state real-estate evidence unless an approved policy requires a longer period or legal hold.

#### Scenario: Seven-year policy is applied
- **WHEN** a NY, NJ, or CA real-estate envelope completes without a policy override
- **THEN** the completed evidence receives the approved seven-year immutable retention

### Requirement: Completed-party copy
The system SHALL furnish each agreement party a completed copy or secure retrieval link promptly after evidence finalization according to workspace delivery policy.

#### Scenario: All parties complete an offer
- **WHEN** the final offer package is committed
- **THEN** every entitled party receives a recorded completion delivery
