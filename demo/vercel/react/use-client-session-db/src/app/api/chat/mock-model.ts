/**
 * Deterministic mock language model for the e2e tests.
 *
 * `createMockModel()` returns a Vercel AI SDK language model whose token output
 * is scripted from the prompt; `createModel()` returns it when `MOCK_LLM` is
 * set. Only token generation is mocked: `streamText`, `toUIMessageStream` and
 * the Ably publish run normally.
 *
 * This demo is text-only (it showcases database hydration, not tools), so the
 * mock only ever emits text:
 * - `Say "X"` / `... the word X` -> replies `X`
 * - `... marker X`               -> `Acknowledged marker X.`
 * - anything else                -> `Done.`
 *
 * Ids use `crypto.randomUUID` and never affect assertions.
 */

import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';

// Derive the exact SDK types from the publicly exported `LanguageModel` union
// rather than redefining them or importing from a non-direct dependency
// (`@ai-sdk/provider` is not hoisted under pnpm). `LanguageModel` is
// `string | LanguageModelV3 | LanguageModelV2`; the v3 member is the one we
// implement here.
type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CallOptions = Parameters<LanguageModelV3['doStream']>[0];
type ModelPrompt = CallOptions['prompt'];
type StreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>;
type ModelStream = StreamResult['stream'];

/** Extract the concatenated text of the most recent user message. */
function lastUserText(prompt: ModelPrompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    let text = '';
    for (const part of message.content) {
      if (part.type === 'text') text += part.text;
    }
    return text;
  }
  return '';
}

/** Decide what text the mock model should reply with for the given prompt. */
function planResponse(prompt: ModelPrompt): string {
  const text = lastUserText(prompt);

  // "reply with the word X" / "reply with just the word X".
  const wordMatch = /\bword\s+([A-Za-z0-9]+)/i.exec(text);
  if (wordMatch) return wordMatch[1];

  // Say "X" as your entire reply.
  const sayMatch = /\bsay\s+["“]([^"”]+)["”]/i.exec(text);
  if (sayMatch) return sayMatch[1];

  // Acknowledge a marker token if present.
  const markerMatch = /\bmarker\s+([^\s.]+)/i.exec(text);
  if (markerMatch) return `Acknowledged marker ${markerMatch[1]}.`;

  return 'Done.';
}

// Fixed token usage; values are irrelevant to the tests, the shape must match
// the SDK's v3 usage type (nested input/output token breakdowns).
const TOKEN_USAGE = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 16, text: 16, reasoning: 0 },
};

/** Build the SDK stream of text parts for a reply, honouring the abort signal. */
function buildStream(reply: string, abortSignal: AbortSignal | undefined): ModelStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (abortSignal?.aborted) {
        // Mirror a real provider whose request is aborted before it starts.
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const id = `txt-${crypto.randomUUID()}`;
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta: reply });
      controller.enqueue({ type: 'text-end', id });
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: TOKEN_USAGE,
      });
      controller.close();
    },
  });
}

/**
 * Create the deterministic mock model. Typed as `LanguageModel` so it is a
 * drop-in for the real provider models returned by `createModel()`.
 */
export function createMockModel(): LanguageModel {
  return new MockLanguageModelV3({
    modelId: 'mock-llm',
    doStream: (options: CallOptions): Promise<StreamResult> =>
      Promise.resolve({ stream: buildStream(planResponse(options.prompt), options.abortSignal) }),
  });
}
