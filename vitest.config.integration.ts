import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // Load .env / .env.local into process.env so integration tests can read
  // credentials they need (e.g. ANTHROPIC_API_KEY for streamText round-trip
  // tests). Empty prefix loads every key, not just VITE_*-prefixed ones.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

  return {
    test: {
      include: ['test/**/*.integration.test.ts'],
      globalSetup: ['test/helper/test-setup.ts'],
      setupFiles: ['test/helper/expectations.ts'],
      testTimeout: 30_000,
    },
  };
});
