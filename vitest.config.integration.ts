import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/helper/test-setup.ts'],
    setupFiles: ['test/helper/expectations.ts'],
    testTimeout: 30_000,
  },
});
