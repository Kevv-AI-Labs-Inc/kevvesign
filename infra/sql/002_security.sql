SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE ROLE esign_app_role;
GRANT SELECT, INSERT, UPDATE ON SCHEMA::esign TO esign_app_role;
DENY DELETE ON OBJECT::esign.audit_events TO esign_app_role;
DENY ALTER, CONTROL, TAKE OWNERSHIP ON SCHEMA::esign TO esign_app_role;

CREATE ROLE esign_auditor_role;
GRANT SELECT ON OBJECT::esign.audit_events TO esign_auditor_role;
GRANT SELECT ON OBJECT::esign.evidence_packages TO esign_auditor_role;

CREATE OR ALTER PROCEDURE esign.verify_envelope_audit
  @workspace_id uniqueidentifier,
  @envelope_id uniqueidentifier
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, event_type, occurred_at, previous_hash, event_hash
  FROM esign.audit_events
  WHERE workspace_id = @workspace_id AND envelope_id = @envelope_id
  ORDER BY occurred_at, id;
END;

COMMIT TRANSACTION;
