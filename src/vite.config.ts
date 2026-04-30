import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  root: resolve(__dirname, '.'),
  plugins: [
    dts({
      entryRoot: resolve(__dirname, '.'),
      insertTypesEntry: true,
      exclude: ['react/**', 'vercel/**'],
    }),
  ],
  build: {
    outDir: '../dist',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransport',
      fileName: 'ably-ai-transport',
    },
    rollupOptions: {
      external: ['ably'],
      output: {
        globals: {
          ably: 'Ably',
        },
      },
    },
    sourcemap: true,
  },
});
