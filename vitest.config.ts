import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts'],
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
