import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The other tiers need real infrastructure — an Ably sandbox app, or a
    // Temporal test server — so this one stays mocks-only and fast.
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
