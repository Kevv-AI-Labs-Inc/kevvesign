## ADDED Requirements

### Requirement: Single-email default access
The system SHALL allow a default external recipient to open and complete signing from one invitation email without account creation or a second email OTP.

#### Scenario: Recipient selects Review and Sign
- **WHEN** a recipient opens a valid invitation from the assigned mailbox
- **THEN** the signer portal opens the assigned envelope and proceeds to disclosure and review without sending another verification email

### Requirement: High-entropy scoped invitations
The system SHALL generate a cryptographically random invitation secret scoped to one envelope and recipient, store only a protected hash, and prevent its use for any other recipient or envelope.

#### Scenario: Token is used for another recipient
- **WHEN** an invitation secret is presented with a different recipient or envelope context
- **THEN** the system rejects access and records a security event without revealing the valid context

### Requirement: Scanner-safe invitation handling
The system SHALL keep invitation GET requests side-effect-free and SHALL require a browser session plus an explicit mutating request for consent, field updates, signature, decline, or finish.

#### Scenario: Mail scanner prefetches a link
- **WHEN** an automated mail scanner performs a GET on an invitation URL
- **THEN** the invitation remains usable and the system does not record consent, interaction, signature, or completion

### Requirement: Recipient session security
The system SHALL exchange a valid invitation for a bounded recipient session using Secure, HttpOnly, SameSite cookies and SHALL protect state-changing requests against CSRF.

#### Scenario: Session expires during signing
- **WHEN** a recipient attempts a mutation after the session expires
- **THEN** the system requires the valid invitation to resume and preserves previously committed progress

### Requirement: Invitation lifecycle
The system SHALL expire invitations with the envelope, revoke them on void or recipient replacement, and remove mutation authority after recipient or envelope completion.

#### Scenario: Recipient is replaced
- **WHEN** an authorized preparer replaces an incomplete recipient
- **THEN** every prior invitation and session for the old recipient is revoked before a new invitation is issued

### Requirement: Safe resend
The system SHALL allow authorized users to resend an invitation without creating duplicate recipients or changing the frozen envelope and SHALL optionally rotate the invitation secret.

#### Scenario: Invitation is resent
- **WHEN** a preparer requests resend for an active recipient
- **THEN** the system sends a new delivery, records it, and preserves recipient progress and routing state

### Requirement: Optional access-code authentication
The system SHALL allow an envelope or recipient to require a separately communicated access code and SHALL never include that code in the invitation email.

#### Scenario: Access code is required
- **WHEN** a recipient opens a valid invitation configured for access-code authentication
- **THEN** document contents and signing actions remain unavailable until the correct code is supplied within attempt limits

### Requirement: Accurate assurance reporting
The system SHALL record authentication as email-invitation possession, access code, or internal account as applicable and SHALL not describe email access as government identity verification.

#### Scenario: Email-only signer completes
- **WHEN** a recipient authenticated only through the invitation finishes signing
- **THEN** the completion certificate identifies the method as secure invitation sent to the recipient email

### Requirement: Shared email visibility
The system SHALL permit recipient-specific invitations to the same email address while warning the preparer that mailbox-level assurance cannot distinguish the natural persons.

#### Scenario: Two sellers share one email
- **WHEN** two signer recipients are assigned the same email address
- **THEN** the system creates distinct recipient links, displays a preparation warning, and records each recipient action separately
