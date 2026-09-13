targetScope = 'resourceGroup'
param location string = resourceGroup().location
param containerAppsEnvironmentName string
param keyVaultName string
param registryName string
@description('Immutable eSign bridge image digest in the existing ACR.')
param image string
param documensoBaseUrl string
param appName string = 'ca-esign-bridge-prod'
param secretPrefix string = 'esign-bridge-prod'
param customHostname string = ''
param managedCertificateName string = ''
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: containerAppsEnvironmentName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: 'id-${appName}', location: location }
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','7f951dda-4ed3-4680-a7ca-43fe172d538d') }
}
var secrets = [
  { name: 'database-url', env: 'ESIGN_DATABASE_URL' }
  { name: 'credential-key', env: 'ESIGN_CREDENTIAL_KEY' }
  { name: 'portal-clients', env: 'ESIGN_PORTAL_CLIENTS_JSON' }
  { name: 'webhook-secret', env: 'ESIGN_WEBHOOK_SECRET' }
]
resource bridgeSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for secret in secrets: { parent: vault, name: '${secretPrefix}-${secret.name}' }]
resource secretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (secret, i) in secrets: {
  name: guid(bridgeSecrets[i].id, identity.id, 'KeyVaultSecretsUser')
  scope: bridgeSecrets[i]
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','4633458b-17de-408a-b874-0445c86b69e6') }
}]
var secretEnvironment = [for secret in secrets: { name: secret.env, secretRef: secret.name }]
resource bridge 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: { application: 'esign-bridge', environment: 'production', managedBy: 'bicep', engine: 'documenso' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 3
      ingress: {
        external: true
        targetPort: 4100
        transport: 'http'
        allowInsecure: false
        customDomains: empty(customHostname) ? [] : [{ name: customHostname, bindingType: 'SniEnabled', certificateId: resourceId('Microsoft.App/managedEnvironments/managedCertificates',containerAppsEnvironmentName,managedCertificateName) }]
      }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [for secret in secrets: { name: secret.name, keyVaultUrl: '${vault.properties.vaultUri}secrets/${secretPrefix}-${secret.name}', identity: identity.id }]
    }
    template: {
      containers: [{
        name: 'bridge'
        image: image
        env: concat([
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: '4100' }
          { name: 'DOCUMENSO_BASE_URL', value: documensoBaseUrl }
          { name: 'ESIGN_RECONCILE_INTERVAL_MS', value: '60000' }
        ], secretEnvironment)
        resources: { cpu: json('0.5'), memory: '1Gi' }
        probes: [
          { type: 'Liveness', httpGet: { path: '/health/live', port: 4100, scheme: 'HTTP' }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 5 }
          { type: 'Readiness', httpGet: { path: '/health/ready', port: 4100, scheme: 'HTTP' }, initialDelaySeconds: 30, periodSeconds: 15, timeoutSeconds: 5, failureThreshold: 10 }
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [pull,secretAccess]
}
output fqdn string = bridge.properties.configuration.ingress.fqdn
