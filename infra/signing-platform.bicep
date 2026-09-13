targetScope = 'resourceGroup'
@description('Region with confirmed PostgreSQL subscription capacity; separate from legacy resources.')
param location string = 'centralus'
param postgresServerName string = 'pg-kevvesign-signing-prod'
param administratorLogin string = 'signingbootstrap'
@secure()
param administratorPassword string
param environmentName string = 'cae-kevvesign-signing-prod'
param virtualNetworkName string = 'vnet-kevvesign-signing-prod'
param logAnalyticsWorkspaceName string = 'log-kevvesign-signing-prod'
param skuName string = 'Standard_B2s'
var tags = { application: 'esign', environment: 'production', managedBy: 'bicep', engine: 'documenso' }
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.44.0.0/16'] }
    subnets: [
      { name: 'snet-container-apps', properties: { addressPrefix: '10.44.0.0/23', delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }] } }
      { name: 'snet-postgres', properties: { addressPrefix: '10.44.2.0/24', delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }] } }
    ]
  }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'esign-prod.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: 'signing-production'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
    vnetConfiguration: { infrastructureSubnetId: '${network.id}/subnets/snet-container-apps' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
  }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: { name: skuName, tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: '${network.id}/subnets/snet-postgres'
      privateDnsZoneArmResourceId: dns.id
    }
  }
  dependsOn: [dnsLink]
}
resource documensoDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'documenso'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource bridgeDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'esign_bridge'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output containerAppsEnvironmentName string = environment.name
output containerAppsDefaultDomain string = environment.properties.defaultDomain
