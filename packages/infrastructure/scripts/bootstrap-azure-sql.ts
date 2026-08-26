import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  AZURE_SQL_SERVER: z.string().min(1),
  AZURE_SQL_DATABASE: z.string().min(1).default('esign'),
  AZURE_SQL_ACCESS_TOKEN: z.string().min(100),
  APP_IDENTITY_NAME: z.string().min(1).max(128),
  APP_IDENTITY_CLIENT_ID: z.string().uuid(),
  FINALIZER_IDENTITY_NAME: z.string().min(1).max(128),
  FINALIZER_IDENTITY_CLIENT_ID: z.string().uuid(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_DISPLAY_NAME: z.string().min(1).max(160),
  ADMIN_OBJECT_ID: z.string().uuid(),
  BOOTSTRAP_CLIENT_ID: z.string().uuid(),
  BOOTSTRAP_SECRET_HASH: z.string().regex(/^[a-f0-9]{64}$/),
  BOOTSTRAP_RETURN_URL: z.string().url(),
  WORKSPACE_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),
  WORKSPACE_MEMBER_ID: z.string().uuid().default('22222222-2222-4222-8222-222222222222'),
  WORKSPACE_NAME: z.string().min(2).max(160).default('Kevv eSign Operations'),
  WORKSPACE_SLUG: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default('kevv-esign'),
  BOOTSTRAP_CLIENT_NAME: z.string().min(2).max(120).default('Azure deployment smoke client'),
  BOOTSTRAP_CONNECTOR_KEY: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default('azure-smoke-client'),
  BOOTSTRAP_BUSINESS_DOMAIN: z.enum(['HR', 'REAL_ESTATE']).default('REAL_ESTATE'),
  SIGNING_ENGINE_PROVIDER: z.enum(['native', 'documenso']).default('native'),
  SIGNING_PROVIDER_CONNECTION_ID: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .default('default-signing-provider'),
});

const config = EnvironmentSchema.parse(process.env);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sqlDirectory = path.resolve(scriptDirectory, '../../../infra/sql');
const workspaceId = config.WORKSPACE_ID;
const memberId = config.WORKSPACE_MEMBER_ID;
const now = new Date().toISOString();
const scopes = [
  'templates:read',
  'templates:write',
  'transactions:read',
  'transactions:write',
  'envelopes:read',
  'envelopes:write',
  'envelopes:send',
  'evidence:read',
  'integration-sessions:create',
];

const pool = await sql.connect({
  server: config.AZURE_SQL_SERVER,
  database: config.AZURE_SQL_DATABASE,
  options: { encrypt: true, trustServerCertificate: false },
  authentication: {
    type: 'azure-active-directory-access-token',
    options: { token: config.AZURE_SQL_ACCESS_TOKEN },
  },
});

try {
  const schema = await pool
    .request()
    .query<{ platform_state: number | null }>(
      "SELECT OBJECT_ID('dbo.platform_state') AS platform_state",
    );
  if (!schema.recordset[0]?.platform_state) {
    await pool.request().batch(await readFile(path.join(sqlDirectory, '001_initial.sql'), 'utf8'));
  }

  await pool.request().batch(await readFile(path.join(sqlDirectory, '002_security.sql'), 'utf8'));

  await provisionManagedIdentity(pool, config.APP_IDENTITY_NAME, config.APP_IDENTITY_CLIENT_ID);
  await provisionManagedIdentity(
    pool,
    config.FINALIZER_IDENTITY_NAME,
    config.FINALIZER_IDENTITY_CLIENT_ID,
  );

  const stateResult = await pool
    .request()
    .query<{ state_json: string }>(
      'SELECT state_json FROM dbo.platform_state WHERE singleton_id = 1',
    );
  const state = JSON.parse(stateResult.recordset[0]?.state_json ?? '{}') as Record<string, unknown>;
  const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
  if (!workspaces.some((workspace) => isRecord(workspace) && workspace.id === workspaceId)) {
    workspaces.push({
      id: workspaceId,
      name: config.WORKSPACE_NAME,
      slug: config.WORKSPACE_SLUG,
      enabledJurisdictions: ['NY', 'NJ', 'CA'],
      createdAt: now,
      members: [
        {
          id: memberId,
          email: config.ADMIN_EMAIL,
          displayName: config.ADMIN_DISPLAY_NAME,
          role: 'platform_admin',
          status: 'ACTIVE',
        },
      ],
    });
  }
  const workspace = workspaces.find(
    (candidate) => isRecord(candidate) && candidate.id === workspaceId,
  );
  if (isRecord(workspace) && config.SIGNING_ENGINE_PROVIDER === 'documenso') {
    workspace.signingProviderConnectionId = config.SIGNING_PROVIDER_CONNECTION_ID;
  }
  if (isRecord(workspace)) {
    workspace.name = config.WORKSPACE_NAME;
    workspace.slug = config.WORKSPACE_SLUG;
  }
  state.workspaces = workspaces;

  const applicationClients = Array.isArray(state.applicationClients)
    ? state.applicationClients
    : [];
  const bootstrapClient = applicationClients.find(
    (client) => isRecord(client) && client.id === config.BOOTSTRAP_CLIENT_ID,
  );
  if (!bootstrapClient) {
    applicationClients.push({
      id: config.BOOTSTRAP_CLIENT_ID,
      workspaceId,
      name: config.BOOTSTRAP_CLIENT_NAME,
      connectorKey: config.BOOTSTRAP_CONNECTOR_KEY,
      secretHash: config.BOOTSTRAP_SECRET_HASH,
      scopes,
      businessDomains: [config.BOOTSTRAP_BUSINESS_DOMAIN],
      allowedReturnUrls: [config.BOOTSTRAP_RETURN_URL],
      status: 'ACTIVE',
      createdAt: now,
    });
  } else if (isRecord(bootstrapClient)) {
    bootstrapClient.name = config.BOOTSTRAP_CLIENT_NAME;
    bootstrapClient.connectorKey = config.BOOTSTRAP_CONNECTOR_KEY;
    bootstrapClient.secretHash = config.BOOTSTRAP_SECRET_HASH;
    bootstrapClient.scopes = scopes;
    bootstrapClient.businessDomains = [config.BOOTSTRAP_BUSINESS_DOMAIN];
    bootstrapClient.allowedReturnUrls = [config.BOOTSTRAP_RETURN_URL];
    bootstrapClient.status = 'ACTIVE';
  }
  state.applicationClients = applicationClients;

  await pool
    .request()
    .input('stateJson', sql.NVarChar(sql.MAX), JSON.stringify(state))
    .query(
      'UPDATE dbo.platform_state SET state_json = @stateJson, updated_at = SYSUTCDATETIME() WHERE singleton_id = 1',
    );

  await pool
    .request()
    .input('workspaceId', sql.UniqueIdentifier, workspaceId)
    .input('workspaceSlug', sql.NVarChar(80), config.WORKSPACE_SLUG)
    .input('workspaceName', sql.NVarChar(160), config.WORKSPACE_NAME)
    .query(`IF NOT EXISTS (SELECT 1 FROM esign.workspaces WHERE id = @workspaceId)
      INSERT esign.workspaces (id, slug, display_name, status)
      VALUES (@workspaceId, @workspaceSlug, @workspaceName, 'ACTIVE')`);

  await pool
    .request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('workspaceId', sql.UniqueIdentifier, workspaceId)
    .input('objectId', sql.UniqueIdentifier, config.ADMIN_OBJECT_ID)
    .input('email', sql.NVarChar(254), config.ADMIN_EMAIL)
    .input('displayName', sql.NVarChar(160), config.ADMIN_DISPLAY_NAME)
    .query(`IF NOT EXISTS (SELECT 1 FROM esign.workspace_members WHERE id = @memberId)
      INSERT esign.workspace_members
        (id, workspace_id, entra_object_id, email, display_name, role, status)
      VALUES
        (@memberId, @workspaceId, @objectId, @email, @displayName, 'platform_admin', 'ACTIVE')`);

  await pool
    .request()
    .input('clientId', sql.UniqueIdentifier, config.BOOTSTRAP_CLIENT_ID)
    .input('workspaceId', sql.UniqueIdentifier, workspaceId)
    .input('secretHash', sql.Char(64), config.BOOTSTRAP_SECRET_HASH)
    .input('scopes', sql.NVarChar(sql.MAX), JSON.stringify(scopes))
    .input('returnUrls', sql.NVarChar(sql.MAX), JSON.stringify([config.BOOTSTRAP_RETURN_URL]))
    .input('clientName', sql.NVarChar(120), config.BOOTSTRAP_CLIENT_NAME)
    .input('createdAt', sql.DateTime2, new Date(now))
    .query(`IF NOT EXISTS (SELECT 1 FROM esign.application_clients WHERE id = @clientId)
      INSERT esign.application_clients
        (id, workspace_id, display_name, secret_hash, scopes_json, allowed_return_urls_json, status, created_at)
      VALUES
        (@clientId, @workspaceId, @clientName, @secretHash, @scopes, @returnUrls, 'ACTIVE', @createdAt)
      ELSE
        UPDATE esign.application_clients
        SET display_name = @clientName,
            secret_hash = @secretHash,
            scopes_json = @scopes,
            allowed_return_urls_json = @returnUrls,
            status = 'ACTIVE'
        WHERE id = @clientId`);

  process.stdout.write(
    `${JSON.stringify({
      status: 'ready',
      workspaceId,
      bootstrapClientId: config.BOOTSTRAP_CLIENT_ID,
      identities: [config.APP_IDENTITY_NAME, config.FINALIZER_IDENTITY_NAME],
    })}\n`,
  );
} finally {
  await pool.close();
}

async function provisionManagedIdentity(
  pool: sql.ConnectionPool,
  name: string,
  clientId: string,
): Promise<void> {
  await pool
    .request()
    .input('principalName', sql.NVarChar(128), name)
    .input('clientId', sql.UniqueIdentifier, clientId).batch(`
      DECLARE @sid binary(16) = CONVERT(varbinary(16), @clientId);
      IF EXISTS (
        SELECT 1
        FROM sys.database_principals
        WHERE name = @principalName AND sid <> @sid
      )
      BEGIN
        DECLARE @dropStatement nvarchar(max) = N'DROP USER ' + QUOTENAME(@principalName);
        EXEC sys.sp_executesql @dropStatement;
      END;
      IF DATABASE_PRINCIPAL_ID(@principalName) IS NULL
      BEGIN
        DECLARE @statement nvarchar(max) = N'CREATE USER ' + QUOTENAME(@principalName)
          + N' WITH SID = ' + CONVERT(varchar(34), @sid, 1) + N', TYPE = E';
        EXEC sys.sp_executesql @statement;
      END;
      IF IS_ROLEMEMBER('esign_app_role', @principalName) <> 1
      BEGIN
        DECLARE @roleStatement nvarchar(max) = N'ALTER ROLE esign_app_role ADD MEMBER '
          + QUOTENAME(@principalName);
        EXEC sys.sp_executesql @roleStatement;
      END;
    `);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
