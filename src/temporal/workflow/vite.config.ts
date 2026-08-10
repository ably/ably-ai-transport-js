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
    outDir: '../../../dist/temporal/workflow',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportTemporalWorkflow',
      fileName: 'ably-ai-transport-temporal-workflow',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      // `@temporalio/workflow` is the ONLY runtime dependency the workflow
      // sandbox provides. Anything else appearing here means worker-side code
      // has leaked into this bundle.
      external: ['@temporalio/workflow'],
      output: {
        globals: {
          '@temporalio/workflow': 'TemporalWorkflow',
        },
      },
    },
    sourcemap: true,
  },
});
