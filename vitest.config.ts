import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The integration tier needs a real Ably sandbox app, so this one stays
    // mocks-only and fast.
    exclude: ['**/*.integration.test.ts', '**/*.integration.test.tsx'],
    setupFiles: ['test/helper/expectations.ts'],
    coverage: {
      enabled: false,
      include: ['src/**/*'],
      exclude: ['**/vite.config.ts'],
      reporter: ['text', 'html', 'json-summary', 'json'],
      reportOnFailure: true,
      provider: 'v8',
      ignoreEmptyLines: true,
    },
  },
});
