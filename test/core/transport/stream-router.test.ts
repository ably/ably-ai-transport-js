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

const INV_A = 'inv-a';
const INV_B = 'inv-b';

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
      const stream = router.createStream('run-1', INV_A);
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('registers the runId as active', () => {
      router.createStream('run-1', INV_A);
      expect(router.has('run-1')).toBe(true);
      expect(router.getActiveInvocation('run-1')).toBe(INV_A);
    });
  });

  describe('route', () => {
    it('enqueues events to the correct stream', async () => {
      const stream = router.createStream('run-1', INV_A);
      const event: TestEvent = { type: 'text', text: 'hello' };
      const terminal: TestEvent = { type: 'finish' };

      expect(router.route('run-1', INV_A, event)).toBe(true);
      expect(router.route('run-1', INV_A, terminal)).toBe(true);

      const items = await drain(stream);
      expect(items).toEqual([event, terminal]);
    });

    it('returns false when routing to a non-existent runId', () => {
      expect(router.route('no-such-run', INV_A, { type: 'text' })).toBe(false);
    });

    it('drops events from a different invocation under the same runId', async () => {
      const stream = router.createStream('run-1', INV_A);

      // A late event from the losing invocation under the same runId.
      expect(router.route('run-1', INV_B, { type: 'text', text: 'loser' })).toBe(false);

      // Winning invocation's events still flow.
      router.route('run-1', INV_A, { type: 'text', text: 'winner' });
      router.route('run-1', INV_A, { type: 'finish' });

      const items = await drain(stream);
      expect(items).toEqual([{ type: 'text', text: 'winner' }, { type: 'finish' }]);
    });

    it('routes events with no invocation-id (legacy / agent-side events) to the registered stream', async () => {
      const stream = router.createStream('run-1', INV_A);

      // Some events on the wire may not carry an invocation-id (assistant
      // chunks); they should be routed to whatever stream is registered.
      expect(router.route('run-1', undefined, { type: 'text', text: 'plain' })).toBe(true);
      router.route('run-1', undefined, { type: 'finish' });

      const items = await drain(stream);
      expect(items).toEqual([{ type: 'text', text: 'plain' }, { type: 'finish' }]);
    });

    it('closes the stream on a terminal event', async () => {
      const stream = router.createStream('run-1', INV_A);

      router.route('run-1', INV_A, { type: 'text', text: 'data' });
      router.route('run-1', INV_A, { type: 'finish' });

      // Stream should be closed — drain completes
      const items = await drain(stream);
      expect(items).toHaveLength(2);

      // Run should no longer be active
      expect(router.has('run-1')).toBe(false);
    });

    it('removes the run when the controller throws on enqueue', () => {
      const stream = router.createStream('run-1', INV_A);

      // Close the stream externally by reading and cancelling
      void stream.cancel();

      // Now route should fail gracefully
      const result = router.route('run-1', INV_A, { type: 'text' });
      expect(result).toBe(false);
      expect(router.has('run-1')).toBe(false);
    });
  });

  describe('rebindStream', () => {
    it('returns the existing stream and routes events tagged with the new invocation', async () => {
      const original = router.createStream('run-1', INV_A);
      const rebound = router.rebindStream('run-1', INV_B);
      expect(rebound).toBe(original);
      expect(router.getActiveInvocation('run-1')).toBe(INV_B);

      // Events tagged with the OLD invocation are now dropped
      expect(router.route('run-1', INV_A, { type: 'text', text: 'stale' })).toBe(false);
      // Events tagged with the NEW invocation route to the same readable
      router.route('run-1', INV_B, { type: 'text', text: 'fresh' });
      router.closeStream('run-1');

      const items = await drain(original);
      expect(items).toEqual([{ type: 'text', text: 'fresh' }]);
    });

    it('returns undefined when no stream is registered for the runId', () => {
      expect(router.rebindStream('missing', INV_B)).toBeUndefined();
    });
  });

  describe('closeStream', () => {
    it('closes the stream and removes it from the router', async () => {
      const stream = router.createStream('run-1', INV_A);

      router.route('run-1', INV_A, { type: 'text', text: 'hello' });
      router.closeStream('run-1');

      expect(router.has('run-1')).toBe(false);

      const items = await drain(stream);
      expect(items).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('returns true when a stream existed', () => {
      router.createStream('run-1', INV_A);
      expect(router.closeStream('run-1')).toBe(true);
    });

    it('returns false for a non-existent runId', () => {
      expect(router.closeStream('no-such-run')).toBe(false);
    });

    it('is idempotent — second close returns false', () => {
      router.createStream('run-1', INV_A);
      expect(router.closeStream('run-1')).toBe(true);
      expect(router.closeStream('run-1')).toBe(false);
    });
  });

  describe('errorStream', () => {
    const error = new Ably.ErrorInfo('test error', 104006, 500);

    it('errors the stream and removes it from the router', async () => {
      const stream = router.createStream('run-1', INV_A);

      router.errorStream('run-1', error);

      expect(router.has('run-1')).toBe(false);

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });

    it('returns true when a stream was errored', () => {
      router.createStream('run-1', INV_A);
      expect(router.errorStream('run-1', error)).toBe(true);
    });

    it('returns false for a non-existent runId', () => {
      expect(router.errorStream('no-such-run', error)).toBe(false);
    });

    it('is idempotent — second error returns false', () => {
      router.createStream('run-1', INV_A);
      expect(router.errorStream('run-1', error)).toBe(true);
      expect(router.errorStream('run-1', error)).toBe(false);
    });
  });

  describe('has', () => {
    it('returns false when no streams are registered', () => {
      expect(router.has('run-1')).toBe(false);
    });

    it('reflects multiple concurrent streams', () => {
      router.createStream('run-1', INV_A);
      router.createStream('run-2', INV_B);

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
      const stream1 = router.createStream('run-1', INV_A);
      const stream2 = router.createStream('run-2', INV_B);

      router.route('run-1', INV_A, { type: 'text', text: 'a' });
      router.route('run-2', INV_B, { type: 'text', text: 'b' });
      router.route('run-1', INV_A, { type: 'finish' });
      router.route('run-2', INV_B, { type: 'text', text: 'c' });
      router.route('run-2', INV_B, { type: 'finish' });

      const items1 = await drain(stream1);
      const items2 = await drain(stream2);

      expect(items1).toEqual([{ type: 'text', text: 'a' }, { type: 'finish' }]);
      expect(items2).toEqual([{ type: 'text', text: 'b' }, { type: 'text', text: 'c' }, { type: 'finish' }]);
    });
  });
});
