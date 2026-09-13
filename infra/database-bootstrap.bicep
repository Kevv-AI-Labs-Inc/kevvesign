targetScope = 'resourceGroup'
param location string = 'centralus'
param environmentName string = 'cae-kevvesign-signing-prod'
param postgresHost string = 'pg-kevvesign-signing-prod.postgres.database.azure.com'
param administratorLogin string = 'signingbootstrap'
@secure()
param administratorPassword string
@secure()
param documensoPassword string
@secure()
param bridgePassword string
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
// Run once on the new, empty production databases, then remove this temporary job.
var bootstrap = '''
set -eu
psql -X -q -v ON_ERROR_STOP=1 -d postgres <<'SQL'
\getenv doc_password DOCUMENSO_PASSWORD
\getenv bridge_password BRIDGE_PASSWORD
SELECT format('CREATE ROLE documenso_runtime LOGIN PASSWORD %L', :'doc_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='documenso_runtime') \gexec
SELECT format('CREATE ROLE esign_bridge_runtime LOGIN PASSWORD %L', :'bridge_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='esign_bridge_runtime') \gexec
GRANT documenso_runtime, esign_bridge_runtime TO signingbootstrap;
ALTER DATABASE documenso OWNER TO documenso_runtime;
ALTER DATABASE esign_bridge OWNER TO esign_bridge_runtime;
REVOKE ALL ON DATABASE documenso FROM PUBLIC;
REVOKE ALL ON DATABASE esign_bridge FROM PUBLIC;
GRANT CONNECT ON DATABASE documenso TO documenso_runtime;
GRANT CONNECT ON DATABASE esign_bridge TO esign_bridge_runtime;
\connect documenso
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO documenso_runtime;
\connect esign_bridge
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO esign_bridge_runtime;
SQL
PGUSER=documenso_runtime PGPASSWORD="$DOCUMENSO_PASSWORD" psql -X -q -v ON_ERROR_STOP=1 -d documenso -c 'SELECT current_database(), current_user;'
PGUSER=esign_bridge_runtime PGPASSWORD="$BRIDGE_PASSWORD" psql -X -q -v ON_ERROR_STOP=1 -d esign_bridge -c 'SELECT current_database(), current_user;'
if PGUSER=documenso_runtime PGPASSWORD="$DOCUMENSO_PASSWORD" psql -X -q -d esign_bridge -c 'SELECT 1' >/dev/null 2>&1; then echo 'FAILED: Documenso can access bridge database'; exit 1; fi
if PGUSER=esign_bridge_runtime PGPASSWORD="$BRIDGE_PASSWORD" psql -X -q -d documenso -c 'SELECT 1' >/dev/null 2>&1; then echo 'FAILED: bridge can access Documenso database'; exit 1; fi
echo 'Database ownership and cross-database isolation verified.'
'''
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-signing-db-bootstrap'
  location: location
  tags: { application: 'esign', purpose: 'temporary-database-bootstrap', managedBy: 'bicep' }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: [
        { name: 'administrator-password', value: administratorPassword }
        { name: 'documenso-password', value: documensoPassword }
        { name: 'bridge-password', value: bridgePassword }
      ]
    }
    template: {
      containers: [{
        name: 'bootstrap'
        image: 'postgres:16-alpine'
        command: ['/bin/sh', '-ec']
        args: [bootstrap]
        env: [
          { name: 'PGHOST', value: postgresHost }
          { name: 'PGUSER', value: administratorLogin }
          { name: 'PGSSLMODE', value: 'require' }
          { name: 'PGCONNECT_TIMEOUT', value: '20' }
          { name: 'PGPASSWORD', secretRef: 'administrator-password' }
          { name: 'DOCUMENSO_PASSWORD', secretRef: 'documenso-password' }
          { name: 'BRIDGE_PASSWORD', secretRef: 'bridge-password' }
        ]
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
      }]
    }
  }
}
