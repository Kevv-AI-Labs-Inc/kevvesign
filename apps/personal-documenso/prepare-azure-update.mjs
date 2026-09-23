// Offline-only config generation. Never reads credentials from Azure, pushes an
// image, modifies a database, or deploys. Operator supplies an existing app export.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function preparePersonalAzureUpdate(current, { image, googleClientId }) {
  if (
    current.name !== 'ca-documenso-kevvesign-dev' ||
    !String(current.id)
      .toLowerCase()
      .includes(
        '/resourcegroups/rg-kevvesign-dev/providers/microsoft.app/containerapps/ca-documenso-kevvesign-dev',
      )
  ) {
    throw new Error('Only the existing personal Documenso resource in rg-kevvesign-dev is allowed');
  }
  const domains = current.properties?.configuration?.ingress?.customDomains || [];
  if (
    !domains.some((d) => d.name === 'documenso.kevv.ai') ||
    domains.some((d) => d.name !== 'documenso.kevv.ai')
  ) {
    throw new Error('Expected only documenso.kevv.ai; refuse shared/company domains');
  }
  if (!/^[a-z0-9./_-]*personal[a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('A separately named personal image pinned by digest is required');
  if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(googleClientId))
    throw new Error('Invalid Google client ID');
  const secrets = current.properties.configuration.secrets || [];
  for (const name of ['personal-google-client-secret', 'personal-portal-service-token']) {
    if (!secrets.some((s) => s.name === name && s.keyVaultUrl && s.identity)) {
      throw new Error(`Missing preconfigured Key Vault reference: ${name}`);
    }
  }
  const result = structuredClone(current);
  const containers = result.properties.template.containers;
  if (containers.length !== 1 || containers[0].name !== 'documenso')
    throw new Error('Unexpected container layout');
  const container = containers[0];
  const before = new Map((container.env || []).map((e) => [e.name, e]));
  if (before.get('NEXT_PUBLIC_WEBAPP_URL')?.value !== 'https://documenso.kevv.ai')
    throw new Error('Unexpected native public origin');
  const changes = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'NEXT_PRIVATE_GOOGLE_CLIENT_ID', value: googleClientId },
    { name: 'NEXT_PRIVATE_GOOGLE_CLIENT_SECRET', secretRef: 'personal-google-client-secret' },
    { name: 'PERSONAL_SIGNING_SERVICE_TOKEN', secretRef: 'personal-portal-service-token' },
    { name: 'NEXT_PUBLIC_DISABLE_GOOGLE_SIGNIN', value: 'false' },
    { name: 'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN', value: 'true' },
    { name: 'NEXT_PUBLIC_DISABLE_SIGNIN', value: 'false' },
    // The custom verified Portal enrollment path is the ONLY signup exception.
    ...[
      'SIGNUP',
      'EMAIL_PASSWORD_SIGNUP',
      'GOOGLE_SIGNUP',
      'MICROSOFT_SIGNUP',
      'OIDC_SIGNUP',
      'MICROSOFT_SIGNIN',
      'OIDC_SIGNIN',
    ].map((flag) => ({ name: `NEXT_PUBLIC_DISABLE_${flag}`, value: 'true' })),
  ];
  for (const entry of changes) before.set(entry.name, entry);
  before.delete('PERSONAL_SIGNING_RETAINED_USERS');
  container.env = [...before.values()];
  container.image = image;
  // Preserve ingress, certificates, identity, database/encryption/signing/SMTP
  // refs, resource sizing, volumes and probes. Never edit the company app/bridge.
  delete result.properties.template.revisionSuffix;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, image, googleClientId, output] = process.argv.slice(2);
  if (!input || !image || !googleClientId || !output || input === output) {
    throw new Error(
      'Usage: node prepare-azure-update.mjs current.json image@sha256:... client-id output.json',
    );
  }
  const result = preparePersonalAzureUpdate(JSON.parse(readFileSync(input, 'utf8')), {
    image,
    googleClientId,
  });
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdout.write(
    'Prepared personal-only app definition. Review it before deployment; no Azure resources changed.\n',
  );
}
