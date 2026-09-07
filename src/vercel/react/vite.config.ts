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
    {
      // The react layer is external: this entry layers on top of
      // `@ably/ai-transport/react` and must share its module instances — the
      // ClientTransportContext in particular. Bundling a second copy here
      // would give the provider and the hooks different context objects, and
      // a component under ChatTransportProvider could never resolve the
      // transport registered by it. Map the source-relative import onto the
      // package's own entry so the emitted bundle imports the built one.
      name: 'externalize-react-layer',
      enforce: 'pre' as const,
      resolveId(source: string) {
        if (/^\.\.?\/.*\/react\/index\.js$/.test(source)) {
          return { id: '@ably/ai-transport/react', external: true };
        }
        return null;
      },
    },
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
      // The react layer is external: this entry layers on top of
      // `@ably/ai-transport/react` and must share its module instances — the
      // ClientTransportContext in particular. Bundling a second copy here
      // would give the provider and the hooks different context objects, and
      // a component under ChatTransportProvider could never resolve the
      // transport registered by it.
      // `ai` is a peer too: the provider reaches `readUIMessageStream`
      // transitively through the chat transport, so leaving it in bundles the
      // peer dependency (and zod under it) and hands a consumer two `ai`
      // instances. The sibling entry points externalise it for the same
      // reason.
      external: [
        'ably',
        'ably/react',
        'ai',
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        '@ably/ai-transport/react',
      ],
      output: {
        globals: {
          ably: 'Ably',
          'ably/react': 'AblyReact',
          ai: 'AI',
          react: 'React',
          'react/jsx-runtime': 'ReactJsxRuntime',
          'react/jsx-dev-runtime': 'ReactJsxDevRuntime',
          '@ably/ai-transport/react': 'AblyAiTransportReact',
        },
      },
    },
    sourcemap: true,
  },
});
