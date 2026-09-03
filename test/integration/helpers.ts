/**
 * Shared fixtures and waiting primitives for the transport integration tier.
 *
 * The recorder here is what keeps these suites off the clock: it buffers every
 * classified event as it is delivered and re-checks pending predicates on each
 * one, so a test awaits the event it needs rather than sleeping and re-reading
 * a growing array. The only deadline is vitest's own test timeout.
 */

import type * as AI from 'ai';

import type { TransportEvent, TransportHistoryResult } from '../../src/core/transport/types.js';

/**
 * A buffered, predicate-awaitable view of a transport's classified events.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 */
export interface EventRecorder<TInput, TOutput> {
  /** Every event recorded so far, in delivery order. */
  readonly events: TransportEvent<TInput, TOutput>[];
  /** Record one event, settling any predicate it satisfies. Pass to `subscribe`. */
  record: (event: TransportEvent<TInput, TOutput>) => void;
  /**
   * Resolve once `predicate` holds over the recorded events. Checked
   * immediately, then again on each delivery, so an event that already
   * arrived resolves without waiting.
   * @param predicate - The condition to wait for.
   * @returns Resolves when the predicate holds.
   */
  waitFor: (predicate: (events: TransportEvent<TInput, TOutput>[]) => boolean) => Promise<void>;
}

/**
 * Create an {@link EventRecorder}.
 * @returns A recorder to hand to `transport.subscribe`.
 */
export const createEventRecorder = <TInput, TOutput>(): EventRecorder<TInput, TOutput> => {
  const events: TransportEvent<TInput, TOutput>[] = [];
  const waiters: { predicate: (events: TransportEvent<TInput, TOutput>[]) => boolean; resolve: () => void }[] = [];

  return {
    events,
    record: (event) => {
      events.push(event);
      // Settle back-to-front so removing a satisfied waiter cannot skip one.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter?.predicate(events)) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    },
    waitFor: async (predicate) => {
      if (predicate(events)) return;
      await new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
};

/**
 * Page a transport's history back to the channel start, oldest-first.
 * @param transport - The transport to page.
 * @param transport.history - Its backwards history pager.
 * @returns Every historical event, in chronological order.
 */
export const drainHistory = async <TInput, TOutput>(transport: {
  history: () => Promise<TransportHistoryResult<TInput, TOutput>>;
}): Promise<TransportEvent<TInput, TOutput>[]> => {
  const all: TransportEvent<TInput, TOutput>[] = [];
  for (;;) {
    const batch = await transport.history();
    all.unshift(...batch.events);
    if (batch.exhausted) break;
  }
  return all;
};

/**
 * Create a ReadableStream of UIMessageChunks that produces a complete text response.
 * The text is split into two deltas at the midpoint.
 * @param messageId - The message ID to use.
 * @param textId - The text part ID to use.
 * @param text - The text content to stream (split into two deltas).
 * @returns A ReadableStream of UIMessageChunks.
 */
export const textResponseStream = (
  messageId: string,
  textId: string,
  text: string,
): ReadableStream<AI.UIMessageChunk> => {
  const mid = Math.floor(text.length / 2);
  return new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'text-start', id: textId });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(0, mid) });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(mid) });
      controller.enqueue({ type: 'text-end', id: textId });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
};
