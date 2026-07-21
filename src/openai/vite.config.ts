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
    outDir: '../../dist/openai',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportOpenAI',
      fileName: 'ably-ai-transport-openai',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', 'openai'],
      output: {
        globals: {
          ably: 'Ably',
          openai: 'OpenAI',
        },
      },
    },
    sourcemap: true,
  },
});
