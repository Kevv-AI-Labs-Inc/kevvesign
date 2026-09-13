targetScope = 'resourceGroup'
param location string = 'centralus'
param environmentName string = 'cae-kevvesign-signing-prod'
param keyVaultName string = 'kv-kevvesign-prod-umwk4u'
param registryName string = 'acrkevvesignprodcz3a2u4wwz27c'
param image string
@secure()
param outputEncryptionKey string
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: 'id-ca-documenso-kevvesign-prod' }
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','7f951dda-4ed3-4680-a7ca-43fe172d538d') }
}
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-signing-native-bootstrap'
  location: location
  tags: { application: 'esign', purpose: 'temporary-native-identity-bootstrap', managedBy: 'bicep' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${vault.properties.vaultUri}secrets/documenso-prod-database-url', identity: identity.id }
        { name: 'output-encryption-key', value: outputEncryptionKey }
      ]
    }
    template: {
      containers: [{
        name: 'bootstrap'
        image: image
        command: ['node', '/app/bootstrap.mjs']
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'NEXT_PRIVATE_DATABASE_URL', secretRef: 'database-url' }
          { name: 'NEXT_PRIVATE_DIRECT_DATABASE_URL', secretRef: 'database-url' }
          { name: 'NEXT_PUBLIC_FEATURE_BILLING_ENABLED', value: 'false' }
          { name: 'HOMIX_BOOTSTRAP_PRODUCTION', value: 'confirmed-si-zhang-20260912' }
          { name: 'HOMIX_BOOTSTRAP_OUTPUT_KEY', secretRef: 'output-encryption-key' }
        ]
        resources: { cpu: json('0.5'), memory: '1Gi' }
      }]
    }
  }
  dependsOn: [pull]
}
