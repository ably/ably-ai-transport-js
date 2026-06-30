/**
 * Deterministic mock model for the e2e tests — no API key, no network.
 *
 * Produces a hand-built `ResponseStreamEvent` stream scripted from the last
 * user prompt, in the same event shape a real `/responses` text stream uses:
 * `output_item.added` (message) → `content_part.added` → `output_text.delta`*
 * → `output_text.done` → `output_item.done`. Response-lifecycle events
 * (`response.created` / `response.completed`) are omitted: the reducer ignores
 * them and the stream's terminal is the item-done, so they add nothing here and
 * keep the mock free of a synthetic `Response` snapshot.
 *
 * Wired in by `createResponseStream()` (model.ts) behind `MOCK_LLM`.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { ResponseStreamRequest } from './model';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

/** A long, multi-sentence reply streamed slowly so the cancel test can interrupt it. */
const LONG_STORY =
  'Once upon a time, in a valley wrapped in morning mist, there lived a young dragon who had never learned to ' +
  'breathe fire. Every dawn she climbed the tallest pine and practised, huffing little clouds of warm air that ' +
  'drifted away on the breeze. The other dragons laughed, but she kept climbing, kept trying, and kept believing ' +
  'that one day a spark would catch. And so the seasons turned, and her patience grew as steadily as her wings.';

interface ReplyPlan {
  /** The full reply text. */
  text: string;
  /** Whether to stream it slowly in many deltas (abort-aware) for the cancel scenario. */
  slow: boolean;
}

/** Read the most recent user message's text from the model input. */
function lastUserText(input: Responses.ResponseInputItem[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type !== 'message' || item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return content;
    let text = '';
    for (const part of content) {
      if (part.type === 'input_text') text += part.text;
    }
    return text;
  }
  return '';
}

/** Script the reply from the prompt, mirroring the prompts the e2e suite sends. */
function planReply(prompt: string): ReplyPlan {
  const say = /say\s+"([^"]+)"/i.exec(prompt);
  if (say) return { text: say[1], slow: false };

  const word = /\bword\s+([A-Za-z]+)/i.exec(prompt);
  if (word) return { text: word[1], slow: false };

  if (/\b(story|dragon)\b/i.test(prompt) || /\blong\b/i.test(prompt)) {
    return { text: LONG_STORY, slow: true };
  }

  const marker = /marker\s+([^\s.]+)/i.exec(prompt);
  if (marker) return { text: `Acknowledged the marker ${marker[1]}.`, slow: false };

  return { text: `Mock reply to: ${prompt || '(empty prompt)'}`, slow: false };
}

/** Split text into ~2-word delta pieces, preserving the original spacing. */
function chunkWords(text: string): string[] {
  const words = text.split(' ');
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += 2) {
    const trailingSpace = i + 2 < words.length ? ' ' : '';
    pieces.push(words.slice(i, i + 2).join(' ') + trailingSpace);
  }
  return pieces;
}

/** Resolve after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the mock `ResponseStreamEvent` stream for a request. Streams the reply
 * as a single assistant message item; closes early (a clean end) if the run's
 * signal aborts mid-stream, which the cancel test relies on.
 */
export function createMockResponseStream(req: ResponseStreamRequest): ReadableStream<ResponseStreamEvent> {
  const plan = planReply(lastUserText(req.input));
  const { signal } = req;
  const itemId = crypto.randomUUID();
  let seq = 0;
  const next = (): number => seq++;

  const message = (
    status: Responses.ResponseOutputMessage['status'],
    content: Responses.ResponseOutputMessage['content'],
  ): Responses.ResponseOutputMessage => ({ id: itemId, type: 'message', role: 'assistant', status, content });

  return new ReadableStream<ResponseStreamEvent>({
    async start(controller) {
      controller.enqueue({
        type: 'response.output_item.added',
        item: message('in_progress', []),
        output_index: 0,
        sequence_number: next(),
      });
      controller.enqueue({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
        sequence_number: next(),
      });

      const pieces = plan.slow ? chunkWords(plan.text) : [plan.text];
      for (const delta of pieces) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        controller.enqueue({
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
          sequence_number: next(),
        });
        if (plan.slow) await sleep(120, signal);
      }

      if (signal.aborted) {
        controller.close();
        return;
      }
      controller.enqueue({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: plan.text,
        logprobs: [],
        sequence_number: next(),
      });
      controller.enqueue({
        type: 'response.output_item.done',
        item: message('completed', [{ type: 'output_text', text: plan.text, annotations: [] }]),
        output_index: 0,
        sequence_number: next(),
      });
      controller.close();
    },
  });
}
