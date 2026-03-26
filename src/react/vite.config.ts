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
    outDir: '../../dist/react',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportReact',
      fileName: 'ably-ai-transport-react',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', 'react'],
      output: {
        globals: {
          ably: 'Ably',
          react: 'React',
        },
      },
    },
    sourcemap: true,
  },
});
