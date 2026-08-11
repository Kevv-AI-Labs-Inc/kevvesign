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
  SESSION_SECRET: z.string().min(32).default('development-only-secret-change-me-now'),
  PORTAL_LAUNCH_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
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
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    const required: Array<keyof AppConfig> = [
      'AZURE_SQL_CONNECTION_STRING',
      'AZURE_STORAGE_ACCOUNT_URL',
      'AZURE_KEY_VAULT_URL',
      'ACS_EMAIL_CONNECTION_STRING',
      'ACS_EMAIL_SENDER',
      'ENTRA_TENANT_ID',
      'ENTRA_CLIENT_ID',
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
  }
  return config;
}
