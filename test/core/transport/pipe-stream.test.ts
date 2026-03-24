import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamEncoder } from '../../../src/core/codec/types.js';
import { pipeStream } from '../../../src/core/transport/pipe-stream.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestEvent { type: string; text?: string }
interface TestMessage { id: string; content: string }

interface MockEncoder extends StreamEncoder<TestEvent, TestMessage> {
  appendedEvents: TestEvent[];
  closed: boolean;
  abortedReason: string | undefined;
}

const emptyPublishResult = { serials: [] } as unknown as Ably.PublishResult;

const createMockEncoder = (): MockEncoder => {
  const mock: MockEncoder = {
    appendedEvents: [],
    closed: false,
    abortedReason: undefined,
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    appendEvent: vi.fn(async (event: TestEvent) => {
      mock.appendedEvents.push(event);
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    abort: vi.fn(async (reason?: string) => {
      mock.abortedReason = reason ?? '';
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    close: vi.fn(async () => {
      mock.closed = true;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    writeMessage: vi.fn(async () => emptyPublishResult),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    writeMessages: vi.fn(async () => emptyPublishResult),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    writeEvent: vi.fn(async () => emptyPublishResult),
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
      const events: TestEvent[] = [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }];
      const stream = streamOf(...events);

      const result = await pipeStream(stream, encoder, noSignal);

      expect(result.reason).toBe('complete');
      expect(encoder.appendedEvents).toEqual(events);
    });

    it('calls encoder.close() when stream completes', async () => {
      const stream = streamOf({ type: 'text', text: 'done' });

      await pipeStream(stream, encoder, noSignal);

      expect(encoder.closed).toBe(true);
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

    it('calls onAbort and writes events through the write function', async () => {
      const controller = new AbortController();

      const onAbort = vi.fn(async (write: (event: TestEvent) => Promise<void>) => {
        await write({ type: 'custom-abort' });
      });

      const stream = new ReadableStream<TestEvent>({ start: () => { /* paused */ } });
      // Abort immediately
      controller.abort();

      await pipeStream(stream, encoder, controller.signal, onAbort);

      expect(onAbort).toHaveBeenCalled();
      expect(encoder.appendedEvents).toContainEqual({ type: 'custom-abort' });
    });

    it('calls encoder.abort() with reason when cancelled', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<TestEvent>({ start: () => { /* paused */ } });

      await pipeStream(stream, encoder, controller.signal);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(encoder.abort).toHaveBeenCalledWith('cancelled');
      expect(encoder.abortedReason).toBe('cancelled');
    });

    it('calls encoder.abort() after onAbort callback', async () => {
      const controller = new AbortController();
      controller.abort();

      const callOrder: string[] = [];
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      const onAbort = vi.fn(async () => {
        callOrder.push('onAbort');
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/require-await -- vi mock
      vi.mocked(encoder.abort).mockImplementation(async () => {
        callOrder.push('encoder.abort');
      });

      const stream = new ReadableStream<TestEvent>({ start: () => { /* paused */ } });

      await pipeStream(stream, encoder, controller.signal, onAbort);

      expect(callOrder).toEqual(['onAbort', 'encoder.abort']);
    });

    it('returns cancelled when signal is already aborted at start', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<TestEvent>({ start: () => { /* never reads */ } });

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
      encoder.close = vi.fn(async () => { throw new Error('encoder also broken'); });

      const stream = errorStream([], new Error('stream broke'));

      // Should not throw — best-effort error handling
      const result = await pipeStream(stream, encoder, noSignal);
      expect(result.reason).toBe('error');
    });
  });
});
