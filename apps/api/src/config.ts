import { z } from 'zod';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  DATA_DIR: z.string().default('.data'),
  STORAGE_DRIVER: z.enum(['local', 'azure']).default('local'),
  DATABASE_DRIVER: z.enum(['file', 'memory', 'azure-sql']).default('file'),
  EMAIL_DRIVER: z.enum(['local', 'azure']).default('local'),
  SIGNING_DRIVER: z.enum(['local', 'azure']).default('local'),
  SIGNING_ENGINE_PROVIDER: z.enum(['native', 'documenso']).default('native'),
  SESSION_SECRET: z.string().min(32).default('development-only-secret-change-me-now'),
  LAUNCH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  STAFF_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(28_800).default(3600),
  LOCAL_STAFF_EMAIL: z.string().email().default('admin@example.test'),
  LOCAL_STAFF_ROLE: z
    .enum(['platform_admin', 'workspace_admin', 'preparer', 'approver', 'auditor'])
    .default('platform_admin'),
  AZURE_SQL_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_URL: z.string().url().optional(),
  AZURE_STORAGE_CONTAINER_PREFIX: z.string().default('esign'),
  AZURE_KEY_VAULT_URL: z.string().url().optional(),
  AZURE_MANIFEST_KEY_NAME: z.string().default('esign-manifest'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  ACS_EMAIL_CONNECTION_STRING: z.string().optional(),
  ACS_EMAIL_SENDER: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  OIDC_PROVIDERS_JSON: z.string().default('[]'),
  DOCUMENSO_BASE_URL: z.string().url().optional(),
  DOCUMENSO_API_TOKEN: z.string().optional(),
  DOCUMENSO_WEBHOOK_SECRET: z.string().min(32).optional(),
  DOCUMENSO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.safeParse({
    ...environment,
    LAUNCH_SESSION_TTL_SECONDS:
      environment.LAUNCH_SESSION_TTL_SECONDS ?? environment.PORTAL_LAUNCH_TTL_SECONDS,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = parsed.data;
  if (Boolean(config.ENTRA_TENANT_ID) !== Boolean(config.ENTRA_CLIENT_ID)) {
    throw new Error('ENTRA_TENANT_ID and ENTRA_CLIENT_ID must be configured together.');
  }
  let oidcProviderCount = 0;
  try {
    const definitions = JSON.parse(config.OIDC_PROVIDERS_JSON) as unknown;
    if (!Array.isArray(definitions)) throw new Error('not an array');
    oidcProviderCount = definitions.length;
  } catch {
    throw new Error('OIDC_PROVIDERS_JSON must contain a JSON array.');
  }
  if (
    config.SIGNING_ENGINE_PROVIDER === 'documenso' &&
    (!config.DOCUMENSO_BASE_URL || !config.DOCUMENSO_API_TOKEN || !config.DOCUMENSO_WEBHOOK_SECRET)
  ) {
    throw new Error(
      'Documenso requires DOCUMENSO_BASE_URL, DOCUMENSO_API_TOKEN, and DOCUMENSO_WEBHOOK_SECRET.',
    );
  }
  if (config.NODE_ENV === 'production') {
    const required: Array<keyof AppConfig> = [
      'AZURE_SQL_CONNECTION_STRING',
      'AZURE_STORAGE_ACCOUNT_URL',
      'AZURE_KEY_VAULT_URL',
      'ACS_EMAIL_CONNECTION_STRING',
      'ACS_EMAIL_SENDER',
      'CLAMAV_HOST',
    ];
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0)
      throw new Error(`Missing production configuration: ${missing.join(', ')}`);
    if (
      config.DATABASE_DRIVER !== 'azure-sql' ||
      config.STORAGE_DRIVER !== 'azure' ||
      config.EMAIL_DRIVER !== 'azure'
    ) {
      throw new Error('Production requires Azure SQL, Blob, and Communication Services drivers.');
    }
    if (!config.ENTRA_TENANT_ID && !config.ENTRA_CLIENT_ID && oidcProviderCount === 0) {
      throw new Error('Production requires at least one standalone OIDC identity provider.');
    }
  }
  return config;
}
