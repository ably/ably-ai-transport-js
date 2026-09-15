/**
 * The model behind the route: a mock that echoes the prompt back in pieces
 * when `MOCK_LLM=1`, so the demo streams without a provider; otherwise
 * Anthropic or OpenAI, whichever key is set.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

// The v3 member of the SDK's `LanguageModel` union, and the stream it produces.
type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type Prompt = Parameters<LanguageModelV3['doStream']>[0]['prompt'];
type ModelStream = Awaited<ReturnType<LanguageModelV3['doStream']>>['stream'];

const lastUserText = (prompt: Prompt): string => {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Stream `text` in small pieces, one delta every 150ms, so the appends are visible. */
const streamOf = (text: string, abortSignal: AbortSignal | undefined): ModelStream =>
  new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      const id = `txt-${crypto.randomUUID()}`;
      controller.enqueue({ type: 'text-start', id });
      for (let i = 0; i < text.length; i += 12) {
        if (abortSignal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        controller.enqueue({ type: 'text-delta', id, delta: text.slice(i, i + 12) });
        await sleep(150);
      }
      controller.enqueue({ type: 'text-end', id });
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 16, text: 16, reasoning: 0 },
        },
      });
      controller.close();
    },
  });

const createMockModel = (): LanguageModel =>
  new MockLanguageModelV3({
    modelId: 'mock-llm',
    doStream: async ({ prompt, abortSignal }) => ({
      stream: streamOf(`You said: "${lastUserText(prompt)}". This reply is streamed over Ably one append at a time.`, abortSignal),
    }),
  });

export function createModel(): LanguageModel {
  if (process.env.MOCK_LLM === '1') return createMockModel();
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6');
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
  }
  throw new Error('No model configured. Set MOCK_LLM=1, ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}
