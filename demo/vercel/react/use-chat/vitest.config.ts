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
    setupFiles: ['./vitest.setup.ts'],
  },
});
