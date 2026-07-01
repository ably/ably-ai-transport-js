import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // jsdom disables Web Storage for opaque origins; give the document a
    // concrete origin so a browser-like environment is available.
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    // jsdom v26 under vitest exposes `localStorage` without the standard
    // Storage methods; the setup file installs a minimal in-memory polyfill so
    // the DebugPane's localStorage-backed persistence works under test.
    setupFiles: ['./vitest.setup.ts'],
  },
});
