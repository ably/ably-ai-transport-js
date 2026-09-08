import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.temporal.test.ts'],
    setupFiles: ['test/helper/expectations.ts'],
    // Each file boots a throwaway Temporal test server and bundles workflow code
    // with webpack, so these are slow by nature. No Ably globalSetup: these tests
    // mock the framing activities and never touch a channel.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
