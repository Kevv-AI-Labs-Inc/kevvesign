import { describe, expect, it } from 'vitest';
import { preparePersonalAzureUpdate } from '../prepare-azure-update.mjs';

const app = {
  name: 'ca-documenso-kevvesign-dev',
  id: '/subscriptions/test/resourceGroups/rg-kevvesign-dev/providers/Microsoft.App/containerApps/ca-documenso-kevvesign-dev',
  identity: { type: 'SystemAssigned' },
  properties: {
    configuration: {
      ingress: { customDomains: [{ name: 'documenso.kevv.ai', certificateId: 'unchanged-cert' }] },
      secrets: ['personal-google-client-secret', 'personal-portal-service-token'].map((name) => ({
        name,
        keyVaultUrl: `https://test.vault.azure.net/secrets/${name}`,
        identity: 'system',
      })),
    },
    template: {
      scale: { minReplicas: 1 },
      containers: [
        {
          name: 'documenso',
          image: 'old-pinned-image',
          env: [
            { name: 'NEXT_PUBLIC_WEBAPP_URL', value: 'https://documenso.kevv.ai' },
            { name: 'NEXT_PRIVATE_DATABASE_URL', secretRef: 'original-db' },
            { name: 'NEXT_PRIVATE_ENCRYPTION_KEY', secretRef: 'original-key' },
          ],
        },
      ],
    },
  },
};
const options = {
  image: `registry.example.test/homix-personal@sha256:${'a'.repeat(64)}`,
  googleClientId: '123-test.apps.googleusercontent.com',
};
describe('personal-only deployment guard', () => {
  it('preserves unrelated settings and never mutates the input', () => {
    const result = preparePersonalAzureUpdate(app, options);
    expect(app.properties.template.containers[0].image).toBe('old-pinned-image');
    expect(result.identity).toEqual(app.identity);
    expect(result.properties.configuration).toEqual(app.properties.configuration);
    expect(result.properties.template.scale).toEqual(app.properties.template.scale);
    expect(result.properties.template.containers[0].env).toContainEqual({
      name: 'NEXT_PRIVATE_DATABASE_URL',
      secretRef: 'original-db',
    });
    expect(result.properties.template.containers[0].env).toContainEqual({
      name: 'NEXT_PUBLIC_DISABLE_SIGNUP',
      value: 'true',
    });
    expect(result.properties.template.containers[0].env).toContainEqual({
      name: 'NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNIN',
      value: 'true',
    });
  });
  it('refuses the company resource, shared domain, non-pinned image and absent secret references', () => {
    expect(() =>
      preparePersonalAzureUpdate({ ...app, name: 'ca-documenso-kevvesign-prod' }, options),
    ).toThrow();
    expect(() =>
      preparePersonalAzureUpdate(
        { ...app, id: app.id.replace('rg-kevvesign-dev', 'rg-kevvesign-prod') },
        options,
      ),
    ).toThrow();
    const shared = structuredClone(app);
    shared.properties.configuration.ingress.customDomains.push({
      name: 'esign.kevv.ai',
      certificateId: 'company',
    });
    expect(() => preparePersonalAzureUpdate(shared, options)).toThrow();
    expect(() =>
      preparePersonalAzureUpdate(app, { ...options, image: 'documenso/documenso:latest' }),
    ).toThrow();
    const missing = structuredClone(app);
    missing.properties.configuration.secrets = [];
    expect(() => preparePersonalAzureUpdate(missing, options)).toThrow();
  });
});
