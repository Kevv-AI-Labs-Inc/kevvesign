# Company commercial packages

`commercial` is a company-owned standard package scenario, alongside `buyer` and
`seller`. It uses the same company allowlist, owner-agent access, immutable
template fingerprint, preview/review-before-send, replacement, and archive
controls. It does not enable personal accounts or custom PDF editing.

The Portal labels this category **商业及其他 / Commercial & other**. A company
administrator can publish a shared NDA master with owner and customer roles;
the initiating agent's actual company owns each generated document. Native
template ownership can remain with the explicitly approved source company.

The schema migration widens the two existing scenario CHECK constraints without
changing any requests, packages, or signed artifacts. Deploy the bridge before
publishing commercial templates or exposing the Portal category.

For existing PDF forms, remove empty AcroForm dictionaries as well as widgets
when producing a static company master. Native 2.18 preserves forms in templates
but flattens them in documents: an empty form can otherwise change the source PDF
hash during cloning. Keep strict PDF hash verification; do not bypass it.

Native integration validation can be run with `SIGNING_QA_SCENARIO=commercial`
or `SIGNING_QA_SCENARIO=seller` and
`node --import tsx apps/bridge/src/__tests__/shared-buyer.integration.ts`.
The script is restricted to the existing local synthetic services and identities.

Company templates should select a short date format such as `MM/dd/yyyy` and
use horizontal overflow for small date/initials fields. Inspect the **completed**
PDF: editor rectangles alone do not reveal wrapping introduced by native field
padding. No real customer signature is needed for this verification.
