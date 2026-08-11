import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@esign/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@esign/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@esign/infrastructure': fileURLToPath(
        new URL('./packages/infrastructure/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/domain/src/**/*.ts',
        'packages/infrastructure/src/**/*.ts',
        'apps/api/src/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*.d.ts', '**/main.ts'],
      thresholds: { lines: 75, functions: 75, branches: 70, statements: 75 },
    },
  },
});
