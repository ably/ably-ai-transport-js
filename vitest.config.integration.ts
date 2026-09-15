import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // The tier is empty until the transport is rebuilt on the new contract, and
    // vitest treats an empty include as a failure.
    passWithNoTests: true,
    globalSetup: ['test/helper/test-setup.ts'],
    setupFiles: ['test/helper/expectations.ts'],
    testTimeout: 30_000,
  },
});
