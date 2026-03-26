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
    outDir: '../../../dist/vercel/react',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportVercelReact',
      fileName: 'ably-ai-transport-vercel-react',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', 'ai', 'react'],
      output: {
        globals: {
          ably: 'Ably',
          ai: 'AI',
          react: 'React',
        },
      },
    },
    sourcemap: true,
  },
});
