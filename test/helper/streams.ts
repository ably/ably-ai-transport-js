/** Shared test helpers for consuming and pacing async streams. */

/**
 * Read a ReadableStream to completion, collecting every chunk it emits.
 * @param stream - The stream to drain.
 * @returns The chunks read, in order, once the stream closes.
 */
export const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const results: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
};

/**
 * Let pending microtasks settle so a not-yet-closed stream can be observed.
 * @returns A promise resolved after the microtask queue drains.
 */
export const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Build a stream that enqueues the given events and closes.
 * @param events - The chunks to emit, in order.
 * @returns The closed-after-emitting stream.
 */
export const streamOf = <T>(...events: T[]): ReadableStream<T> =>
  new ReadableStream<T>({
    start: (controller) => {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });

/**
 * Build a stream that never enqueues or closes — a pipe on it only ends via
 * cancel or abort.
 * @returns The paused stream.
 */
export const pausedStream = <T>(): ReadableStream<T> =>
  new ReadableStream<T>({
    start: () => {
      /* never enqueues or closes */
    },
  });
