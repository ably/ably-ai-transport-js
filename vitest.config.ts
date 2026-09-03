import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The other two tiers need something real — an Ably sandbox app, or a
    // Temporal dev server — so this one stays mocks-only and fast.
    exclude: ['**/*.integration.test.ts', '**/*.temporal.test.ts'],
    setupFiles: ['test/helper/expectations.ts'],
    coverage: {
      enabled: false,
      include: ['src/**/*'],
      exclude: ['**/index.ts', '**/vite.config.ts'],
      reporter: ['text', 'html', 'json-summary', 'json'],
      reportOnFailure: true,
      provider: 'v8',
      ignoreEmptyLines: true,
    },
  },
});
