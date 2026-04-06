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
    outDir: '../../dist/anthropic',
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'AblyAiTransportAnthropic',
      fileName: 'ably-ai-transport-anthropic',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['ably', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'],
      output: {
        globals: {
          ably: 'Ably',
          '@anthropic-ai/claude-agent-sdk': 'AnthropicAgentSDK',
          '@anthropic-ai/sdk': 'AnthropicSDK',
        },
      },
    },
    sourcemap: true,
  },
});
