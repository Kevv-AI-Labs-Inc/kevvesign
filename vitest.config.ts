import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/bridge/**/*.test.ts',
      'apps/personal-documenso/**/*.test.ts',
      'apps/company-documenso/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Unit coverage covers identity, wire contracts and package rules.
      // SQL/orchestration is exercised against real Documenso by test:native.
      include: [
        'apps/bridge/src/{auth,config,documenso,model,packages,recipient-access,customer-fields,template-layout,notification-routing}.ts',
        'apps/company-documenso/overlay/packages/lib/server-only/email/notification-recipient.ts',
      ],
      exclude: ['**/__tests__/**', '**/cli/**', '**/main.ts'],
      thresholds: { lines: 75, functions: 75, branches: 70, statements: 75 },
    },
  },
});
