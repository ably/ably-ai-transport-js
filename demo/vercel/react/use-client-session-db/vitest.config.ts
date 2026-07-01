import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig `@/*` -> `./src/*` path alias so component tests can
  // import shadcn/ui modules (`@/components/ui/*`, `@/lib/utils`) the same way
  // the app does.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Polyfill a working `localStorage` — the jsdom build here exposes one
    // whose methods aren't callable (the DebugPane persists its open state to
    // it). See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
