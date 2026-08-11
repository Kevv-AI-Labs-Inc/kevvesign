## 1. Product, Legal, and Ownership Gates

- [x] 1.1 Record the approved v1 scope, non-goals, and Azure decision in the repository ADR index
- [ ] 1.2 Assign named product, technical, security/privacy, operations, HR-policy, and broker/counsel owners
- [ ] 1.3 Obtain broker/counsel review of NY, NJ, and CA electronic-signature disclosures and workflow assumptions
- [ ] 1.4 Approve the seven-year default real-estate retention policy and the legal-hold authority matrix
- [ ] 1.5 Define the initial ordinary HR document list and an owner and retention class for each document
- [x] 1.6 Confirm that I-9, W-4, notarization, KBA, government ID, and public SaaS remain blocked in v1
- [ ] 1.7 Select the pilot workspace, one low-risk real-estate template per state, and one ordinary HR packet
- [ ] 1.8 Select the production brand, hostname, email sending domain, sender display name, and support contact

## 2. Repository and Developer Foundation

- [x] 2.1 Initialize a pnpm TypeScript monorepo with apps, packages, infrastructure, scripts, and documentation directories
- [x] 2.2 Add shared TypeScript, lint, format, test, and build configurations with pinned runtime versions
- [x] 2.3 Create deployable web, API, Durable Functions, and PDF finalizer application skeletons
- [x] 2.4 Create shared packages for domain types, validation schemas, API contracts, events, authorization, and test fixtures
- [ ] 2.5 Configure unit, integration, contract, browser, accessibility, and infrastructure test commands
- [x] 2.6 Configure CI for install, format check, lint, type check, unit tests, build, dependency audit, and artifact publication
- [ ] 2.7 Add secret scanning, SAST, dependency review, container scanning, and IaC policy checks to CI
- [x] 2.8 Add local emulators or documented development substitutes for database, Blob, queue, email, and identity dependencies
- [x] 2.9 Add architecture decision, threat-model, data-classification, retention, and runbook documentation templates

## 3. Azure Infrastructure Foundation

- [ ] 3.1 Choose the primary US Azure region and document service availability, latency, cost, and residency assumptions
- [ ] 3.2 Define isolated development, staging, and production subscriptions or resource-group boundaries
- [ ] 3.3 Implement infrastructure as code for resource groups, networks, identities, tags, budgets, and diagnostic settings
- [ ] 3.4 Provision Container Apps environment and separately deployable web/API and PDF job identities
- [ ] 3.5 Provision Azure Functions/Durable Functions storage and managed identity with least-privilege access
- [ ] 3.6 Provision Azure SQL Database with network restrictions, encryption, backup policy, and ledger support
- [ ] 3.7 Provision private Blob storage for quarantine, drafts, templates, in-progress, completed, evidence, and recovery data
- [ ] 3.8 Configure Blob versioning, soft delete where compatible, lifecycle rules, and non-production immutability test policies
- [ ] 3.9 Provision Service Bus queues, retry policy, dead-letter queues, and managed-identity authorization
- [ ] 3.10 Provision Key Vault, RBAC, purge protection, key rotation settings, and manifest-signing key
- [ ] 3.11 Provision Communication Services Email and verify custom-domain SPF, DKIM, return path, and sender identity
- [ ] 3.12 Provision the selected standalone administrator identity provider, redirect URIs, membership policy, and separate environment credentials
- [ ] 3.13 Configure Application Insights, Log Analytics, alert groups, safe retention, and budget alerts
- [ ] 3.14 Validate that staging identities cannot access production SQL, Blob, Key Vault, Service Bus, or email resources

## 4. Database and Persistence Model

- [x] 4.1 Implement migrations for workspaces, members, roles, and application clients with workspace-scoped indexes
- [ ] 4.2 Implement migrations for templates, versions, documents, recipient roles, fields, and policy references
- [ ] 4.3 Implement migrations for transactions, envelopes, documents, recipients, routing groups, and concurrency tokens
- [ ] 4.4 Implement migrations for recipient sessions, consents, signature adoptions, field values, and attachments
- [ ] 4.5 Implement migrations for retention policies, evidence packages, legal holds, and protected object references
- [ ] 4.6 Implement migrations for email deliveries, webhook subscriptions, webhook events, attempts, and dead letters
- [x] 4.7 Implement append-only ledger tables for audit events and other evidence-critical history
- [x] 4.8 Implement canonical audit-event serialization and previous-event hash calculation
- [ ] 4.9 Implement repository interfaces that require workspace context for all business-data queries
- [ ] 4.10 Add database constraints for unique external references, idempotency keys, routing order, and immutable published versions
- [ ] 4.11 Add migration tests covering clean deployment, forward upgrade, previous-application compatibility, and rollback-safe failure
- [x] 4.12 Seed synthetic development workspaces, users, policies, templates, and envelopes without production forms or PII

## 5. Staff Identity and Authorization

- [ ] 5.1 Implement the selected standalone administrator OIDC login, logout, token validation, and secure session handling
- [x] 5.2 Implement workspace membership resolution independent of broad Entra tenant membership
- [x] 5.3 Implement deny-by-default permissions for platform admin, workspace admin, preparer, approver, and auditor
- [ ] 5.4 Enforce workspace scoping at API command, query, repository, Blob object, and download-grant boundaries
- [x] 5.5 Implement application-client credential issue, hash/protect, scope, rotate, expire, and revoke operations
- [ ] 5.6 Implement bounded privileged support mode with reason, expiration, visible indicator, and audit events
- [ ] 5.7 Implement member suspend/remove and active-session revocation
- [ ] 5.8 Add automated cross-workspace isolation and privilege-escalation tests for every protected resource type
- [x] 5.9 Implement Portal-scoped application registration with exact HTTPS return URLs
- [x] 5.10 Implement five-minute one-time Portal launch tickets carried in URL fragments
- [x] 5.11 Implement HttpOnly delegated staff sessions, CSRF checks, role-and-scope intersection, and immediate client-revocation enforcement
- [x] 5.12 Implement Portal launch/return UI and intent routing for dashboard, envelope preparation/view, and template editing
- [x] 5.13 Add integration tests for return-URL rejection, one-time exchange, CSRF, dual audit attribution, logout, and revocation

## 6. Upload, PDF Normalization, and Template Storage

- [ ] 6.1 Implement streaming upload with per-workspace size, count, and rate limits
- [ ] 6.2 Implement MIME detection, PDF signature validation, encryption detection, parser limits, and quarantine storage
- [ ] 6.3 Integrate malware scanning and prevent quarantined objects from template or signer access
- [ ] 6.4 Implement PDF metadata extraction for pages, dimensions, crop boxes, rotation, AcroForm/XFA indicators, and hashes
- [x] 6.5 Build a compatibility classifier that accepts supported PDFs and returns actionable reasons for rejection
- [x] 6.6 Implement private template-object keys and authorized previews without public Blob access
- [x] 6.7 Implement required form source, license owner, edition, effective date, jurisdiction, and approval metadata
- [ ] 6.8 Create a synthetic PDF compatibility corpus covering rotation, crop boxes, form fields, fonts, large pages, and malformed files

## 7. Template and Packet Authoring

- [ ] 7.1 Build template list, create, draft, publish, clone, compare-version, retire, and historical-view screens
- [ ] 7.2 Implement PDF.js page rendering with page virtualization, zoom, rotation awareness, and responsive layout
- [ ] 7.3 Implement drag, resize, delete, duplicate, multi-select, align, distribute, and snap interactions
- [x] 7.4 Store and restore fields using normalized PDF coordinates independent of browser zoom
- [ ] 7.5 Implement signature, initials, signed-date, name, email, title/company, text, number, currency, address, and phone fields
- [ ] 7.6 Implement checkbox, radio, dropdown, attachment, and read-only merge fields
- [ ] 7.7 Implement field properties for recipient role, required state, validation, default/merge key, visibility, and tab order
- [x] 7.8 Implement reusable recipient roles, routing defaults, and organization countersigner roles
- [ ] 7.9 Implement copy-to-page, copy-to-selected-pages, and initials-on-all-pages actions
- [ ] 7.10 Implement multi-document packet ordering, per-document metadata, and per-document retention classification
- [ ] 7.11 Implement role-specific preview and publish validation with page-and-field error navigation
- [x] 7.12 Implement immutable publication that creates a new version and preserves prior versions
- [ ] 7.13 Add browser tests for coordinate fidelity across zoom, device pixel ratio, rotation, resize, and mobile viewport

## 8. Envelope Domain Engine and Staff Preparation

- [x] 8.1 Implement the guarded envelope state machine and optimistic concurrency checks
- [x] 8.2 Implement envelope creation from a published template with copied immutable source and schema hashes
- [ ] 8.3 Implement recipient creation, routing groups, signer/approver/countersigner/view/copy roles, and duplicate-email warning
- [x] 8.4 Implement merge-data validation and staff prefill without allowing staff to create external-recipient signatures
- [ ] 8.5 Build the preparation UI for documents, recipient roles, routing, deadlines, authentication, reminders, and messages
- [ ] 8.6 Implement envelope validation and a send-preview summary of documents, parties, fields, policies, and deadlines
- [ ] 8.7 Implement optional approval-pending flow and approver accept/reject-with-comment operations
- [x] 8.8 Implement idempotent send that freezes the envelope and starts routing exactly once
- [ ] 8.9 Implement recipient replacement, resend, correction/supersede, void with reason, and expiration commands
- [ ] 8.10 Implement decline policy and recipient decline with allowed/required reason behavior
- [ ] 8.11 Add transition-table tests covering allowed, forbidden, stale, duplicate, and concurrent commands

## 9. Recipient Invitation and Signing Ceremony

- [x] 9.1 Implement cryptographically random recipient invitation generation with protected hashes and explicit lifecycle state
- [x] 9.2 Implement scanner-safe, side-effect-free invitation GET handling and credential-bearing URL log redaction
- [x] 9.3 Implement invitation-to-session exchange with Secure, HttpOnly, SameSite cookies and bounded expiry
- [ ] 9.4 Implement CSRF protection, safe return URLs, strict CORS/CSP, frame blocking, and recipient rate limits
- [ ] 9.5 Build mobile-first document review with page navigation, download option, and active-recipient field highlighting
- [x] 9.6 Implement versioned electronic-record disclosure, paper/withdrawal information, and explicit consent capture
- [x] 9.7 Implement typed and drawn signature/initial adoption with clear intent wording and accessible keyboard alternatives
- [ ] 9.8 Implement recipient text, selection, attachment, date, signature, and initials field entry and validation
- [ ] 9.9 Implement autosave, conflict handling, session expiry recovery, and resume from the same invitation
- [x] 9.10 Implement explicit Finish, recipient completion freeze, and activation of the next routing group
- [x] 9.11 Implement optional separately communicated access-code authentication with protected storage and attempt limits
- [ ] 9.12 Implement completed, declined, voided, expired, and unavailable recipient screens without information leakage
- [x] 9.13 Add tests proving mail-scanner GETs cannot consume invitations or create view, consent, signature, or finish events
- [ ] 9.14 Add mobile browser, screen reader, keyboard, shared-email, forwarded-link, and session-resume journey tests

## 10. Durable Workflows and Email Delivery

- [x] 10.1 Define versioned orchestration and queue message contracts with deterministic instance and command IDs
- [x] 10.2 Implement envelope routing orchestration that waits for approval and recipient-completion events
- [ ] 10.3 Implement deadline and expiration timers using recorded UTC instants and timezone-aware display metadata
- [ ] 10.4 Implement reminder schedules that suppress delivery for completed or inactive recipients
- [ ] 10.5 Implement invitation, reminder, decline, void, expiration, correction, and completion email templates
- [ ] 10.6 Implement custom-domain email sending and persist provider message IDs, status, bounce, and failure events
- [x] 10.7 Implement retry-safe email commands that do not duplicate recipients or business transitions
- [ ] 10.8 Implement a safe operator resend flow and an email-provider outage/dead-letter recovery path
- [ ] 10.9 Add orchestration replay, duplicate-event, timeout, restart, and provider-failure tests

## 11. PDF Finalization and Evidence

- [ ] 11.1 Define the immutable finalization command and deterministic temporary/final object-key conventions
- [ ] 11.2 Build the PDF finalizer container image with pinned PDF libraries and reproducible font assets
- [x] 11.3 Implement source hash verification and reject any mismatch from the frozen envelope
- [x] 11.4 Implement rendering and flattening for every supported field and signature/initial appearance
- [ ] 11.5 Generate the completion certificate with parties, routing, assurance methods, event times, IP/user-agent, and file hashes
- [x] 11.6 Generate canonical manifest JSON and audit JSONL while excluding unnecessary sensitive field values
- [x] 11.7 Implement Key Vault manifest signing with algorithm and key-version metadata
- [ ] 11.8 Validate completed PDF readability, page count, expected field appearances, and output hashes before commit
- [ ] 11.9 Commit completed PDF, certificate, manifest, and audit export atomically at the application level
- [ ] 11.10 Apply approved time-based Blob immutability only after successful evidence verification
- [ ] 11.11 Implement legal-hold placement/release and prevent it from shortening active time retention
- [ ] 11.12 Implement failed-finalization state, deterministic retry, alerting, and operator recovery
- [ ] 11.13 Implement package verification for hashes, manifest signature, audit chain, ledger digest, object completeness, and retention state
- [ ] 11.14 Add golden-file and fuzz tests for PDF finalization, retry idempotency, and evidence verification

## 12. Real-Estate Capability Packs

- [ ] 12.1 Implement versioned NY, NJ, and CA jurisdiction-pack configuration and enablement gates
- [ ] 12.2 Implement property transaction folders and offer/listing/counteroffer/amendment/disclosure envelope types
- [ ] 12.3 Implement buyer, seller, spouse/co-owner, entity signatory, agent, broker, attorney/viewer, and copy-role presets
- [ ] 12.4 Implement property, brokerage, agent, deadline, and external-reference merge fields
- [ ] 12.5 Implement workspace/template broker-approval defaults and explicit override authorization
- [ ] 12.6 Implement offer, irrevocable, and envelope deadline capture and clear timezone display
- [ ] 12.7 Implement linked counteroffer, amendment, correction, and supersession history without original mutation
- [x] 12.8 Implement form license/edition retirement checks and prevent new use of unapproved editions
- [x] 12.9 Configure and test the approved seven-year default retention mapping
- [ ] 12.10 Configure one reviewed licensed pilot template for each state using non-production copies and synthetic data
- [ ] 12.11 Run broker/counsel acceptance scenarios for send, approval, multiple parties, initials, deadline, decline, completion copy, and audit export

## 13. HR Onboarding Capability

- [ ] 13.1 Implement HR packet presets with employee, HR preparer, employer countersigner, approver, and copy roles
- [ ] 13.2 Implement approved employee merge fields and prevent sensitive values from generic audit payloads and telemetry
- [x] 13.3 Implement per-document HR retention selection and validation before template publication
- [ ] 13.4 Implement UI and API guards preventing specialized I-9, W-4, tax, medical, benefits, or ID workflows from being marked supported
- [ ] 13.5 Implement masked sensitive input and role-restricted retrieval for any approved sensitive field types
- [ ] 13.6 Default sensitive HR completion delivery to secure links without PDF attachments
- [ ] 13.7 Configure one approved pilot packet with an offer letter, NDA, and policy acknowledgement using synthetic data
- [ ] 13.8 Run HR acceptance scenarios for prefill, employee completion, countersignature, correction, retention, and secure delivery

## 14. REST API and Webhooks

- [ ] 14.1 Define and publish OpenAPI contracts for `/v1` workspaces, transactions, templates, envelopes, documents, evidence, clients, and webhooks
- [ ] 14.2 Implement consistent validation errors, safe details, request IDs, correlation IDs, and cursor pagination
- [ ] 14.3 Implement idempotency storage and conflict behavior for create, send, void, resend, and replay-prone commands
- [ ] 14.4 Implement external references with workspace uniqueness and query support
- [x] 14.5 Implement scoped transaction/envelope creation, status, recipient, send, void, document, and evidence endpoints
- [ ] 14.6 Implement bounded authorized download grants without public Blob credentials
- [x] 14.7 Define versioned webhook event schemas for envelope, recipient, email, evidence, and failure events
- [ ] 14.8 Implement webhook subscription create, rotate-secret, pause, resume, test, and revoke operations
- [ ] 14.9 Implement timestamp-plus-raw-body HMAC signing, event IDs, delivery IDs, and replay-protection documentation
- [ ] 14.10 Implement persisted webhook delivery, bounded exponential retry, terminal dead-letter, and controlled replay
- [ ] 14.11 Build a reference consumer that verifies signatures, enforces timestamp tolerance, and deduplicates event IDs
- [ ] 14.12 Add API schema compatibility, authentication scope, idempotency, rate-limit, and webhook contract tests

## 15. Security and Privacy Hardening

- [x] 15.1 Complete a data-flow diagram, data classification, trust-boundary review, and abuse-case threat model
- [ ] 15.2 Implement automated tests proving secrets, invitation URLs, document content, signatures, and sensitive field values never enter logs
- [ ] 15.3 Implement security headers, CSP reporting, safe error pages, request/body limits, and anti-automation controls
- [ ] 15.4 Test workspace isolation, IDOR, CSRF, XSS, injection, open redirect, path traversal, upload parser, and webhook SSRF defenses
- [x] 15.5 Disable arbitrary server-side URL imports and restrict configured webhook destinations against private-network SSRF
- [ ] 15.6 Review managed-identity and RBAC assignments against documented least-privilege matrices
- [ ] 15.7 Implement key and credential rotation tests for Key Vault keys, application clients, webhook secrets, and email credentials
- [ ] 15.8 Implement auditable data export, draft cleanup, retention expiry, and legal-hold exception jobs
- [ ] 15.9 Conduct independent security review and resolve all release-blocking findings
- [ ] 15.10 Conduct privacy review for IP/user-agent collection, HR data, email tracking, retention, support access, and completion delivery

## 16. Quality, Accessibility, and Performance Verification

- [ ] 16.1 Create a requirements-to-tests matrix covering every OpenSpec scenario
- [ ] 16.2 Build deterministic clocks, email fakes, Blob fixtures, queue fakes, and identity fixtures for repeatable tests
- [ ] 16.3 Add end-to-end tests for one-email signing, sequential/parallel routing, approval, decline, void, expiration, resume, and completion
- [ ] 16.4 Add end-to-end tests for real-estate transaction chains and HR packet countersigning
- [ ] 16.5 Test current supported desktop and mobile versions of Chrome, Safari, Firefox, and Edge
- [ ] 16.6 Meet WCAG 2.2 AA for staff and signer critical paths and validate with automated and manual screen-reader tests
- [ ] 16.7 Load test invitation open, field save, send, queue processing, webhook delivery, and evidence retrieval at pilot and projected scale
- [ ] 16.8 Measure and set service objectives for API latency, signer page load, PDF finalization, email send, and workflow completion
- [ ] 16.9 Test concurrent signers, duplicate commands, delayed events, queue redelivery, database failover, and partial Azure outages
- [ ] 16.10 Complete a full staging restore and verify sampled ledger digests and evidence packages

## 17. Operations, Pilot, and General Availability

- [ ] 17.1 Implement dashboards and alerts for API, auth, email, queues, workflows, PDF jobs, webhooks, SQL, Blob, Key Vault, and ledger verification
- [ ] 17.2 Write and exercise runbooks for recipient replacement, resend, void, correction, finalization recovery, and webhook replay
- [ ] 17.3 Write and exercise runbooks for email outage, key rotation, legal hold, evidence export, restore, integrity mismatch, and security incident
- [ ] 17.4 Configure backup schedules, restore cadence, RPO/RTO measurement, and evidence-integrity verification schedule
- [ ] 17.5 Configure production budgets, quota alerts, scale limits, queue limits, email sending limits, and denial-of-wallet protections
- [ ] 17.6 Establish on-call ownership, severity definitions, support intake, incident communication, and audit-request procedures
- [ ] 17.7 Deploy staging, complete technical/security/privacy/broker/HR release gates, and record approvals
- [ ] 17.8 Deploy production infrastructure and application with no customer data, verify domains, identities, keys, policies, alerts, and rollback
- [ ] 17.9 Run a synthetic production smoke test through invitation, signing, finalization, immutable evidence, delivery, and webhook
- [ ] 17.10 Pilot with the selected internal users and low-risk documents under enhanced monitoring and support
- [ ] 17.11 Review pilot completion rate, email bounces, support issues, PDF failures, security events, cost, and operator workload
- [ ] 17.12 Resolve pilot release blockers and obtain written product, technical, security/privacy, broker/counsel, and HR approval
- [ ] 17.13 Enable additional licensed forms and source applications in controlled batches with rollback criteria
- [ ] 17.14 Publish the supported-scope, known-limitations, retention, assurance-level, and operator documentation for general availability
