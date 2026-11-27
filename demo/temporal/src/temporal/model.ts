/**
 * The model the worker's model Activities call: a mock that echoes the
 * prompt back in pieces when `MOCK_LLM=1`, so the demo streams without a
 * provider; otherwise Anthropic or OpenAI, whichever key is set. The
 * workflow asks for it by the id `chat`, so only the worker knows which.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { customProvider, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type Prompt = Parameters<LanguageModelV4['doStream']>[0]['prompt'];
type ModelStream = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'];

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
const streamOf = (text: string): ModelStream =>
  new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      const id = `txt-${crypto.randomUUID()}`;
      controller.enqueue({ type: 'text-start', id });
      for (let i = 0; i < text.length; i += 12) {
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

const createModel = (): LanguageModel => {
  if (process.env.MOCK_LLM === '1') {
    return new MockLanguageModelV4({
      modelId: 'mock-llm',
      doStream: async ({ prompt }) => ({
        stream: streamOf(
          `You said: "${lastUserText(prompt)}". A Temporal workflow wrote this, and the relay streamed it to Ably.`,
        ),
      }),
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
      process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    );
  }
  if (process.env.OPENAI_API_KEY) {
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
  }
  throw new Error('No model configured. Set MOCK_LLM=1, ANTHROPIC_API_KEY or OPENAI_API_KEY.');
};

/** The provider for the AI SDK plugin, with the model under the id the workflow asks for. */
export const createModelProvider = () => customProvider({ languageModels: { chat: createModel() } });
