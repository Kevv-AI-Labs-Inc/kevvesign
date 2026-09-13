# Recovering a Documenso signing task

Portal resumes the existing task and obtains the current native recipient URL after verifying the authenticated identity, ownership and routing turn. Closing the signer page and continuing from Portal does not create a second envelope. Native fields and signature progress remain controlled by Documenso.

Refresh or reconcile the same request on transient API/callback failures. Expired, rejected or cancelled tasks require the explicit action shown in the task; do not silently create or sign replacements. A company countersigner must use the configured, verified native identity. An administrator account alone does not confer that signing identity.

For native completion, preserve the original Documenso signed bytes, certificate and audit. Do not regenerate them in Portal. Recovery checks are documented in [SIGNING_OPERATIONS.md](SIGNING_OPERATIONS.md); actual close/reopen and completion evidence is in [QA](qa/2026-09-12-documenso-integration.md).

The retired implementation's session/token/draft APIs are [archived](archive/native-platform-2026-09-12/SIGNING_RECOVERY.md). They are not available in the new bridge.
