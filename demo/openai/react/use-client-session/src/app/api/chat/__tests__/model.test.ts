import type { Responses } from 'openai/resources/responses/responses';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { createResponseStream, iterableToStream } from '../model';
import { drain, userInput } from './stream-helpers';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

// CAST: iterableToStream plumbs events through untouched, so these sentinel
// objects stand in for real ResponseStreamEvents — their shape is irrelevant to
// the control-flow paths under test.
const eventA = { type: 'response.output_text.delta', delta: 'a' } as unknown as ResponseStreamEvent;
const eventB = { type: 'response.output_text.delta', delta: 'b' } as unknown as ResponseStreamEvent;

/**
 * An async-iterable whose iterator records `return()` calls and can be told to
 * throw on its Nth `next()` — enough to drive every branch of the adapter.
 * `beforeThrow` fires just before the throw (used to abort the signal mid-flight).
 */
function fakeIterable(
  events: ResponseStreamEvent[],
  opts: { throwAt?: number; error?: unknown; beforeThrow?: () => void } = {},
): { iterable: AsyncIterable<ResponseStreamEvent>; returnCalls: () => number } {
  const queue = [...events];
  let served = 0;
  let returned = 0;
  const iterable: AsyncIterable<ResponseStreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ResponseStreamEvent, undefined>> {
          if (opts.throwAt !== undefined && served === opts.throwAt) {
            opts.beforeThrow?.();
            throw opts.error ?? new Error('stream boom');
          }
          const value = queue.shift();
          if (value === undefined) return { done: true, value: undefined };
          served++;
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<ResponseStreamEvent, undefined>> {
          returned++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, returnCalls: () => returned };
}

describe('iterableToStream', () => {
  it('drains every event in order, then closes', async () => {
    const { iterable, returnCalls } = fakeIterable([eventA, eventB]);
    const out = await drain(iterableToStream(iterable, new AbortController().signal));
    expect(out).toEqual([eventA, eventB]);
    // A natural end does not need to abort the iterator.
    expect(returnCalls()).toBe(0);
  });

  it('closes immediately and releases the iterator when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { iterable, returnCalls } = fakeIterable([eventA, eventB]);
    const out = await drain(iterableToStream(iterable, controller.signal));
    expect(out).toEqual([]);
    expect(returnCalls()).toBe(1);
  });

  it('swallows an iterator error as a clean close when the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    // Emit one event, then abort and throw on the next pull: the catch sees an
    // aborted signal and closes cleanly rather than propagating.
    const { iterable } = fakeIterable([eventA], { throwAt: 1, beforeThrow: () => controller.abort() });
    const out = await drain(iterableToStream(iterable, controller.signal));
    expect(out).toEqual([eventA]);
  });

  it('propagates an iterator error when the signal is not aborted', async () => {
    const { iterable } = fakeIterable([], { throwAt: 0, error: new Error('upstream failed') });
    await expect(drain(iterableToStream(iterable, new AbortController().signal))).rejects.toThrow('upstream failed');
  });

  it('returns the iterator when the stream is cancelled', async () => {
    const { iterable, returnCalls } = fakeIterable([eventA, eventB]);
    const stream = iterableToStream(iterable, new AbortController().signal);
    await stream.cancel();
    expect(returnCalls()).toBe(1);
  });
});

describe('createResponseStream', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when neither MOCK_LLM nor OPENAI_API_KEY is configured', async () => {
    vi.stubEnv('MOCK_LLM', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    await expect(
      createResponseStream({ input: userInput('hi'), signal: new AbortController().signal }),
    ).rejects.toThrow('No model configured');
  });
});
