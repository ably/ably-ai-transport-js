import * as Ably from 'ably';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StreamRouter } from '../../../src/core/transport/stream-router.js';
import { createStreamRouter } from '../../../src/core/transport/stream-router.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestEvent {
  type: string;
  text?: string;
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

const isTerminal = (event: TestEvent): boolean => event.type === 'finish';

/**
 * Drain a ReadableStream into an array.
 * @param stream - The stream to drain.
 * @returns All enqueued values.
 */
const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const results: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamRouter', () => {
  let router: StreamRouter<TestEvent>;

  beforeEach(() => {
    router = createStreamRouter(isTerminal, silentLogger);
  });

  describe('createStream', () => {
    it('returns a ReadableStream for the given runId', () => {
      const stream = router.createStream('run-1');
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('registers the runId as active', () => {
      router.createStream('run-1');
      expect(router.has('run-1')).toBe(true);
    });
  });

  describe('route', () => {
    it('enqueues events to the correct stream', async () => {
      const stream = router.createStream('run-1');
      const event: TestEvent = { type: 'text', text: 'hello' };
      const terminal: TestEvent = { type: 'finish' };

      expect(router.route('run-1', event)).toBe(true);
      expect(router.route('run-1', terminal)).toBe(true);

      const items = await drain(stream);
      expect(items).toEqual([event, terminal]);
    });

    it('returns false when routing to a non-existent runId', () => {
      expect(router.route('no-such-run', { type: 'text' })).toBe(false);
    });

    it('closes the stream on a terminal event', async () => {
      const stream = router.createStream('run-1');

      router.route('run-1', { type: 'text', text: 'data' });
      router.route('run-1', { type: 'finish' });

      // Stream should be closed — drain completes
      const items = await drain(stream);
      expect(items).toHaveLength(2);

      // Run should no longer be active
      expect(router.has('run-1')).toBe(false);
    });

    it('removes the run when the controller throws on enqueue', () => {
      const stream = router.createStream('run-1');

      // Close the stream externally by reading and cancelling
      void stream.cancel();

      // Now route should fail gracefully
      const result = router.route('run-1', { type: 'text' });
      expect(result).toBe(false);
      expect(router.has('run-1')).toBe(false);
    });
  });

  describe('closeStream', () => {
    it('closes the stream and removes it from the router', async () => {
      const stream = router.createStream('run-1');

      router.route('run-1', { type: 'text', text: 'hello' });
      router.closeStream('run-1');

      expect(router.has('run-1')).toBe(false);

      const items = await drain(stream);
      expect(items).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('returns true when a stream existed', () => {
      router.createStream('run-1');
      expect(router.closeStream('run-1')).toBe(true);
    });

    it('returns false for a non-existent runId', () => {
      expect(router.closeStream('no-such-run')).toBe(false);
    });

    it('is idempotent — second close returns false', () => {
      router.createStream('run-1');
      expect(router.closeStream('run-1')).toBe(true);
      expect(router.closeStream('run-1')).toBe(false);
    });
  });

  describe('errorStream', () => {
    const error = new Ably.ErrorInfo('test error', 104006, 500);

    it('errors the stream and removes it from the router', async () => {
      const stream = router.createStream('run-1');

      router.errorStream('run-1', error);

      expect(router.has('run-1')).toBe(false);

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });

    it('returns true when a stream was errored', () => {
      router.createStream('run-1');
      expect(router.errorStream('run-1', error)).toBe(true);
    });

    it('returns false for a non-existent runId', () => {
      expect(router.errorStream('no-such-run', error)).toBe(false);
    });

    it('is idempotent — second error returns false', () => {
      router.createStream('run-1');
      expect(router.errorStream('run-1', error)).toBe(true);
      expect(router.errorStream('run-1', error)).toBe(false);
    });
  });

  describe('has', () => {
    it('returns false when no streams are registered', () => {
      expect(router.has('run-1')).toBe(false);
    });

    it('reflects multiple concurrent streams', () => {
      router.createStream('run-1');
      router.createStream('run-2');

      expect(router.has('run-1')).toBe(true);
      expect(router.has('run-2')).toBe(true);

      router.closeStream('run-1');
      expect(router.has('run-1')).toBe(false);
      expect(router.has('run-2')).toBe(true);

      router.closeStream('run-2');
      expect(router.has('run-1')).toBe(false);
      expect(router.has('run-2')).toBe(false);
    });
  });

  describe('multiple concurrent streams', () => {
    it('routes events to the correct stream independently', async () => {
      const stream1 = router.createStream('run-1');
      const stream2 = router.createStream('run-2');

      router.route('run-1', { type: 'text', text: 'a' });
      router.route('run-2', { type: 'text', text: 'b' });
      router.route('run-1', { type: 'finish' });
      router.route('run-2', { type: 'text', text: 'c' });
      router.route('run-2', { type: 'finish' });

      const items1 = await drain(stream1);
      const items2 = await drain(stream2);

      expect(items1).toEqual([{ type: 'text', text: 'a' }, { type: 'finish' }]);
      expect(items2).toEqual([{ type: 'text', text: 'b' }, { type: 'text', text: 'c' }, { type: 'finish' }]);
    });
  });
});
