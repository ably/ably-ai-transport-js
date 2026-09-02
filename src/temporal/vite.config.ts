import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  root: resolve(__dirname, '.'),
  plugins: [
    dts({
      entryRoot: resolve(__dirname, '.'),
      insertTypesEntry: true,
    }),
  ],
  build: {
    outDir: '../../dist/temporal',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportTemporal',
      fileName: 'ably-ai-transport-temporal',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', '@temporalio/activity'],
      output: {
        globals: {
          ably: 'Ably',
          '@temporalio/activity': 'TemporalActivity',
        },
      },
    },
    sourcemap: true,
  },
});
