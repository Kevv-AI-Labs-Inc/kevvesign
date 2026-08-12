targetScope = 'resourceGroup'

@description('Azure region of the existing Container Apps environment.')
param location string = resourceGroup().location

@description('Existing Container Apps managed environment name.')
param containerAppsEnvironmentName string = 'cae-kevvesign-dev'

@description('Existing Key Vault name containing Documenso secrets.')
param keyVaultName string = 'kv-kevvesign-dev-lxgas2'

@description('Existing Azure Database for PostgreSQL flexible server used by Documenso.')
param postgresServerName string = 'pg-kevvesign-documenso-dev'

@description('Public HTTPS URL used in Documenso links and callbacks.')
param publicWebappUrl string

@description('Custom hostname already validated for the Documenso Container App.')
param customHostname string = 'documenso.kevv.ai'

@description('Existing Azure managed certificate bound to the custom hostname.')
param managedCertificateName string = 'mc-cae-kevvesign--documenso-kevv-a-7104'

@description('Pinned Documenso image. Upgrade intentionally after backup and validation.')
param image string = 'documenso/documenso:v2.11.0'

@description('Only these email domains may create staff accounts.')
param allowedSignupDomains string = 'homixny.com'

@description('Sender address already provisioned in Azure Communication Services Email.')
param smtpFromAddress string = 'esign@esign.kevv.ai'

@description('Azure Communication Services SMTP username.')
param smtpUsername string = 'documenso-dev'

var appName = 'ca-documenso-kevvesign-dev'
var identityName = 'id-documenso-kevvesign-dev'
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource managedCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' existing = {
  parent: containerAppsEnvironment
  name: managedCertificateName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    source: 'user-override'
    value: 'pgcrypto,pg_trgm'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: {
    application: 'documenso'
    environment: 'dev'
    managedBy: 'bicep'
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource documenso 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: {
    application: 'documenso'
    environment: 'dev'
    managedBy: 'bicep'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 3
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
        customDomains: [
          {
            name: customHostname
            bindingType: 'SniEnabled'
            certificateId: managedCertificate.id
          }
        ]
      }
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-database-url'
          identity: identity.id
        }
        {
          name: 'nextauth-secret'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-nextauth-secret'
          identity: identity.id
        }
        {
          name: 'encryption-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-encryption-key'
          identity: identity.id
        }
        {
          name: 'encryption-secondary-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-encryption-secondary-key'
          identity: identity.id
        }
        {
          name: 'signing-passphrase'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-signing-passphrase'
          identity: identity.id
        }
        {
          name: 'signing-certificate'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-signing-cert-base64'
          identity: identity.id
        }
        {
          name: 'smtp-password'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/documenso-smtp-app-secret'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'documenso'
          image: image
          command: ['/bin/sh']
          args: [
            '-ec'
            'cd /app/apps/remix && . ./start.sh'
          ]
          env: [
            { name: 'PORT', value: '3000' }
            { name: 'NEXTAUTH_SECRET', secretRef: 'nextauth-secret' }
            { name: 'NEXT_PRIVATE_ENCRYPTION_KEY', secretRef: 'encryption-key' }
            {
              name: 'NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY'
              secretRef: 'encryption-secondary-key'
            }
            { name: 'NEXT_PUBLIC_WEBAPP_URL', value: publicWebappUrl }
            { name: 'NEXT_PRIVATE_INTERNAL_WEBAPP_URL', value: 'http://localhost:3000' }
            { name: 'NEXT_PRIVATE_DATABASE_URL', secretRef: 'database-url' }
            { name: 'NEXT_PRIVATE_DIRECT_DATABASE_URL', secretRef: 'database-url' }
            { name: 'NEXT_PUBLIC_UPLOAD_TRANSPORT', value: 'database' }
            { name: 'NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT', value: '25' }
            { name: 'NEXT_PRIVATE_SIGNING_TRANSPORT', value: 'local' }
            {
              name: 'NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS'
              secretRef: 'signing-certificate'
            }
            { name: 'NEXT_PRIVATE_SIGNING_PASSPHRASE', secretRef: 'signing-passphrase' }
            { name: 'NEXT_PRIVATE_SMTP_TRANSPORT', value: 'smtp-auth' }
            { name: 'NEXT_PRIVATE_SMTP_HOST', value: 'smtp.azurecomm.net' }
            { name: 'NEXT_PRIVATE_SMTP_PORT', value: '587' }
            { name: 'NEXT_PRIVATE_SMTP_SECURE', value: 'false' }
            { name: 'NEXT_PRIVATE_SMTP_USERNAME', value: smtpUsername }
            { name: 'NEXT_PRIVATE_SMTP_PASSWORD', secretRef: 'smtp-password' }
            { name: 'NEXT_PRIVATE_SMTP_FROM_NAME', value: 'Kevv eSign' }
            { name: 'NEXT_PRIVATE_SMTP_FROM_ADDRESS', value: smtpFromAddress }
            { name: 'NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS', value: allowedSignupDomains }
            { name: 'NEXT_PUBLIC_DISABLE_SIGNUP', value: 'false' }
            { name: 'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP', value: 'false' }
            { name: 'NEXT_PUBLIC_DISABLE_GOOGLE_SIGNUP', value: 'true' }
            { name: 'NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNUP', value: 'true' }
            { name: 'NEXT_PUBLIC_DISABLE_OIDC_SIGNUP', value: 'true' }
            { name: 'NEXT_PUBLIC_DISABLE_GOOGLE_SIGNIN', value: 'true' }
            { name: 'NEXT_PUBLIC_DISABLE_MICROSOFT_SIGNIN', value: 'true' }
            { name: 'NEXT_PUBLIC_DISABLE_OIDC_SIGNIN', value: 'true' }
            { name: 'DOCUMENSO_DISABLE_TELEMETRY', value: 'true' }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 60
              periodSeconds: 30
              timeoutSeconds: 10
              failureThreshold: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 15
              timeoutSeconds: 10
              failureThreshold: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [keyVaultSecretsUser, postgresExtensions]
}

output appName string = documenso.name
output fqdn string = documenso.properties.configuration.ingress.fqdn
output publicUrl string = 'https://${documenso.properties.configuration.ingress.fqdn}'
