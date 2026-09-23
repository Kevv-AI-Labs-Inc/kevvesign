# Portal self-service signing (personal instance only)

Status: initial Portal/native deployment live on 2026-09-23; final real-user
Google login and signing acceptance are deferred at the owner's request.
The owner approved the modified 2.11.0 image, reuse of Kevv's Google OAuth client,
and retirement of legacy test-account access. Company signing is out of scope.

## Boundaries

- `agents.homixny.com` / `homixliving`: active-user authorization and first-use entry.
- `documenso.kevv.ai` / `ca-documenso-kevvesign-dev` in `rg-kevvesign-dev`: personal
  self-service native editor, isolated account/organisation/team per agent.
- `esign.kevv.ai`, the production bridge, their databases, service tokens and HR /
  company workflows: unchanged. Never point `DOCUMENSO_BASE_URL` at the personal app.

This is a separately built, small overlay on official Documenso 2.11.0 commit
`191170923a459afa003c846bd8501190a14f52d5`. It is **not** an environment-variable-only
enablement of unrestricted Google signup. No Portal passwords, native session
cookies or Google access tokens are copied between systems.

## User flow / contract

1. Active agent submits a same-origin POST from Portal's File signing page.
2. Portal registers the agent's verified, enabled Google subject and login email.
   No browser-supplied agent ID, email, role or redirect is trusted.
3. A 303 opens `https://documenso.kevv.ai/signin` without credentials in the URL.
4. User selects **the same Google account**. Native OAuth code exchange, state,
   PKCE and verified-email checks remain in place. Issuer, audience and expiration
   are checked too. A Google account picker/consent screen may appear.
5. After Google verification, native calls
   `POST https://agents.homixny.com/api/personal-signing/authorize` over TLS with a
   dedicated bearer `PERSONAL_SIGNING_SERVICE_TOKEN` (at least 32 random characters).
   Body: `{ "googleSubject": "...", "email": "..." }`.
6. Portal verifies active account, prior enrollment, non-revoked grant, the Google
   identity and verified sign-in email belonging to that same agent. Response:
   `{ "agentId": 123, "email": "...", "name": "...", "grantId": "uuid" }`.
7. Native maps stable Portal agent ID to one native user. Google identity/grant
   rotation reuses this user, invalidates prior sessions, and does not merge by
   email. A same-email pre-existing unmapped user is rejected for explicit review.
8. Native creates a personal organisation and team with deterministic unique URLs,
   one owner, no inherited ordinary members, ADMIN document visibility and delegated
   document ownership. Provisioning failures do not issue a session; retry repairs
   missing workspace steps without creating another account.

Opening the native hostname directly does not bypass any checks. New sessions,
existing session validation and native API tokens all check current Portal access.
All users must authenticate with Google; password/passkey login and legacy-account
exceptions are disabled. Only a verified Google callback can
synchronize a managed user's sign-in email after an approved Portal identity change.
The editor/signer/PDF engine is unchanged. External recipients can still sign their
invited documents without a Portal account; this is not public account signup.

## Revocation and availability

- Offboarding/inactivation latches `revoked_at` in `portal.personal_signing_grants`
  through an invoker-rights trigger. Setting the agent active again does not clear it.
- The next authenticated native request is denied and native browser sessions are
  deleted on definitive denial. Native API tokens are checked on every use.
- If Portal is unreachable or returns a non-authoritative error, managed-user
  requests fail closed with 503; sessions are not destroyed because of an outage.
- Identity/grant changes require fresh Google authentication. Reactivation requires
  explicit administrator approval and a new `grant_id`; do not merely clear a flag.
- Extra organisation memberships, other members in a managed private workspace,
  disabled users or native site-admin promotion fail closed. Do not invite users
  into these spaces. Resolve accidental memberships administratively.
- Per-request checks add Portal latency/availability dependence. There is no
  positive authorization TTL that would delay revocation.
- Existing unrequested signature invitations are not automatically cancelled on
  offboarding. Document retention/deletion is separate; no documents are deleted.

## Legacy test accounts

The owner confirmed old personal accounts/documents are disposable test data.
They receive no authorization exemption and cannot sign in. If an old account
conflicts with a Portal email, resolve that exact personal-database record before
launch; never automatically adopt an existing account by email alone. No company
accounts, packages, documents or databases may be deleted by this rollout.

## Configuration and rollout (manual release gates)

1. Record current personal configuration and company revision/image baselines.
   Preserve personal signing material, encryption keys and SMTP configuration.
   Compare the running image's schema/migrations to the pinned source before release.
2. Accepted risk: the local 2.11.0 production dependency audit reported **30 high**
   findings (79 total, no critical production findings). The owner explicitly chose
   no version upgrade or unrelated vulnerability remediation for this release.
   This is not a claim that the inherited dependencies are vulnerability-free.
3. Reuse Kevv's existing Google **Web application** OAuth client, keeping all Kevv
   callback URIs. The owner confirmed appending the exact redirect URI:
   `https://documenso.kevv.ai/api/auth/callback/google`.
   Choose consent-app audience/test users consistent with actual Portal users
   (which may include Gmail/personal addresses). Google audience/domain restrictions
   do not replace the Portal authorization check.
4. Store the OAuth secret and a generated, separate shared service credential in
   Key Vault. Add Container App Key Vault secret references named
   `personal-google-client-secret` and `personal-portal-service-token`; verify the
   app identity can read the personal vault references without granting it access
   to Kevv's vault. Do not paste secret
   values into Git, browser code, URLs or command output.
5. In `homixliving`, roll out `ensurePersonalSigningSchema` through the existing
   reviewed schema process. It is additive, idempotent, RLS-enabled and denies
   browser database roles. Keep `PERSONAL_SIGNING_ENABLED` unset/false initially.
   Set the same dedicated `PERSONAL_SIGNING_SERVICE_TOKEN` server-side in Portal.
6. Build **only** the separate personal image:

   ```sh
   node apps/personal-documenso/build-image.mjs homix-personal-documenso:2.11.0-portal-1 linux/amd64
   ```

   This builds locally, never pushes or deploys. Publish to a distinct image name
   using your release process and record its digest. Azure requires the correct
   platform (normally `linux/amd64`); a local ARM build is not an Azure-ready image.
   The build retains and serves full corresponding source at
   `/personal-signing-source.tar.gz`, linked from sign-in (AGPL).

7. Export the current **personal** Container App definition, preserving secret
   references. Generate, review and compare an update:

   ```sh
   node apps/personal-documenso/prepare-azure-update.mjs \
     current-personal-app.json registry.example/homix-personal@sha256:DIGEST \
     CLIENT_ID.apps.googleusercontent.com personal-update.json
   ```

   This is offline generation, not deployment. It rejects the company app/resource
   group/domain, unpinned images and absent Key Vault references. Review Azure
   read-only/system fields before applying the
   generated definition through the normal deployment process. Preserve all current
   database, encryption, certificate, SMTP, networking and scale settings.

8. Required native runtime: `NODE_ENV=production`, existing public URL, Google client
   ID/secret and service token. Keep **all public signup switches
   disabled**. The custom callback is the only narrowly authorized enrollment path.
   Google sign-in must be enabled; password sign-in is disabled.
   The pinned upstream ignores the password sign-in UI switch, so the personal
   sign-in route uses a Google-only component. Password/passkey rejection is also
   enforced server-side; hiding controls is not the authorization boundary.
9. Validate native health, then enable the Portal entry with
   `PERSONAL_SIGNING_ENABLED=true` for acceptance. Use two consenting test agents
   and a third unauthorized Google account. Before opening broadly, verify upload,
   signer invitation, completion/download, A/B isolation, direct-native denial,
   API-token revocation and offboarding. No real email is sent by the automated tests.

`NODE_ENV=production` changes the native secure-cookie name; users may need to clear
only this site's old cookies and sign in again. The overlay also computes session
cookie expiry at write time, fixing the module-load expiry in this pinned source.

## Validation

- Local verification: 72 repository unit/regression checks, 12 native integration
  checks, 6 Portal policy checks, 8 Portal SQL/HTTP integration checks, native auth
  typecheck and full personal Docker build. Portal typecheck and signing regression
  tests pass. The built ARM64 test image returns 200 for health, sign-in (including
  the Google button and Portal instructions), and the corresponding-source download.
  These do **not** replace real Google OAuth, browser and end-to-end signing acceptance.
- `.github/workflows/personal-signing.yml` runs the pinned-source native integration
  checks against an isolated PostgreSQL service; it never deploys or uses live secrets.
- `pnpm test` includes native policy and personal-only deployment guard unit tests.
- Prepare a fresh official pinned checkout with `prepare.mjs`, install with npm
  11.11.0 (older npm misreads its lockfile), generate Prisma types and run:
  `npx tsc -p packages/auth/tsconfig.json --noEmit`.
- Native integration script: `apps/personal-documenso/__tests__/native.integration.ts`.
  Set `PERSONAL_DOCUMENSO_SOURCE`, both native database URLs to a fresh local
  `personal_signing_test` database (Postgres with pg_trgm/pgcrypto). For this empty
  fixture DB only, load the patched schema with `prisma db push`; never do that on
  production. Execute using the upstream checkout's `tsx` loader.
- Portal: `npm run test:personal-signing`, `npm run test:personal-signing:db` with
  `DATABASE_URL` explicitly set to a fresh local `homix_personal_signing_test` DB.
  The DB script refuses remote/non-test targets or an existing Portal schema.
- Existing company signing tests, typechecks and build remain release requirements.

## Rollback

Hide/disable the Portal entry first. This makes all native account access fail closed.
Keep additive mapping tables and file
data. Do not roll back to an unrestricted stock Google-enabled image: that removes
the authorization boundary. An emergency stock-image rollback requires Google and
all signup methods disabled, managed native accounts disabled and their sessions /
API access revoked before traffic is switched. Back up before any DB rollback.

Google configuration reference:
https://docs.documenso.com/docs/self-hosting/configuration/advanced/oauth-providers
