targetScope = 'resourceGroup'

@description('Short globally unique deployment prefix, lowercase letters and digits only.')
@minLength(4)
@maxLength(12)
param prefix string

@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Primary US Azure region selected during deployment review.')
param location string = resourceGroup().location

@description('Azure SQL region; may differ in dev when subscription capacity restricts the primary region.')
param sqlLocation string = location

@description('Object ID of the Entra group that administers Azure SQL.')
param sqlEntraAdminObjectId string

@description('Display name or UPN of the Entra principal that administers Azure SQL.')
param sqlEntraAdminLogin string = 'esign-sql-admins'

@allowed(['Group', 'User', 'ServicePrincipal'])
@description('Entra principal type used as the Azure SQL administrator.')
param sqlEntraAdminPrincipalType string = 'Group'

@description('Entra object ID for the deployment operator who manages dev secrets and signing keys.')
param operatorObjectId string = sqlEntraAdminObjectId

@allowed(['Group', 'User', 'ServicePrincipal'])
param operatorPrincipalType string = sqlEntraAdminPrincipalType

@description('Tenant ID for the Entra SQL administrator.')
param tenantId string = tenant().tenantId

@description('Additional exact IPv4 addresses allowed to reach Azure SQL, such as a temporary operator IP during bootstrap. NAT egress is added automatically.')
param sqlAllowedIpAddresses array = []

@description('Use a dedicated VNet and NAT Gateway so production Container Apps have one stable outbound IP.')
param enableNatEgress bool = environment == 'prod'

@description('Address space used by the production Container Apps virtual network.')
param containerAppsVnetAddressPrefix string = '10.42.0.0/16'

@description('Dedicated delegated subnet used by the Container Apps environment.')
param containerAppsSubnetAddressPrefix string = '10.42.0.0/24'

@description('Container Apps environment resource name. Set a new name when replacing an environment network boundary.')
param containerEnvironmentName string = 'cae-${prefix}-${environment}'

@description('Container image references supplied by CI after the first image build.')
param webImage string
param apiImage string
param pdfFinalizerImage string

@description('Public HTTPS origin used for staff and signer links, without a trailing slash.')
param publicBaseUrl string

@description('Legacy Entra OIDC provider. Configure both values or leave both blank.')
param entraTenantId string = ''
param entraClientId string = ''
@description('Provider-neutral OIDC verifier definitions. Do not place client secrets in this JSON.')
param oidcProvidersJson string = '[]'
@allowed(['native', 'documenso'])
param signingEngineProvider string = 'native'
@description('Stable non-secret ID used to map workspaces and envelopes to this signing provider connection.')
param signingProviderConnectionId string = 'default-signing-provider'
@description('Documenso origin or API v2 base URL. Required when signingEngineProvider is documenso.')
param documensoBaseUrl string = ''
@secure()
param documensoApiToken string = ''
@secure()
param documensoWebhookSecret string = ''
@description('Customer-managed Azure Communication Services Email domain.')
param acsEmailDomainName string = 'esign.kevv.ai'
@description('Optional existing verified ACS Email domain resource ID. When supplied, production links it instead of provisioning a duplicate domain.')
param existingAcsEmailDomainResourceId string = ''
@description('Optional sender override. Leave blank to use esign@ on the customer-managed email domain.')
param acsEmailSender string = ''

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

resource registryIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-acr-${stem}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('acr${compact}${uniqueString(subscription().id, resourceGroup().id)}', 50)
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
  }
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
  properties: union(
    { publicAccess: 'None' },
    environment == 'prod' ? {
      immutableStorageWithVersioning: { enabled: true }
    } : {}
  )
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

resource emailService 'Microsoft.Communication/emailServices@2025-09-01' = {
  name: take('email-${stem}-${uniqueString(resourceGroup().id)}', 63)
  location: 'global'
  tags: tags
  properties: { dataLocation: 'United States' }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2025-09-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource customEmailDomain 'Microsoft.Communication/emailServices/domains@2025-09-01' = if (empty(existingAcsEmailDomainResourceId)) {
  parent: emailService
  name: acsEmailDomainName
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'CustomerManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource esignSenderUsername 'Microsoft.Communication/emailServices/domains/senderUsernames@2025-09-01' = if (empty(existingAcsEmailDomainResourceId)) {
  parent: customEmailDomain
  name: 'esign'
  properties: {
    username: 'esign'
    displayName: 'Kevv eSign'
  }
}

resource communicationService 'Microsoft.Communication/communicationServices@2025-09-01' = {
  name: take('acs-${stem}-${uniqueString(resourceGroup().id)}', 63)
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'United States'
    disableLocalAuth: false
    linkedDomains: [
      emailDomain.id
      empty(existingAcsEmailDomainResourceId) ? customEmailDomain!.id : existingAcsEmailDomainResourceId
    ]
    publicNetworkAccess: 'Enabled'
  }
}

var resolvedAcsEmailSender = empty(acsEmailSender)
  ? 'esign@${acsEmailDomainName}'
  : acsEmailSender

resource communicationDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'acs-email-delivery-logs'
  scope: communicationService
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        category: 'EmailSendMailOperational'
        enabled: true
      }
      {
        category: 'EmailStatusUpdateOperational'
        enabled: true
      }
    ]
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

resource acsEmailSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'acs-email-connection-string'
  properties: { value: communicationService.listKeys().primaryConnectionString }
}

resource documensoTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (signingEngineProvider == 'documenso') {
  parent: keyVault
  name: 'documenso-api-token'
  properties: { value: documensoApiToken }
}

resource documensoHookSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (signingEngineProvider == 'documenso') {
  parent: keyVault
  name: 'documenso-webhook-secret'
  properties: { value: documensoWebhookSecret }
}

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: 'sql-${stem}-${take(uniqueString(resourceGroup().id, sqlLocation), 6)}'
  location: sqlLocation
  tags: tags
  properties: {
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      login: sqlEntraAdminLogin
      principalType: sqlEntraAdminPrincipalType
      sid: sqlEntraAdminObjectId
      tenantId: tenantId
    }
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    restrictOutboundNetworkAccess: 'Disabled'
    version: '12.0'
  }
}

resource natPublicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (enableNatEgress) {
  name: 'pip-nat-${stem}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = if (enableNatEgress) {
  name: 'nat-${stem}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [{ id: natPublicIp!.id }]
  }
}

resource containerAppsVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = if (enableNatEgress) {
  name: 'vnet-${stem}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [containerAppsVnetAddressPrefix] }
  }
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = if (enableNatEgress) {
  parent: containerAppsVnet
  name: 'snet-container-apps'
  properties: {
    addressPrefix: containerAppsSubnetAddressPrefix
    delegations: [
      {
        name: 'container-apps-environment'
        properties: { serviceName: 'Microsoft.App/environments' }
      }
    ]
    natGateway: { id: natGateway.id }
  }
}

resource sqlFirewallRules 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = [
  for (ipAddress, index) in sqlAllowedIpAddresses: {
    parent: sqlServer
    name: 'AllowExactIp${index}'
    properties: {
      startIpAddress: ipAddress
      endIpAddress: ipAddress
    }
  }
]

resource sqlNatFirewallRule 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = if (enableNatEgress) {
  parent: sqlServer
  name: 'AllowContainerAppsNat'
  properties: {
    startIpAddress: natPublicIp!.properties.ipAddress
    endIpAddress: natPublicIp!.properties.ipAddress
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: 'esign'
  location: sqlLocation
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
  properties: union({
    requestedBackupStorageRedundancy: environment == 'prod' ? 'Geo' : 'Local'
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    isLedgerOn: true
    readScale: 'Disabled'
    zoneRedundant: false
  }, environment == 'prod' ? { autoPauseDelay: -1 } : {})
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvironmentName
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
    vnetConfiguration: enableNatEgress ? {
      infrastructureSubnetId: containerAppsSubnet.id
      internal: false
    } : {}
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-api-${stem}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workloadIdentity.id}': {}
      '${registryIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: concat([
        {
          name: 'session-secret'
          keyVaultUrl: sessionSecret.properties.secretUriWithVersion
          identity: workloadIdentity.id
        }
        {
          name: 'acs-email'
          keyVaultUrl: acsEmailSecret.properties.secretUriWithVersion
          identity: workloadIdentity.id
        }
      ], signingEngineProvider == 'documenso' ? [
        {
          name: 'documenso-api-token'
          keyVaultUrl: documensoTokenSecret!.properties.secretUriWithVersion
          identity: workloadIdentity.id
        }
        {
          name: 'documenso-webhook-secret'
          keyVaultUrl: documensoHookSecret!.properties.secretUriWithVersion
          identity: workloadIdentity.id
        }
      ] : [])
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
      ingress: {
        external: false
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
          env: concat([
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AZURE_CLIENT_ID', value: workloadIdentity.properties.clientId }
            { name: 'PORT', value: '4100' }
            { name: 'DATABASE_DRIVER', value: 'azure-sql' }
            { name: 'STORAGE_DRIVER', value: 'azure' }
            { name: 'SIGNING_DRIVER', value: 'azure' }
            { name: 'EMAIL_DRIVER', value: 'azure' }
            { name: 'WEB_ORIGIN', value: publicBaseUrl }
            { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'LAUNCH_SESSION_TTL_SECONDS', value: '300' }
            { name: 'STAFF_SESSION_TTL_SECONDS', value: '3600' }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'OIDC_PROVIDERS_JSON', value: oidcProvidersJson }
            { name: 'SIGNING_ENGINE_PROVIDER', value: signingEngineProvider }
            { name: 'SIGNING_PROVIDER_CONNECTION_ID', value: signingProviderConnectionId }
            { name: 'ACS_EMAIL_CONNECTION_STRING', secretRef: 'acs-email' }
            { name: 'ACS_EMAIL_SENDER', value: resolvedAcsEmailSender }
            { name: 'AZURE_SQL_CONNECTION_STRING', value: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Initial Catalog=${database.name};Authentication=Active Directory Integrated;Client Id=${workloadIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_KEY_VAULT_URL', value: keyVault.properties.vaultUri }
            { name: 'CLAMAV_HOST', value: '127.0.0.1' }
            { name: 'CLAMAV_PORT', value: '3310' }
          ], signingEngineProvider == 'documenso' ? [
            { name: 'DOCUMENSO_BASE_URL', value: documensoBaseUrl }
            { name: 'DOCUMENSO_API_TOKEN', secretRef: 'documenso-api-token' }
            { name: 'DOCUMENSO_WEBHOOK_SECRET', secretRef: 'documenso-webhook-secret' }
            { name: 'DOCUMENSO_REQUEST_TIMEOUT_MS', value: '15000' }
          ] : [])
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
  dependsOn: [registryPull, vaultSecretsUser]
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-web-${stem}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${registryIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
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
      scale: { minReplicas: environment == 'prod' ? 1 : 0, maxReplicas: 3 }
    }
  }
  dependsOn: [registryPull]
}

resource pdfJob 'Microsoft.App/jobs@2025-07-01' = {
  name: 'job-pdf-${stem}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${finalizerIdentity.id}': {}
      '${registryIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      registries: [{ server: registry.properties.loginServer, identity: registryIdentity.id }]
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
          rules: [
            {
              name: 'pdf-finalize'
              type: 'azure-servicebus'
              metadata: {
                namespace: serviceBus.name
                queueName: finalizeQueue.name
                messageCount: '1'
              }
              identity: finalizerIdentity.id
            }
          ]
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
            { name: 'AZURE_CLIENT_ID', value: finalizerIdentity.properties.clientId }
            { name: 'AZURE_SQL_CONNECTION_STRING', value: 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Initial Catalog=${database.name};Authentication=Active Directory Integrated;Client Id=${finalizerIdentity.properties.clientId};Encrypt=True;TrustServerCertificate=False;' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AZURE_KEY_VAULT_URL', value: keyVault.properties.vaultUri }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
    }
  }
  dependsOn: [registryPull, finalizerVaultCryptoUser, serviceBusReceiver]
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, registryIdentity.id, 'acr-pull')
  scope: registry
  properties: {
    principalId: registryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
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

resource finalizerBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, finalizerIdentity.id, 'blob-data-owner')
  scope: storage
  properties: {
    principalId: finalizerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
  }
}

resource vaultCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, workloadIdentity.id, 'crypto-user')
  scope: keyVault
  properties: {
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')
  }
}

resource finalizerVaultCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
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

resource vaultOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, operatorObjectId, 'vault-administrator')
  scope: keyVault
  properties: {
    principalId: operatorObjectId
    principalType: operatorPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '00482a5a-887f-4fb3-b363-3b7fe8e74483')
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

resource serviceBusReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, finalizerIdentity.id, 'receiver')
  scope: serviceBus
  properties: {
    principalId: finalizerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output webFqdn string = web.properties.configuration.ingress.fqdn
output storageAccount string = storage.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output keyVaultUri string = keyVault.properties.vaultUri
output serviceBusNamespace string = serviceBus.name
output containerRegistry string = registry.name
output containerRegistryServer string = registry.properties.loginServer
output acsEmailSender string = resolvedAcsEmailSender
output workloadIdentityName string = workloadIdentity.name
output finalizerIdentityName string = finalizerIdentity.name
output natOutboundIp string = enableNatEgress ? natPublicIp!.properties.ipAddress : ''
