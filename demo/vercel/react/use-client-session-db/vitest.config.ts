import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig `@/*` -> `./src/*` path alias so app-relative imports
  // resolve the same way under Vitest as they do in the Next.js build.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // The shared UI package ships raw TSX from node_modules; inline it so Vitest
    // transforms it (Node cannot load .tsx) and the chat test renders the real
    // ChatShell / LinearMessageList / DebugPane.
    server: {
      deps: {
        inline: ['@ably-ai-demos/frontend'],
      },
    },
    // Polyfill a working `localStorage` — the jsdom build here exposes one
    // whose methods aren't callable (the DebugPane persists its open state to
    // it). See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
