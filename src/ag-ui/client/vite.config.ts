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
    outDir: '../../../dist/ag-ui/client',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportAGUIClient',
      fileName: 'ably-ai-transport-ag-ui-client',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['@ably/pubsub-core', '@ag-ui/client', 'rxjs'],
      output: {
        globals: {
          '@ably/pubsub-core': 'AblyPubSub',
          '@ag-ui/client': 'AGUIClient',
          rxjs: 'rxjs',
        },
      },
    },
    sourcemap: true,
  },
});
