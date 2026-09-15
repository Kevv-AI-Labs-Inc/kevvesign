# Independently approved documents and package composition

`POST /v1/packages` accepts `catalogKind: "document"` with `reviewed: true`.
Approval requires one native template containing exactly one PDF item. The
native field layout, roles and source bytes are fingerprinted as before. An
approved document may also be requested on its own for supplemental signing.

`POST /v1/packages/compose` is administrator-only and accepts:

```json
{
  "packageKey": "buyer-standard",
  "version": 1,
  "title": "Buyer package",
  "scenario": "buyer",
  "companyKey": "homix_realty",
  "applicableCompanyKeys": ["homix_realty", "homix_living"],
  "documentIds": ["approved-document-version-uuid"],
  "signingOrder": "SEQUENTIAL",
  "reviewed": true
}
```

The ordered IDs must resolve to active, independently approved versions in the
same client, scenario and source company. The selected company scope must be
supported by every document. PDF and field fingerprints are checked again;
shared role actors/optionality and shared prefill types/options must agree.
Company File cannot be included in buyer/seller/commercial packets.

The immutable package copies the approved definition and records component IDs,
keys, titles and versions. Request preparation compiles these into **one native
envelope containing separate PDF items**. Field file indices are remapped; roles
are unified by business key, never by email. An agent who approves one document
and signs another becomes one native SIGNER. Unsupported role combinations and
ambiguous identities are rejected. Sequential order follows first role appearance
in the administrator's ordered document list. Parallel mode clears native ranks.

Legacy package rows default to `catalog_kind=legacy` and retain existing creation
and send behavior; in-flight requests are not migrated. Onboarding is unchanged.
Stopping an approved version blocks new prepares and unsent drafts that reference
it, but does not alter pending signatures or completed originals. Native edits to
an approved source require another reviewed version.

`company_file` uses the same company ownership and owner-agent isolation as
customer packages, but allows exactly one owner role, SIGNER or APPROVER, and no
customer/company/optional roles. A signature-free Deal Sheet uses APPROVER;
Commission Report uses the agent signature while administrative payout fields
remain outside this workflow.

Projection includes required/completed editable field counts per PDF. These are
progress counts, not independent sealing status: native envelope completion is
required before any signed original can be downloaded. ZIP exports preserve each
sealed native PDF plus completion certificate, audit log, hashes and company,
owner, business reference, package version and component version metadata.

Verification (2026-09-15): 49 unit/contract tests; local official 2.18 signed an
exclusive four-PDF package with two buyers for Living and a non-exclusive package
with one buyer for Realty. Both produced four separate signed PDFs and audit ZIPs.
Company File approval and signature paths also completed. Portal HTTP tests check
canonical company identity and reject company spoofing/customer injection. All
native runs used synthetic addresses and watermarked PDFs; no real invitations.

Deal-entry attachment selection, company review of transaction materials and a
merged reading-only copy remain a subsequent Portal integration. Individual
native agent accounts and personal editing are not part of this release.
