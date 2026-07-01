import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Polyfill a working `localStorage` — the jsdom build here exposes one
    // whose methods aren't callable (the DebugPane persists its open state to
    // it). See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
