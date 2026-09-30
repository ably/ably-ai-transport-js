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
    outDir: '../../dist/ag-ui',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportAGUI',
      fileName: 'ably-ai-transport-ag-ui',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', '@ag-ui/core'],
      output: {
        globals: {
          ably: 'Ably',
          '@ag-ui/core': 'AGUI',
        },
      },
    },
    sourcemap: true,
  },
});
