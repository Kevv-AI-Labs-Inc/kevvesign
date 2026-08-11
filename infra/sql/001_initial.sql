SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF SCHEMA_ID('esign') IS NULL EXEC('CREATE SCHEMA esign');

CREATE TABLE dbo.platform_state (
  singleton_id tinyint NOT NULL CONSTRAINT PK_platform_state PRIMARY KEY CONSTRAINT CK_platform_state_singleton CHECK (singleton_id = 1),
  state_json nvarchar(max) NOT NULL CONSTRAINT CK_platform_state_json CHECK (ISJSON(state_json) = 1),
  updated_at datetime2(7) NOT NULL CONSTRAINT DF_platform_state_updated DEFAULT SYSUTCDATETIME(),
  row_version rowversion NOT NULL
);

CREATE TABLE esign.workspaces (
  id uniqueidentifier NOT NULL CONSTRAINT PK_workspaces PRIMARY KEY,
  slug varchar(80) NOT NULL CONSTRAINT UQ_workspaces_slug UNIQUE,
  display_name nvarchar(160) NOT NULL,
  status varchar(20) NOT NULL CONSTRAINT CK_workspaces_status CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at datetime2(7) NOT NULL CONSTRAINT DF_workspaces_created DEFAULT SYSUTCDATETIME()
);

CREATE TABLE esign.workspace_members (
  id uniqueidentifier NOT NULL CONSTRAINT PK_workspace_members PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  entra_object_id uniqueidentifier NULL,
  email nvarchar(254) NOT NULL,
  display_name nvarchar(160) NOT NULL,
  role varchar(30) NOT NULL CONSTRAINT CK_workspace_members_role CHECK (role IN ('platform_admin','workspace_admin','preparer','approver','auditor')),
  status varchar(20) NOT NULL CONSTRAINT CK_workspace_members_status CHECK (status IN ('ACTIVE','SUSPENDED')),
  CONSTRAINT FK_workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT UQ_workspace_members_email UNIQUE (workspace_id, email)
);

CREATE TABLE esign.application_clients (
  id uniqueidentifier NOT NULL CONSTRAINT PK_application_clients PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  display_name nvarchar(120) NOT NULL,
  secret_hash char(64) NOT NULL,
  scopes_json nvarchar(max) NOT NULL CONSTRAINT CK_application_clients_scopes CHECK (ISJSON(scopes_json) = 1),
  allowed_return_urls_json nvarchar(max) NOT NULL CONSTRAINT CK_application_clients_return_urls CHECK (ISJSON(allowed_return_urls_json) = 1),
  status varchar(20) NOT NULL CONSTRAINT CK_application_clients_status CHECK (status IN ('ACTIVE','REVOKED')),
  created_at datetime2(7) NOT NULL,
  expires_at datetime2(7) NULL,
  rotated_at datetime2(7) NULL,
  CONSTRAINT FK_application_clients_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  INDEX IX_application_clients_workspace (workspace_id, status)
);

CREATE TABLE esign.templates (
  id uniqueidentifier NOT NULL CONSTRAINT PK_templates PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  display_name nvarchar(180) NOT NULL,
  active_version_id uniqueidentifier NULL,
  created_at datetime2(7) NOT NULL,
  updated_at datetime2(7) NOT NULL,
  CONSTRAINT FK_templates_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  INDEX IX_templates_workspace (workspace_id, updated_at DESC)
);

CREATE TABLE esign.template_versions (
  id uniqueidentifier NOT NULL CONSTRAINT PK_template_versions PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  template_id uniqueidentifier NOT NULL,
  version_number int NOT NULL,
  status varchar(20) NOT NULL CONSTRAINT CK_template_versions_status CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  jurisdiction char(4) NOT NULL CONSTRAINT CK_template_versions_jurisdiction CHECK (jurisdiction IN ('NY','NJ','CA','NONE')),
  business_domain varchar(20) NOT NULL CONSTRAINT CK_template_versions_domain CHECK (business_domain IN ('REAL_ESTATE','HR')),
  schema_hash char(64) NULL,
  metadata_json nvarchar(max) NOT NULL CONSTRAINT CK_template_versions_metadata CHECK (ISJSON(metadata_json) = 1),
  created_at datetime2(7) NOT NULL,
  published_at datetime2(7) NULL,
  retired_at datetime2(7) NULL,
  CONSTRAINT FK_template_versions_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_template_versions_template FOREIGN KEY (template_id) REFERENCES esign.templates(id),
  CONSTRAINT UQ_template_versions_number UNIQUE (template_id, version_number),
  CONSTRAINT UQ_template_versions_schema UNIQUE (workspace_id, schema_hash)
);

CREATE TABLE esign.envelopes (
  id uniqueidentifier NOT NULL CONSTRAINT PK_envelopes PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  transaction_id uniqueidentifier NULL,
  template_version_id uniqueidentifier NOT NULL,
  external_reference nvarchar(120) NULL,
  subject nvarchar(180) NOT NULL,
  status varchar(30) NOT NULL,
  jurisdiction char(4) NOT NULL,
  expires_at datetime2(7) NOT NULL,
  created_at datetime2(7) NOT NULL,
  updated_at datetime2(7) NOT NULL,
  concurrency_version bigint NOT NULL CONSTRAINT DF_envelopes_version DEFAULT 1,
  envelope_json nvarchar(max) NOT NULL CONSTRAINT CK_envelopes_json CHECK (ISJSON(envelope_json) = 1),
  CONSTRAINT FK_envelopes_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_envelopes_template_version FOREIGN KEY (template_version_id) REFERENCES esign.template_versions(id),
  CONSTRAINT UQ_envelopes_external_ref UNIQUE (workspace_id, external_reference),
  INDEX IX_envelopes_workspace_status (workspace_id, status, updated_at DESC)
);

CREATE TABLE esign.recipient_sessions (
  id uniqueidentifier NOT NULL CONSTRAINT PK_recipient_sessions PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  envelope_id uniqueidentifier NOT NULL,
  recipient_id uniqueidentifier NOT NULL,
  session_hash char(64) NOT NULL CONSTRAINT UQ_recipient_sessions_hash UNIQUE,
  csrf_hash char(64) NOT NULL,
  created_at datetime2(7) NOT NULL,
  expires_at datetime2(7) NOT NULL,
  revoked_at datetime2(7) NULL,
  CONSTRAINT FK_recipient_sessions_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_recipient_sessions_envelope FOREIGN KEY (envelope_id) REFERENCES esign.envelopes(id),
  INDEX IX_recipient_sessions_envelope (workspace_id, envelope_id, recipient_id)
);

CREATE TABLE esign.integration_launch_sessions (
  id uniqueidentifier NOT NULL CONSTRAINT PK_integration_launch_sessions PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  application_client_id uniqueidentifier NOT NULL,
  ticket_hash char(64) NOT NULL CONSTRAINT UQ_integration_launch_ticket_hash UNIQUE,
  actor_subject nvarchar(120) NOT NULL,
  actor_json nvarchar(max) NOT NULL CONSTRAINT CK_integration_launch_actor CHECK (ISJSON(actor_json) = 1),
  intent_json nvarchar(max) NOT NULL CONSTRAINT CK_integration_launch_intent CHECK (ISJSON(intent_json) = 1),
  return_url nvarchar(500) NOT NULL,
  created_at datetime2(7) NOT NULL,
  expires_at datetime2(7) NOT NULL,
  used_at datetime2(7) NULL,
  CONSTRAINT FK_integration_launch_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_integration_launch_client FOREIGN KEY (application_client_id) REFERENCES esign.application_clients(id),
  INDEX IX_integration_launch_expiry (workspace_id, expires_at)
);

CREATE TABLE esign.staff_sessions (
  id uniqueidentifier NOT NULL CONSTRAINT PK_staff_sessions PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  application_client_id uniqueidentifier NOT NULL,
  actor_subject nvarchar(120) NOT NULL,
  session_hash char(64) NOT NULL CONSTRAINT UQ_staff_session_hash UNIQUE,
  csrf_hash char(64) NOT NULL,
  context_json nvarchar(max) NOT NULL CONSTRAINT CK_staff_session_context CHECK (ISJSON(context_json) = 1),
  created_at datetime2(7) NOT NULL,
  expires_at datetime2(7) NOT NULL,
  revoked_at datetime2(7) NULL,
  CONSTRAINT FK_staff_session_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_staff_session_client FOREIGN KEY (application_client_id) REFERENCES esign.application_clients(id),
  INDEX IX_staff_session_actor (workspace_id, actor_subject, expires_at)
);

CREATE TABLE esign.idempotency_keys (
  workspace_id uniqueidentifier NOT NULL,
  operation varchar(80) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash char(64) NOT NULL,
  response_json nvarchar(max) NOT NULL CONSTRAINT CK_idempotency_response_json CHECK (ISJSON(response_json) = 1),
  created_at datetime2(7) NOT NULL,
  expires_at datetime2(7) NOT NULL,
  CONSTRAINT PK_idempotency_keys PRIMARY KEY (workspace_id, operation, idempotency_key),
  CONSTRAINT FK_idempotency_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id)
);

CREATE TABLE esign.audit_events (
  id uniqueidentifier NOT NULL,
  workspace_id uniqueidentifier NOT NULL,
  envelope_id uniqueidentifier NULL,
  actor_type varchar(20) NOT NULL,
  actor_id nvarchar(120) NOT NULL,
  source_application_client_id uniqueidentifier NULL,
  event_type varchar(100) NOT NULL,
  occurred_at datetime2(7) NOT NULL,
  payload_json nvarchar(max) NOT NULL CONSTRAINT CK_audit_events_json CHECK (ISJSON(payload_json) = 1),
  previous_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  CONSTRAINT PK_audit_events PRIMARY KEY (workspace_id, id),
  INDEX IX_audit_events_envelope (workspace_id, envelope_id, occurred_at, id)
) WITH (LEDGER = ON (APPEND_ONLY = ON));

CREATE TABLE esign.evidence_packages (
  id uniqueidentifier NOT NULL CONSTRAINT PK_evidence_packages PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  envelope_id uniqueidentifier NOT NULL CONSTRAINT UQ_evidence_packages_envelope UNIQUE,
  manifest_object_key nvarchar(500) NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  signature varbinary(max) NOT NULL,
  signing_key_id nvarchar(500) NOT NULL,
  retention_until datetime2(7) NOT NULL,
  legal_hold bit NOT NULL CONSTRAINT DF_evidence_legal_hold DEFAULT 0,
  verification_status varchar(20) NOT NULL,
  created_at datetime2(7) NOT NULL,
  CONSTRAINT FK_evidence_workspace FOREIGN KEY (workspace_id) REFERENCES esign.workspaces(id),
  CONSTRAINT FK_evidence_envelope FOREIGN KEY (envelope_id) REFERENCES esign.envelopes(id)
);

CREATE TABLE esign.webhook_deliveries (
  id uniqueidentifier NOT NULL CONSTRAINT PK_webhook_deliveries PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  event_id uniqueidentifier NOT NULL,
  subscription_id uniqueidentifier NOT NULL,
  attempt_count int NOT NULL CONSTRAINT DF_webhook_attempt DEFAULT 0,
  next_attempt_at datetime2(7) NULL,
  status varchar(20) NOT NULL,
  last_status_code int NULL,
  created_at datetime2(7) NOT NULL,
  CONSTRAINT UQ_webhook_delivery UNIQUE (subscription_id, event_id),
  INDEX IX_webhook_delivery_due (status, next_attempt_at)
);

CREATE TABLE esign.email_deliveries (
  id uniqueidentifier NOT NULL CONSTRAINT PK_email_deliveries PRIMARY KEY,
  workspace_id uniqueidentifier NOT NULL,
  envelope_id uniqueidentifier NOT NULL,
  recipient_id uniqueidentifier NOT NULL,
  provider_message_id nvarchar(200) NOT NULL,
  delivery_type varchar(30) NOT NULL,
  status varchar(20) NOT NULL,
  created_at datetime2(7) NOT NULL,
  INDEX IX_email_envelope (workspace_id, envelope_id, created_at)
);

INSERT dbo.platform_state (singleton_id, state_json)
VALUES (1, N'{"workspaces":[],"applicationClients":[],"templates":[],"transactions":[],"envelopes":[],"recipientSessions":[],"integrationLaunchSessions":[],"staffSessions":[],"auditEvents":[],"evidencePackages":[],"emailDeliveries":[],"webhookSubscriptions":[],"idempotency":{}}');

COMMIT TRANSACTION;
