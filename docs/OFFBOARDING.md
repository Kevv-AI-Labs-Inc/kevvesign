# Administrator-controlled offboarding

The `offboarding` scenario uses the existing private company connection. Only an administrator can prepare, review or command it. A published package has one document group and exactly two required SIGNER roles: `agent` (`customer`, the departing person) and `company` (the company representative). The owner is the preparing administrator, not the departing person. Recipients use native email signing without a Portal/native account.

Sending requires a current review hash, unchanged native draft and original PDF, plus an active package. Native changes enqueue the existing authenticated Portal outbox. Portal binds the request to an offboarding record and alone decides whether its validated completion revokes access. The bridge never changes Portal accounts.

Company-specific HR PDFs and import manifests are private deployment inputs, not public source assets. Validate a controlled `homix-documenso-import-v1` manifest using:

```sh
HOMIX_PACKAGE_MANIFEST=/path/to/private/manifest.json node --import tsx apps/bridge/src/cli/import-packages.ts
```

The command checks file hashes and field geometry without sending provider requests. In the controlled deployment/import environment, `--publish` imports and publishes the template; it does not send signing invitations. Complete synthetic acceptance with controlled recipients before using a new termination template for real people.

## Static PDF preflight

Termination masters must have no AcroForm dictionary, even when it contains no
widgets. Native 2.18 preserves that dictionary in TEMPLATE uploads and removes it
from DOCUMENT uploads, which otherwise triggers `HR_DRAFT_CHANGED` at send time.
The importer now checks a recipient-free DOCUMENT round trip before publishing a
new version and removes its synthetic draft. A changed hash stops publication;
it never disables the send-time byte check. Existing published versions remain
immutable. Correct the static master, verify all page text and rendered pixels
against the approved source, publish a new version, and reprepare any affected
unsigned request using its saved business details. Do not send automatically.
