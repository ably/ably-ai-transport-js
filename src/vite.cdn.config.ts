import { resolve } from 'path';
import { defineConfig } from 'vite';

// Builds the bundle published to the CDN. It bundles @ably/pubsub-core rather
// than reading it from a global, because the Pub/Sub v3 CDN bundle's global
// does not expose EventEmitter.
export default defineConfig({
  root: resolve(__dirname, '.'),
  build: {
    outDir: '../dist/cdn',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransport',
      fileName: 'ably-ai-transport',
      formats: ['umd'],
    },
    sourcemap: true,
  },
});
