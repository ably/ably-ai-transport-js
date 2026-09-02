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

/** A stream a test pushes into by hand, with an explicit close. */
export interface ManualStream<T> {
  /** The readable side, handed to the code under test. */
  stream: ReadableStream<T>;
  /** Enqueue one value. */
  push(value: T): void;
  /** Close the stream, letting a pipe over it complete. */
  close(): void;
}

/**
 * Build a stream the test controls: push values mid-test and close when
 * done. Lets a test hold a pipe open across an arrangement step (e.g. a late
 * subscriber attaching mid-stream) without any timer.
 * @returns The manual stream.
 */
export const manualStream = <T>(): ManualStream<T> => {
  let controller: ReadableStreamDefaultController<T> | undefined;
  const stream = new ReadableStream<T>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    stream,
    push: (value) => controller?.enqueue(value),
    close: () => controller?.close(),
  };
};
