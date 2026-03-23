import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts'],
    setupFiles: ['test/helper/expectations.ts'],
  },
});
