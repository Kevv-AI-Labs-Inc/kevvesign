## ADDED Requirements

### Requirement: Licensed PDF ingestion
The system SHALL accept only supported PDF files that pass size, structure, encryption, malware, and compatibility checks, and SHALL require source and license metadata before a template can be published.

#### Scenario: Valid licensed PDF is uploaded
- **WHEN** an authorized preparer uploads a supported PDF and supplies required source metadata
- **THEN** the system quarantines, scans, hashes, stores, and makes the PDF available for template editing

#### Scenario: Unsupported PDF is uploaded
- **WHEN** a PDF is encrypted, corrupt, malicious, or uses an unsupported feature
- **THEN** the system rejects publication with an actionable error and does not expose the object to signers

### Requirement: Immutable template versions
The system SHALL create an immutable template version for every published combination of PDF bytes, fields, roles, policies, and metadata.

#### Scenario: Published template is edited
- **WHEN** an authorized user changes a published template
- **THEN** the system creates a new draft version and preserves the prior published version unchanged

### Requirement: Visual field designer
The system SHALL render every PDF page and allow authorized users to drag, resize, align, duplicate, delete, and assign fields using normalized page-relative coordinates.

#### Scenario: Field is placed at different zoom levels
- **WHEN** a user places a field while the editor is zoomed and later previews at another size
- **THEN** the field remains aligned to the same PDF content location

### Requirement: Supported field schema
The system SHALL support signature, initials, date-signed, full-name, email, title/company, single-line text, multiline text, number, currency, address, phone, checkbox, radio, dropdown, attachment, and read-only merge fields.

#### Scenario: Required field is configured
- **WHEN** an editor marks a field required and assigns it to a recipient role
- **THEN** the published template records the validation rule and role ownership for envelope creation

### Requirement: Multi-document packet templates
The system SHALL allow a template version to contain ordered multiple PDFs with shared recipient roles and per-document retention classifications.

#### Scenario: HR packet spans multiple PDFs
- **WHEN** an HR editor publishes a packet containing an offer letter, NDA, and policy acknowledgement
- **THEN** the system preserves document order and validates all assigned fields as one envelope template

### Requirement: Template publication validation
The system SHALL prevent publication until role assignments, required fields, field bounds, jurisdiction metadata where applicable, form edition, effective date, and referenced policies are valid.

#### Scenario: Signature field has no role
- **WHEN** an editor attempts to publish a template with an unassigned signature field
- **THEN** the system blocks publication and identifies the page and field requiring correction

### Requirement: Template retirement
The system SHALL allow a published template version to be retired without affecting existing or historical envelopes.

#### Scenario: Retired form edition is selected
- **WHEN** a user attempts to create a new envelope from a retired version
- **THEN** the system blocks creation and directs the user to an active version while keeping historical packages readable
