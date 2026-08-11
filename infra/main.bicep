targetScope = 'resourceGroup'

@description('Short globally unique deployment prefix, lowercase letters and digits only.')
@minLength(4)
@maxLength(12)
param prefix string

@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Primary US Azure region selected during deployment review.')
param location string = resourceGroup().location

@description('Object ID of the Entra group that administers Azure SQL.')
param sqlEntraAdminObjectId string

@description('Tenant ID for the Entra SQL administrator.')
param tenantId string = tenant().tenantId

@description('Container image references supplied by CI after the first image build.')
param webImage string
param apiImage string
param pdfFinalizerImage string

@description('Public HTTPS origin used for staff and signer links, without a trailing slash.')
param publicBaseUrl string

param entraTenantId string
param entraClientId string
param acsEmailSender string

@secure()
param acsEmailConnectionString string

@secure()
@description('Initial local application session secret; production app reads the rotated value from Key Vault.')
param bootstrapSessionSecret string

var stem = '${prefix}-${environment}'
var compact = take(replace(stem, '-', ''), 20)
var tags = {
  application: 'internal-esign'
  environment: environment
  dataClassification: 'confidential'
  managedBy: 'bicep'
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${stem}'
  location: location
  tags: tags
  properties: {
    retentionInDays: environment == 'prod' ? 90 : 30
    sku: { name: 'PerGB2018' }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${stem}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    DisableIpMasking: false
    RetentionInDays: environment == 'prod' ? 90 : 30
  }
}

resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-app-${stem}'
  location: location
  tags: tags
}

resource finalizerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-pdf-${stem}'
  location: location
  tags: tags
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${compact}${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  sku: { name: environment == 'prod' ? 'Standard_GZRS' : 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    isHnsEnabled: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: environment == 'prod' ? 30 : 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: environment == 'prod' ? 30 : 7 }
    isVersioningEnabled: true
    changeFeed: { enabled: true, retentionInDays: environment == 'prod' ? 90 : 14 }
  }
}

resource objectsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'esign-objects'
  properties: { publicAccess: 'None' }
}

resource recoveryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'recovery'
  properties: { publicAccess: 'None' }
}

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: 'sb-${stem}-${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
  }
}

resource finalizeQueue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: 'pdf-finalize'
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
    duplicateDetectionHistoryTimeWindow: 'P1D'
    requiresDuplicateDetection: true
  }
}

resource emailQueue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: 'email-commands'
  properties: {
    lockDuration: 'PT2M'
    maxDeliveryCount: 8
    deadLetteringOnMessageExpiration: true
    requiresDuplicateDetection: true
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${stem}-${take(uniqueString(resourceGroup().id), 6)}'
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: environment == 'prod' ? 'premium' : 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
  }
}

resource manifestKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: keyVault
  name: 'esign-manifest'
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: ['sign', 'verify']
    attributes: { enabled: true }
    rotationPolicy: {
      lifetimeActions: [
        { trigger: { timeAfterCreate: 'P335D' }, action: { type: 'rotate' } }
        { trigger: { timeBeforeExpiry: 'P30D' }, action: { type: 'notify' } }
      ]
      attributes: { expiryTime: 'P365D' }
    }
  }
}

resource sessionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'session-secret'
  properties: { value: bootstrapSessionSecret }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: 'sql-${stem}-${take(uniqueString(resourceGroup().id), 6)}'
  location: location
  tags: tags
  properties: {
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      login: 'esign-sql-admins'
      principalType: 'Group'
      sid: sqlEntraAdminObjectId
      tenantId: tenantId
    }
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    restrictOutboundNetworkAccess: 'Disabled'
    version: '12.0'
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: 'esign'
  location: location
  tags: tags
  sku: environment == 'prod' ? {
    name: 'GP_S_Gen5_2'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  } : {
    name: 'Basic'
    tier: 'Basic'
    capacity: 5
  }
  properties: {
    autoPauseDelay: environment == 'prod' ? -1 : 60
    requestedBackupStorageRedundancy: environment == 'prod' ? 'Geo' : 'Local'
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    isLedgerOn: true
    readScale: 'Disabled'
    zoneRedundant: false
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${stem}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-api-${stem}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workloadIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        {
          name: 'session-secret'
          keyVaultUrl: sessionSecret.properties.secretUriWithVersion
          identity: workloadIdentity.id
        }
        {
          name: 'acs-email'
          value: acsEmailConnectionString
        }
      ]
      ingress: {
        external: true
        targetPort: 4100
        transport: 'http'
        allowInsecure: false
      }
      maxInactiveRevisions: 3
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '4100' }
            { name: 'DATABASE_DRIVER', value: 'azure-sql' }
            { name: 'STORAGE_DRIVER', value: 'azure' }
            { name: 'SIGNING_DRIVER', value: 'azure' }
            { name: 'EMAIL_DRIVER', value: 'azure' }
            { name: 'WEB_ORIGIN', value: publicBaseUrl }
            { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'PORTAL_LAUNCH_TTL_SECONDS', value: '300' }
            { name: 'STAFF_SESSION_TTL_SECONDS', value: '3600' }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ACS_EMAIL_CONNECTION_STRING', secretRef: 'acs-email' }
            { name: 'ACS_EMAIL_SENDER', value: acsEmailSender }
            { name: 'AZURE_SQL_CONNECTION_STRING', value: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Initial Catalog=${database.name};Authentication=Active Directory Managed Identity;User Id=${workloadIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_KEY_VAULT_URL', value: keyVault.properties.vaultUri }
            { name: 'CLAMAV_HOST', value: '127.0.0.1' }
            { name: 'CLAMAV_PORT', value: '3310' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
        {
          name: 'clamav'
          image: 'clamav/clamav:1.4'
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
      scale: { minReplicas: environment == 'prod' ? 1 : 0, maxReplicas: 5 }
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-web-${stem}'
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          env: [{ name: 'API_UPSTREAM', value: 'https://${api.properties.configuration.ingress.fqdn}' }]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 3 }
    }
  }
}

resource pdfJob 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-pdf-${stem}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${finalizerIdentity.id}': {} } }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 900
      replicaRetryLimit: 2
      eventTriggerConfig: {
        parallelism: 2
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 5
          pollingInterval: 30
          rules: []
        }
      }
    }
    template: {
      containers: [
        {
          name: 'pdf-finalizer'
          image: pdfFinalizerImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AZURE_SQL_CONNECTION_STRING', value: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Initial Catalog=${database.name};Authentication=Active Directory Managed Identity;User Id=${finalizerIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_KEY_VAULT_URL', value: keyVault.properties.vaultUri }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
    }
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, workloadIdentity.id, 'blob-contributor')
  scope: storage
  properties: {
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource finalizerBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, finalizerIdentity.id, 'blob-contributor')
  scope: storage
  properties: {
    principalId: finalizerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource vaultCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, finalizerIdentity.id, 'crypto-user')
  scope: keyVault
  properties: {
    principalId: finalizerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
  }
}

resource vaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workloadIdentity.id, 'secrets-user')
  scope: keyVault
  properties: {
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource serviceBusSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, workloadIdentity.id, 'sender')
  scope: serviceBus
  properties: {
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output webFqdn string = web.properties.configuration.ingress.fqdn
output storageAccount string = storage.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output keyVaultUri string = keyVault.properties.vaultUri
output serviceBusNamespace string = serviceBus.name
