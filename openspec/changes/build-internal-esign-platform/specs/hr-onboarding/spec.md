## ADDED Requirements

### Requirement: Ordinary HR onboarding packets
The system SHALL allow HR preparers to create multi-document packets for offer letters, confidentiality agreements, handbook acknowledgements, IT/security policies, direct-deposit authorization, emergency contacts, and approved custom internal forms.

#### Scenario: HR creates a standard packet
- **WHEN** an HR preparer selects an approved packet and supplies employee merge data
- **THEN** the system creates one envelope with ordered documents, employee fields, and organization countersignature fields

### Requirement: Employee and employer routing
The system SHALL support employee completion followed by one or more organization countersigners and copy recipients.

#### Scenario: Employee finishes first
- **WHEN** the employee completes all assigned documents
- **THEN** the configured employer countersigner becomes active while the employee's submitted values remain frozen

### Requirement: Document-specific retention
The system SHALL require an approved retention class for every HR template document and SHALL not automatically apply the real-estate retention policy.

#### Scenario: Packet contains different retention classes
- **WHEN** an HR packet is completed
- **THEN** evidence metadata preserves each document's approved retention rule and responsible policy owner

### Requirement: Specialized form exclusion
The initial release SHALL block templates from being represented as compliant I-9, W-4, tax filing, medical, benefits-enrollment, or government identity workflows.

#### Scenario: Editor labels a template as Form I-9
- **WHEN** an editor attempts to publish the template as a supported I-9 workflow
- **THEN** the system blocks publication and identifies the specialized module as out of scope

### Requirement: Sensitive-field handling
The system SHALL classify and mask approved sensitive field types, omit their values from telemetry and audit payloads, and restrict access to explicitly permitted HR roles.

#### Scenario: Sensitive value is entered
- **WHEN** an employee submits an approved sensitive field
- **THEN** logs and generic audit events contain only field identity and completion status, not the value

### Requirement: Secure HR completion delivery
The system SHALL default sensitive HR packages to secure authenticated download links rather than PDF email attachments.

#### Scenario: Sensitive packet is finalized
- **WHEN** final evidence becomes available
- **THEN** recipients receive a notification and bounded retrieval link without sensitive document attachments

### Requirement: HR corrections preserve history
The system SHALL correct a sent or completed HR packet through a linked replacement or superseding envelope and SHALL not overwrite historical evidence.

#### Scenario: Employee name is materially incorrect after completion
- **WHEN** HR initiates a correction
- **THEN** the system preserves the original completed package, creates a linked corrected envelope, and records the reason
