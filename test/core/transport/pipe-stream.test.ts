import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodecInputEvent, Encoder, WriteOptions } from '../../../src/core/codec/types.js';
import { pipeStream } from '../../../src/core/transport/pipe-stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestInput extends CodecInputEvent {
  kind: 'test-input';
}

interface TestEvent {
  type: string;
  text?: string;
}

interface MockEncoder extends Encoder<TestInput, TestEvent> {
  appendedEvents: TestEvent[];
  appendedOpts: (WriteOptions | undefined)[];
  closed: boolean;
  streamsCancelled: boolean;
}

const createMockEncoder = (): MockEncoder => {
  const mock: MockEncoder = {
    appendedEvents: [],
    appendedOpts: [],
    closed: false,
    streamsCancelled: false,

    publishInput: vi.fn(async () => {
      /* unused — pipeStream only invokes publishOutput */
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    publishOutput: vi.fn(async (output: TestEvent, opts?: WriteOptions) => {
      mock.appendedEvents.push(output);
      mock.appendedOpts.push(opts);
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    cancelStreams: vi.fn(async () => {
      mock.streamsCancelled = true;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    close: vi.fn(async () => {
      mock.closed = true;
    }),
  };
  return mock;
};

/**
 * Create a ReadableStream from an array of events.
 * @param events - Events to enqueue.
 * @returns A ReadableStream that emits the events then closes.
 */
const streamOf = (...events: TestEvent[]): ReadableStream<TestEvent> =>
  new ReadableStream({
    start: (controller) => {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });

/**
 * Create a ReadableStream that errors after emitting some events.
 * @param events - Events to enqueue before erroring.
 * @param error - The error to emit.
 * @returns A ReadableStream that emits the events then errors.
 */
const errorStream = (events: TestEvent[], error: Error): ReadableStream<TestEvent> =>
  new ReadableStream({
    start: (controller) => {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.error(error);
    },
  });

// Signal placeholder for tests that don't use cancellation.
const noSignal: AbortSignal | undefined = undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pipeStream', () => {
  let encoder: MockEncoder;

  beforeEach(() => {
    encoder = createMockEncoder();
  });

  describe('complete stream', () => {
    it('reads all events and calls appendEvent for each', async () => {
      const events: TestEvent[] = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
      ];
      const stream = streamOf(...events);

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('complete');
      expect(encoder.appendedEvents).toEqual(events);
    });

    it('publishes every output with no write options', async () => {
      await pipeStream(streamOf({ type: 'text', text: 'x' }), encoder, noSignal);

      expect(encoder.appendedOpts).toEqual([undefined]);
    });

    it('calls encoder.close() when stream completes', async () => {
      const stream = streamOf({ type: 'text', text: 'done' });

      await pipeStream(stream, encoder, noSignal);

      expect(encoder.closed).toBe(true);
    });

    it('terminates still-open wire streams before close when the source completes', async () => {
      // An agent self-abort completes the source stream without end chunks for
      // in-flight streamed messages; the done path must give those streams a
      // status terminal (a no-op when every stream closed normally).
      const callOrder: string[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/require-await -- vi mock
      vi.mocked(encoder.cancelStreams).mockImplementation(async () => {
        callOrder.push('cancelStreams');
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/require-await -- vi mock
      vi.mocked(encoder.close).mockImplementation(async () => {
        callOrder.push('close');
      });
      const stream = streamOf({ type: 'text', text: 'aborted midway' });

      await pipeStream(stream, encoder, noSignal);

      expect(callOrder).toEqual(['cancelStreams', 'close']);
    });

    it('handles empty stream', async () => {
      const stream = streamOf();

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('complete');
      expect(encoder.appendedEvents).toHaveLength(0);
      expect(encoder.closed).toBe(true);
    });
  });

  describe('cancelled stream', () => {
    it('returns cancelled when abort signal fires', async () => {
      const controller = new AbortController();

      // Stream that pauses so we can abort mid-read
      const stream = new ReadableStream<TestEvent>({
        start: (ctrl) => {
          ctrl.enqueue({ type: 'text', text: 'first' });
          // Don't close — wait for abort
        },
      });

      const promise = pipeStream(stream, encoder, controller.signal);

      // Wait for the first event to be processed
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      const result = await promise;
      expect(result.reason).toBe('cancelled');
    });

    it('calls onCancelled and writes events through the write function', async () => {
      const controller = new AbortController();

      const onCancelled = vi.fn(async (write: (event: TestEvent) => Promise<void>) => {
        await write({ type: 'custom-abort' });
      });

      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* paused */
        },
      });
      // Abort immediately
      controller.abort();

      await pipeStream(stream, encoder, controller.signal, onCancelled);

      expect(onCancelled).toHaveBeenCalled();
      expect(encoder.appendedEvents).toContainEqual({ type: 'custom-abort' });
    });

    it('calls encoder.cancelStreams() when cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* paused */
        },
      });

      await pipeStream(stream, encoder, controller.signal);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(encoder.cancelStreams).toHaveBeenCalled();
      expect(encoder.streamsCancelled).toBe(true);
    });

    it('calls encoder.cancelStreams() after onCancelled callback', async () => {
      const controller = new AbortController();
      controller.abort();

      const callOrder: string[] = [];
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      const onCancelled = vi.fn(async () => {
        callOrder.push('onCancelled');
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/require-await -- vi mock
      vi.mocked(encoder.cancelStreams).mockImplementation(async () => {
        callOrder.push('encoder.cancelStreams');
      });

      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* paused */
        },
      });

      await pipeStream(stream, encoder, controller.signal, onCancelled);

      expect(callOrder).toEqual(['onCancelled', 'encoder.cancelStreams']);
    });

    it('returns cancelled when signal is already aborted at start', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* never reads */
        },
      });

      const result = await pipeStream(stream, encoder, controller.signal);
      expect(result.reason).toBe('cancelled');
    });
  });

  describe('error stream', () => {
    it('returns error when stream throws', async () => {
      const stream = errorStream([{ type: 'text', text: 'ok' }], new Error('stream broke'));

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('error');
    });

    it('calls encoder.close() best-effort on stream error', async () => {
      const stream = errorStream([], new Error('stream broke'));

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('error');
      expect(encoder.closed).toBe(true);
    });

    it('handles encoder failure in error path gracefully', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await -- mock throws
      encoder.close = vi.fn(async () => {
        throw new Error('encoder also broken');
      });

      const stream = errorStream([], new Error('stream broke'));

      // Should not throw — best-effort error handling
      const result = await pipeStream(stream, encoder, noSignal);
      expect(result.reason).toBe('error');
    });

    it('includes the caught error in StreamResult', async () => {
      const originalError = new Error('model rate limit exceeded');
      const stream = errorStream([], originalError);

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('error');
      expect(result.error).toBe(originalError);
    });

    it('wraps non-Error throws as Error in StreamResult', async () => {
      // A stream that throws a non-Error value
      const stream = new ReadableStream<TestEvent>({
        start: (controller) => {
          controller.error('string error');
        },
      });

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('string error');
    });
  });

  describe('StreamResult.error absence', () => {
    it('is undefined when stream completes', async () => {
      const stream = streamOf({ type: 'text', text: 'done' });

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('complete');
      expect(result.error).toBeUndefined();
    });

    it('is undefined when stream is cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* paused */
        },
      });

      const result = await pipeStream(stream, encoder, controller.signal);

      expect(result.reason).toBe('cancelled');
      expect(result.error).toBeUndefined();
    });
  });

  describe('beforeFirstWrite hook', () => {
    it('fires once, before the first output, and is awaited', async () => {
      const callOrder: string[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/require-await -- vi mock
      vi.mocked(encoder.publishOutput).mockImplementation(async (output: TestEvent) => {
        callOrder.push(`publish:${output.text ?? ''}`);
      });
      const beforeFirstWrite = vi.fn(async () => {
        await Promise.resolve();
        callOrder.push('beforeFirstWrite');
      });

      await pipeStream(
        streamOf({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }),
        encoder,
        noSignal,
        undefined,
        undefined,
        beforeFirstWrite,
      );

      expect(beforeFirstWrite).toHaveBeenCalledTimes(1);
      // Fires before the first publish; never re-fires for the second output.
      expect(callOrder).toEqual(['beforeFirstWrite', 'publish:a', 'publish:b']);
    });

    it('never fires for an empty stream', async () => {
      const beforeFirstWrite = vi.fn(async () => {
        await Promise.resolve();
      });

      const result = await pipeStream(streamOf(), encoder, noSignal, undefined, undefined, beforeFirstWrite);

      expect(result.reason).toBe('complete');
      expect(beforeFirstWrite).not.toHaveBeenCalled();
    });

    it('never fires when the stream errors before any output', async () => {
      const beforeFirstWrite = vi.fn(async () => {
        await Promise.resolve();
      });
      const stream = errorStream([], new Error('upstream broke'));

      const result = await pipeStream(stream, encoder, noSignal, undefined, undefined, beforeFirstWrite);

      expect(result.reason).toBe('error');
      expect(beforeFirstWrite).not.toHaveBeenCalled();
    });

    it('never fires when cancelled before any output', async () => {
      const controller = new AbortController();
      controller.abort();
      const beforeFirstWrite = vi.fn(async () => {
        await Promise.resolve();
      });
      const stream = new ReadableStream<TestEvent>({
        start: () => {
          /* paused */
        },
      });

      const result = await pipeStream(stream, encoder, controller.signal, undefined, undefined, beforeFirstWrite);

      expect(result.reason).toBe('cancelled');
      expect(beforeFirstWrite).not.toHaveBeenCalled();
    });
  });
});
