/**
 * Deterministic mock language model for the e2e tests.
 *
 * `createMockModel()` returns a Vercel AI SDK language model whose token output
 * is scripted from the prompt; `createModel()` returns it when `MOCK_LLM` is
 * set. Only token generation is mocked: `streamText`, tool execution,
 * suspend/continuation, `toUIMessageStream` and the Ably publish run normally.
 *
 * Responses by prompt:
 * - `Say "X"` / `... the word X`        -> replies `X`
 * - `what's the weather like?`          -> `getLocation` (client tool, suspends),
 *   then a weather sentence on the continuation
 * - `... weather forecast for <place>?` -> `getWeatherForecast` (approval,
 *   suspends), then a forecast sentence (or an acknowledgement if denied)
 * - `... a long story about a dragon`   -> a long, slowly streamed, abort-aware
 *   reply for the cancel test
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

/**
 * High-level description of what the mock should emit for one `doStream` call.
 * `planResponse` turns the prompt into one of these; the stream builder turns
 * it into concrete SDK stream parts.
 */
type ResponsePlan =
  | { kind: 'text'; text: string; slow?: boolean }
  | { kind: 'tool'; toolName: string; input: Record<string, unknown> };

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

/** True if any message carries a tool result for the named tool. */
function hasToolResultFor(prompt: ModelPrompt, toolName: string): boolean {
  for (const message of prompt) {
    if (message.role !== 'assistant' && message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === toolName) return true;
    }
  }
  return false;
}

/** True if any assistant message already proposed a call to the named tool. */
function hasToolCallFor(prompt: ModelPrompt, toolName: string): boolean {
  for (const message of prompt) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call' && part.toolName === toolName) return true;
    }
  }
  return false;
}

/** Whether a tool-approval-response is present, and whether it was a denial. */
function approvalState(prompt: ModelPrompt): { responded: boolean; denied: boolean } {
  let responded = false;
  let denied = false;
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-approval-response') continue;
      responded = true;
      if (!part.approved) denied = true;
    }
  }
  return { responded, denied };
}

/** Pull a place name out of a "... for <place>?" prompt, defaulting to London. */
function extractLocation(text: string): string {
  const match = /\bfor\s+([A-Za-z][A-Za-z .,'-]*?)\s*[?.!]?$/.exec(text.trim());
  return match ? match[1].trim() : 'London, UK';
}

/** Decide what the mock model should produce for the given prompt. */
function planResponse(prompt: ModelPrompt): ResponsePlan {
  const text = lastUserText(prompt);
  const lower = text.toLowerCase();

  // Forecast must be checked before plain weather (it contains "weather").
  if (lower.includes('forecast')) {
    const resolved =
      hasToolCallFor(prompt, 'getWeatherForecast') ||
      hasToolResultFor(prompt, 'getWeatherForecast') ||
      approvalState(prompt).responded;
    if (resolved) {
      const { denied } = approvalState(prompt);
      return denied
        ? { kind: 'text', text: 'No problem, I will not fetch the forecast.' }
        : { kind: 'text', text: `Here is the 5-day forecast for ${extractLocation(text)}.` };
    }
    return { kind: 'tool', toolName: 'getWeatherForecast', input: { location: extractLocation(text) } };
  }

  if (lower.includes('weather')) {
    if (hasToolResultFor(prompt, 'getLocation')) {
      return { kind: 'text', text: 'It is currently sunny and about 72°F at your location.' };
    }
    return { kind: 'tool', toolName: 'getLocation', input: { highAccuracy: false } };
  }

  // "reply with the word X" / "reply with just the word X".
  const wordMatch = /\bword\s+([A-Za-z0-9]+)/i.exec(text);
  if (wordMatch) return { kind: 'text', text: wordMatch[1] };

  // Say "X" as your entire reply.
  const sayMatch = /\bsay\s+["“]([^"”]+)["”]/i.exec(text);
  if (sayMatch) return { kind: 'text', text: sayMatch[1] };

  // A long story to stream slowly so the cancel test can interrupt it.
  if (/\b(story|dragon)\b/i.test(lower)) {
    return { kind: 'text', slow: true, text: LONG_STORY };
  }

  // Acknowledge a marker token if present.
  const markerMatch = /\bmarker\s+([^\s.]+)/i.exec(text);
  if (markerMatch) return { kind: 'text', text: `Acknowledged marker ${markerMatch[1]}.` };

  return { kind: 'text', text: 'Done.' };
}

const LONG_STORY =
  'Once upon a time, in a kingdom of glass towers, there lived a dragon who hoarded ' +
  'not gold but unfinished stories. Every night it would unfurl its wings over the ' +
  'sleeping city, and every morning the people woke with a new beginning on their ' +
  'tongues and no ending in sight. The dragon grew restless, for a story without an ' +
  'ending is a heavy thing to carry, and it had carried thousands. So it set out, ' +
  'one cold dawn, to find a single person brave enough to finish just one of them.';

// Fixed token usage; values are irrelevant to the tests, the shape must match
// the SDK's v3 usage type (nested input/output token breakdowns).
const TOKEN_USAGE = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 16, text: 16, reasoning: 0 },
};

/** Split text into ~20-character pieces so the stream emits many deltas. */
function streamingPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += 20) pieces.push(text.slice(i, i + 20));
  return pieces;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Build the SDK stream of parts for a plan, honouring the abort signal. */
function buildStream(plan: ResponsePlan, abortSignal: AbortSignal | undefined): ModelStream {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });

      if (plan.kind === 'tool') {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: `mock-${plan.toolName}-${crypto.randomUUID()}`,
          toolName: plan.toolName,
          input: JSON.stringify(plan.input),
        });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: TOKEN_USAGE,
        });
        controller.close();
        return;
      }

      const id = `txt-${crypto.randomUUID()}`;
      controller.enqueue({ type: 'text-start', id });
      const pieces = plan.slow ? streamingPieces(plan.text) : [plan.text];
      for (const delta of pieces) {
        if (abortSignal?.aborted) {
          // Mirror a real provider whose request is aborted mid-stream.
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        controller.enqueue({ type: 'text-delta', id, delta });
        if (plan.slow) await sleep(250);
      }
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
