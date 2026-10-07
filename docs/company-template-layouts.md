# Company templates and recipient-facing fields

Buyer, seller and commercial requests remove internal labels from read-only
fields, so native signing displays the actual prefilled value. Empty optional
read-only TEXT inputs are omitted from the new request. Approved non-empty
defaults, required inputs, editable customer disclosures and signature fields
remain. The four legacy seller Lead Paint prompts have English translations;
answers are never inferred. Company-file and HR compilation is unchanged.
The request title is used directly for client packages instead of appending a
bilingual staff template title. Published masters and existing requests are not
rewritten.

An administrator may include `layout: { recipients: [...] }` in the existing
company template upload payload. This creates a **new template** only. Each
recipient has `name`, `role` (SIGNER or APPROVER), and `fields`. Fields contain
the native file index, page, percentage geometry and typed metadata. Supported
types are TEXT, SIGNATURE, INITIALS and DATE. Signature content, recipient email,
native IDs, document state and callbacks cannot be supplied. The service assigns
non-deliverable placeholder emails and distinct sequential signing ranks.

The service checks actual PDF page counts, field bounds, signer signatures,
approval-only fields, file references and duplicate placements. It reads the
created template back and verifies ownership, recipients, geometry, metadata
and exact PDF hashes. A recipient-free draft verifies that native DOCUMENT
conversion preserves the bytes, then is deleted. No invitation is sent.
Successful replay uses the same template; changed layout or bytes under an
existing upload ID are rejected. An uncertain creation must be reconciled using
that same ID, never retried as a new upload.

The administrator template projection includes `layout` with all field geometry
and metadata, including signature/date fields. It never includes recipient
tokens. Approval/publication remains a separate operation with pinned template
fingerprints and PDF hashes. Optional consumer roles belong in the published
definition, not in the native template. A template with two consumers therefore
supports one or two consumers without mutating its master.
