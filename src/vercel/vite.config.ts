import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  root: resolve(__dirname, '.'),
  plugins: [
    dts({
      entryRoot: resolve(__dirname, '.'),
      insertTypesEntry: true,
      exclude: ['react/**'],
    }),
  ],
  build: {
    outDir: '../../dist/vercel',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportVercel',
      fileName: 'ably-ai-transport-vercel',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', 'ai'],
      output: {
        globals: {
          ably: 'Ably',
          ai: 'AI',
        },
      },
    },
    sourcemap: true,
  },
});
