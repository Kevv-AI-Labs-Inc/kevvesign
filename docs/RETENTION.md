# Data preservation and retention scope

This integration retains existing business SQL records and historical file storage. Retiring the custom signing runtime does not delete those records. New electronic originals, signed files and audit records are owned by Documenso; Portal keeps independent paper verification and business facts.

No new automatic document deletion or legal-hold engine was implemented in this integration. The old native retention matrix is [historical documentation](archive/native-platform-2026-09-12/RETENTION.md), not an assertion that Documenso enforces those periods or WORM controls.

The current PostgreSQL service has a 14-day backup window. That is backup configuration, not a contract retention policy. Document retention, export/restore and organizational hold requirements must be configured and operated explicitly if adopted. See [deployment](DEPLOYMENT.md) for retained resources and [operations](SIGNING_OPERATIONS.md) for protected file access.
