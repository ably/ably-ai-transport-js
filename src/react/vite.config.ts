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
      external: ['ably', 'ably/react', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      output: {
        globals: {
          ably: 'Ably',
          'ably/react': 'AblyReact',
          react: 'React',
          'react/jsx-runtime': 'ReactJsxRuntime',
          'react/jsx-dev-runtime': 'ReactJsxDevRuntime',
        },
      },
    },
    sourcemap: true,
  },
});
