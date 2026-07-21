/**
 * Model selection for the agent route.
 *
 * Produces a `ReadableStream<ResponseStreamEvent>` for one model turn: the
 * deterministic mock behind `MOCK_LLM` (e2e tests), otherwise a real OpenAI
 * `/responses` stream with the server-executed tools advertised. The default
 * model is `gpt-5.5` (OpenAI's recommended default as of early July 2026).
 * The agentic loop in `agent-stream.ts` calls this once per turn, running any
 * tools the model invokes between calls.
 *
 * Three env vars opt into extra request data, all off by default:
 * - `SHOW_REASONING` sets `reasoning: { summary: 'auto' }` so the model's
 *   summarised "thinking" streams too (the codec's reasoning_summary_text
 *   family carries it) — off by default so casual demo users don't burn
 *   reasoning tokens on every turn.
 * - `STATELESS` sets `store: false` and `include: ['reasoning.encrypted_content']`,
 *   demonstrating the no-store / zero-data-retention (ZDR) case: OpenAI
 *   persists nothing, so a reasoning model's chain-of-thought must travel back
 *   in-band as the reasoning item's `encrypted_content` across turns (which
 *   the codec preserves).
 * - `LOGPROBS` sets `include: ['message.output_text.logprobs']` and
 *   `top_logprobs`, so each output-text token carries its log probabilities. The
 *   codec folds these onto the projected assistant turn's output_text part(s) —
 *   carried on the finalised `response.output_item.done` item (per-part), so
 *   they appear on the item-done message in the debug pane's Ably tab and on the
 *   turn in the Messages tab. Only the reasoning-free models support logprobs, so
 *   pair it with a non-reasoning `OPENAI_MODEL` (e.g. `gpt-4.1`).
 */

import OpenAI from 'openai';
import type { Responses } from 'openai/resources/responses/responses';

import { createMockResponseStream } from './mock-model';
import { tools } from './tools';

/** A request for one model turn. */
export interface ResponseStreamRequest {
  /** The flattened conversation, ready for the `/responses` `input` array. */
  input: Responses.ResponseInputItem[];
  /** The run's AbortSignal; aborting cancels the model stream. */
  signal: AbortSignal;
}

/**
 * Open a model stream for a request. Resolves to a `ReadableStream` of raw
 * Responses events, ready to filter and pipe.
 * @throws If neither `MOCK_LLM` nor `OPENAI_API_KEY` is configured.
 */
export async function createResponseStream(
  req: ResponseStreamRequest,
): Promise<ReadableStream<Responses.ResponseStreamEvent>> {
  if (process.env.MOCK_LLM) {
    return createMockResponseStream(req);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No model configured. Set OPENAI_API_KEY (or MOCK_LLM=1 for the deterministic mock).');
  }

  const client = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
  const model = process.env.OPENAI_MODEL ?? 'gpt-5.5';

  // `include` opts into extra per-item data; STATELESS and LOGPROBS each
  // contribute an entry, so build it as one list rather than competing spreads.
  const include: Responses.ResponseIncludable[] = [];
  if (process.env.STATELESS) include.push('reasoning.encrypted_content');
  if (process.env.LOGPROBS) include.push('message.output_text.logprobs');

  const stream = await client.responses.create(
    {
      model,
      input: req.input,
      // Advertise the server-executed tools; the agentic loop runs any the
      // model calls and continues the run (see `agent-stream.ts`).
      tools,
      // Opt into summarised reasoning (see the module comment for why it is
      // gated); even on, a trivial prompt yields an empty summary — a
      // reasoning-heavy prompt is needed to see it.
      ...(process.env.SHOW_REASONING ? { reasoning: { summary: 'auto' } } : {}),
      // STATELESS demonstrates the no-store / ZDR case (see the module comment):
      // with nothing persisted server-side, a reasoning model's chain-of-thought
      // must round-trip in-band as `encrypted_content`. Needs a reasoning-heavy
      // prompt to produce a reasoning item.
      ...(process.env.STATELESS ? { store: false } : {}),
      // LOGPROBS returns up to `top_logprobs` (0–20) alternatives per output-text
      // token; only the non-reasoning models support it (see the module comment).
      ...(process.env.LOGPROBS ? { top_logprobs: 3 } : {}),
      ...(include.length > 0 ? { include } : {}),
      stream: true,
    },
    { signal: req.signal },
  );
  return iterableToStream(stream, req.signal);
}

/**
 * Adapt the OpenAI SDK's async-iterable stream into a `ReadableStream`. On abort
 * the stream closes cleanly (the underlying request is already aborted via the
 * signal passed to `responses.create`), so the pipe sees a normal end.
 *
 * Exported so its abort/error/cancel branches can be unit-tested directly (the
 * real-model path is never exercised under `MOCK_LLM`).
 */
export function iterableToStream(
  iterable: AsyncIterable<Responses.ResponseStreamEvent>,
  signal: AbortSignal,
): ReadableStream<Responses.ResponseStreamEvent> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Responses.ResponseStreamEvent>({
    async pull(controller) {
      if (signal.aborted) {
        await iterator.return?.();
        controller.close();
        return;
      }
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
