import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // The tier is empty until the transport is rebuilt on the new contract, and
    // vitest treats an empty include as a failure.
    passWithNoTests: true,
    globalSetup: ['test/helper/test-setup.ts'],
    setupFiles: ['test/helper/expectations.ts'],
    // The tier's real deadline. Eleven tests used to repeat `45_000` as a
    // per-test timeout, which meant the config's own value never applied; the
    // repeats are gone and the number lives here instead. It is not a response
    // to anything getting slower.
    testTimeout: 45_000,
  },
});
