# Company document notifications

Daily buyer, seller, commercial and company-file requests use the shared company
account for ownership, but send business progress notifications to the initiating
agent already bound as a signer or approver. Client invitations and receipts stay
unchanged. Onboarding, team-leader and offboarding requests retain the original
company notification behavior. The separate personal Documenso deployment is not
changed.

This overlay is pinned to official Documenso 2.18.0 commit
`389390c884949fe27c240488a3259da3cdba93e0`. It adds two optional values to the
existing JSON email settings; it does not add a database migration or change
ownership, permissions, document contents, signature fields or recipients.

- `ownerNotificationRecipient`: the verified initiating agent's bound email.
- `ownerNotificationUrl`: the request's authenticated Portal detail page.

Four upstream handlers use this target: recipient signed, completed, rejected and
recipient expired. Completion is de-duplicated against the agent's normal receipt.
The native helper queries the complete recipient list even when a handler only
loaded the event recipient. An explicit target that is missing, ambiguous, or not
a signer/approver fails closed. It never falls back to the administrator or sends
to an arbitrary email. Existing unrouted documents preserve upstream behavior.

## Verification

```sh
pnpm verify
# Use a separate, clean clone of the pinned upstream commit:
node apps/company-documenso/prepare.mjs /absolute/path/to/pinned-source
node apps/company-documenso/verify-handlers.mjs /absolute/path/to/pinned-source
node apps/company-documenso/build-image.mjs company-documenso:2.18.0-notifications
```

The handler check runs the actual patched upstream source with fake DB/SMTP
adapters. It checks agent/client delivery, unchanged company/HR delivery,
completion de-duplication, Portal return links and fail-closed routing. It sends
no email. CI also runs it. The Docker build checks the full upstream application,
including its TypeScript surface, for the production `linux/amd64` architecture.
The build packages the full corresponding source and exposes a source-download
link in the native UI. All build output stays outside this repository.

## Authorized rollout

1. Record current company native and bridge image digests/revisions and retain
   them. Use the existing company app configuration; do not modify personal
   signing, domains, secrets, recipients or global email preferences.
2. Build and deploy the **company native image first**. It accepts the new optional
   settings while preserving all old documents. Confirm its health and public
   source download. This is the prerequisite for the bridge change.
3. Deploy the bridge. New ordinary company requests include the agent target in
   their prepared metadata. Existing provider readback validation must see those
   settings before sending; do not weaken it for an unpatched engine.
4. Deploy the Portal action emphasis independently. Its buttons use the existing
   server-authorized `canSign` projection and signer-access endpoint.
5. Observe legitimate activity and mail-job errors. Do not generate real signing
   invitations or customer mail as a smoke test.

The routing change applies to requests **prepared after the bridge rollout**.
Existing pending requests are intentionally not rewritten by startup or reads.
Their notification metadata must be reviewed and migrated separately, with an
explicit affected-document inventory and private before/after export. Completed
and signed documents must not be recreated to change notification preferences.

## Rollback

The Portal UI can roll back independently. Revert the bridge first to stop adding
new targets. Keep the notification-capable native image while any routed requests
are pending: an older native image ignores the routing and may resume sending
administrator copies. Do not remove the two JSON values or alter signed documents
to force a rollback. A native-only rollback requires a reviewed inventory and
owner acceptance of the notification regression; old unmodified HR requests are
compatible in either direction.
