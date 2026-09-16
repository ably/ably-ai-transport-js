import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../../src/core/codec/index.js';
import { pipeStream } from '../../../src/core/transport/pipe-stream.js';
import type { PipeWriter } from '../../../src/core/transport/pipe-writer.js';
import { createPipeWriter } from '../../../src/core/transport/pipe-writer.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createSplitCodec, type SplitEvent } from '../../helper/split-codec.js';
import { flushMicrotasks } from '../../helper/streams.js';
import {
  asyncIterableOf,
  createTestCodec,
  erroringIterableOf,
  neverEndingStream,
  neverSettles,
  streamOf,
  type TestEvent,
  textEvents,
} from '../../helper/test-codec.js';

/**
 * The value a promise rejects with.
 * @param promise - A promise expected to reject.
 * @returns Its rejection.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

/**
 * A source that yields `events`, then fires `controller` and never settles, so
 * a pipe reads everything before the cancel reaches it.
 * @param controller - The controller to abort once the events are read.
 * @param events - The events to yield first.
 * @returns The source.
 */
const abortingAfter = <E>(controller: AbortController, ...events: E[]): AsyncIterable<E> => {
  let seen = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (seen < events.length) {
          const value = events[seen];
          seen += 1;
          // CAST: the index is bounded by the length check above.
          return { done: false, value: value as E };
        }
        controller.abort();
        return neverSettles();
      },
    }),
  };
};

describe('pipeStream', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let writer: PipeWriter;
  let codec: Codec<TestEvent>;

  beforeEach(() => {
    channel = createMockChannel();
    writer = createPipeWriter(channel);
    codec = createTestCodec();
  });

  describe('complete', () => {
    it('writes one operation per event and resolves with the serial of the last publish', async () => {
      const result = await pipeStream(
        streamOf<TestEvent>(...textEvents('m1', 'Hello', ' world'), { type: 'note', text: 'done' }),
        codec,
        writer,
      );
      // The start, the message the first delta opens, the end and the note are
      // publishes; only the second delta is an append.
      expect(result).toEqual({ serial: 'serial-4' });
      // The deltas' writes carry the transport's stream marker and the end
      // names the message it ends; the start and the note carry neither.
      expect(channel.publishCalls.map((m) => m.extras as unknown)).toEqual([
        { ai: { type: 'text-start', fields: { id: 'm1' } } },
        { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } },
        { ai: { type: 'text-end', ends: 'serial-2', fields: { id: 'm1' } } },
        { ai: { type: 'note' } },
      ]);
      expect(channel.appendCalls).toEqual([
        {
          serial: 'serial-2',
          name: 'test',
          data: ' world',
          extras: { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } },
        },
      ]);
    });

    it('writes every message an event encodes to, in order, and resolves with the last serial', async () => {
      const result = await pipeStream(
        streamOf<SplitEvent>({ type: 'both', a: 'x', b: 'y' }),
        createSplitCodec(),
        writer,
      );
      expect(result).toEqual({ serial: 'serial-2' });
      expect(channel.publishCalls.map((m) => m.data as unknown)).toEqual(['x', 'y']);
    });

    it('skips an event the codec publishes nothing for', async () => {
      const result = await pipeStream(streamOf<TestEvent>({ type: 'ping' }, { type: 'ping' }), codec, writer);
      expect(result).toEqual({ serial: undefined });
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('reads an async iterable', async () => {
      const { iterable } = asyncIterableOf<TestEvent>({ type: 'note', text: 'a' }, { type: 'note', text: 'b' });
      const result = await pipeStream(iterable, codec, writer);
      expect(result.serial).toBe('serial-2');
    });

    it('releases a stream reader so the source can be read again', async () => {
      const source = streamOf<TestEvent>({ type: 'note', text: 'a' });
      await pipeStream(source, codec, writer);
      expect(source.locked).toBe(false);
    });

    it('repairs a stream the source never ended when the pipe ends', async () => {
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      const result = await pipeStream(
        streamOf<TestEvent>(
          { type: 'text-start', id: 'm1' },
          { type: 'text-delta', id: 'm1', delta: 'kept' },
          { type: 'text-delta', id: 'm1', delta: ' lost' },
        ),
        codec,
        writer,
      );
      expect(result).toEqual({ serial: 'serial-2' });
      expect(channel.updateCalls).toEqual([
        {
          serial: 'serial-2',
          data: 'kept lost',
          extras: { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } },
        },
      ]);
    });
  });

  describe('cancelled', () => {
    it('stops reading when the signal fires and rejects OperationCancelled', async () => {
      const controller = new AbortController();
      const source = neverEndingStream<TestEvent>();
      const pending = pipeStream(source, codec, writer, controller.signal);
      controller.abort();
      await expect(pending).rejects.toBeErrorInfo({
        code: ErrorCode.OperationCancelled,
        statusCode: 400,
        message: 'unable to pipe; cancelled by signal',
      });
      expect(source.locked).toBe(false);
    });

    it('rejects OperationCancelled at once for an already-aborted signal, writing nothing', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        pipeStream(streamOf<TestEvent>({ type: 'note', text: 'a' }), codec, writer, controller.signal),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('returns the iterator of an async iterable it stops reading', async () => {
      const controller = new AbortController();
      const { iterable, state } = asyncIterableOf<TestEvent>({ type: 'note', text: 'a' });
      const pending = pipeStream(
        { [Symbol.asyncIterator]: () => neverYielding(iterable, state) },
        codec,
        writer,
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(state.returned).toBe(true);
    });

    it('logs and swallows a source whose return() rejects on cancel', async () => {
      const logHandler = vi.fn();
      const logger = makeLogger({ logLevel: LogLevel.Warn, logHandler });
      const controller = new AbortController();
      const state = { returned: false };
      const pending = pipeStream(
        { [Symbol.asyncIterator]: () => returnRejecting<TestEvent>(state) },
        codec,
        writer,
        controller.signal,
        logger,
      );
      controller.abort();
      await expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(state.returned).toBe(true);
      // The rejected return() settles after the pipe does.
      await flushMicrotasks();
      expect(logHandler).toHaveBeenCalledTimes(1);
      expect(logHandler).toHaveBeenCalledWith(
        expect.stringContaining('source return() failed'),
        LogLevel.Warn,
        expect.objectContaining({ error: 'teardown failed' }),
      );
    });

    it('logs and swallows a source whose return() throws on cancel', async () => {
      const logHandler = vi.fn();
      const logger = makeLogger({ logLevel: LogLevel.Warn, logHandler });
      const controller = new AbortController();
      const state = { returned: false };
      const pending = pipeStream(
        { [Symbol.asyncIterator]: () => returnThrowing<TestEvent>(state) },
        codec,
        writer,
        controller.signal,
        logger,
      );
      controller.abort();
      await expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(state.returned).toBe(true);
      expect(logHandler).toHaveBeenCalledTimes(1);
      expect(logHandler).toHaveBeenCalledWith(
        expect.stringContaining('source return() failed'),
        LogLevel.Warn,
        expect.objectContaining({ error: 'teardown failed' }),
      );
    });

    it('writes nothing more after the cancel', async () => {
      const controller = new AbortController();
      const source = abortingAfter<TestEvent>(controller, { type: 'note', text: 'first' });
      await expect(pipeStream(source, codec, writer, controller.signal)).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
      expect(channel.publishCalls).toHaveLength(1);
    });

    it('flushes and repairs what it wrote before rejecting on cancel', async () => {
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      const controller = new AbortController();
      const source = abortingAfter<TestEvent>(controller, ...textEvents('m1', 'a', 'b').slice(0, 3));
      await expect(pipeStream(source, codec, writer, controller.signal)).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
      // The second delta's append failed; the cancel still repairs the stream.
      expect(channel.updateCalls).toEqual([
        { serial: 'serial-2', data: 'ab', extras: { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } } },
      ]);
    });

    it('rejects PipeFailed when the repair after a cancel fails', async () => {
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      channel.updateMessage.mockRejectedValueOnce(new Ably.ErrorInfo('still down', 50000, 500));
      const controller = new AbortController();
      const source = abortingAfter<TestEvent>(controller, ...textEvents('m1', 'a', 'b').slice(0, 3));
      // The caller knows it cancelled; what it does not know is that the
      // channel is missing text, so the repair failure is the rejection.
      await expect(pipeStream(source, codec, writer, controller.signal)).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message: 'unable to pipe; repair failed: unable to repair stream; 1 of 1 repairs failed',
        cause: { code: ErrorCode.StreamedMessageFinalizeFailed },
      });
    });
  });

  describe('error', () => {
    it('rejects PipeFailed with the cause when the source throws', async () => {
      await expect(
        pipeStream(
          erroringIterableOf<TestEvent>([{ type: 'note', text: 'a' }], new Error('provider down')),
          codec,
          writer,
        ),
      ).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message: 'unable to pipe; source failed: provider down',
      });
      // The event read before the source threw is on the channel.
      expect(channel.publishCalls).toHaveLength(1);
    });

    it('stops at a failed publish and names the event in the error', async () => {
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('rejected', 40160, 401));
      await expect(
        pipeStream(
          streamOf<TestEvent>({ type: 'note', text: 'first' }, { type: 'note', text: 'second' }),
          codec,
          writer,
        ),
      ).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message: 'unable to pipe; write failed for event {"type":"note","text":"first"}: rejected',
        cause: { code: 40160 },
      });
      expect(channel.publish).toHaveBeenCalledTimes(1);
    });

    it('stops when the codec cannot encode an event', async () => {
      // CAST: an event outside the union, to exercise the encode failure path.
      const rogue = { type: 'rogue' } as unknown as TestEvent;
      const error = await rejectionOf(
        pipeStream(streamOf<TestEvent>(rogue, { type: 'note', text: 'x' }), codec, writer),
      );
      expect(error).toBeErrorInfo({ code: ErrorCode.PipeFailed, cause: { code: ErrorCode.InvalidArgument } });
      expect((error as Ably.ErrorInfo).message).toContain('encode failed for event {"type":"rogue"}');
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('cuts a long event short in the error message', async () => {
      channel.publish.mockRejectedValueOnce(new Error('rejected'));
      const error = await rejectionOf(
        pipeStream(streamOf<TestEvent>({ type: 'note', text: 'x'.repeat(500) }), codec, writer),
      );
      const { message } = error as Ably.ErrorInfo;
      expect(message.length).toBeLessThan(300);
      expect(message).toContain('…: rejected');
    });

    it('carries on past a failed append and resolves once repaired', async () => {
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      const result = await pipeStream(streamOf<TestEvent>(...textEvents('m1', 'a', 'b')), codec, writer);
      expect(result).toEqual({ serial: 'serial-3' });
      // The first delta publishes; the second is the one append, and it fails.
      // The end waits for the stream's acks and the repair rewrites the deltas'
      // message with the text so far under the last delta's extras.
      expect(channel.appendMessage).toHaveBeenCalledTimes(1);
      expect(channel.updateCalls).toEqual([
        { serial: 'serial-2', data: 'ab', extras: { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } } },
      ]);
    });

    it('rejects PipeFailed when a repair fails', async () => {
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      channel.updateMessage.mockRejectedValueOnce(new Ably.ErrorInfo('still down', 50000, 500));
      const error = await rejectionOf(pipeStream(streamOf<TestEvent>(...textEvents('m1', 'a', 'b')), codec, writer));
      expect(error).toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        cause: { code: ErrorCode.StreamedMessageFinalizeFailed },
      });
      expect((error as Ably.ErrorInfo).message).toContain('for event {"type":"text-end","id":"m1"}');
    });

    it('keeps the first failure as the error when the repair after it also fails', async () => {
      // The second delta's append fails and is left pending; the note's publish
      // then fails and ends the pipe. The flush that follows tries the repair,
      // which fails too, and the publish failure is still the rejection.
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      channel.publish
        .mockResolvedValueOnce({ serials: ['serial-1'] })
        .mockResolvedValueOnce({ serials: ['serial-2'] })
        .mockRejectedValueOnce(new Error('rejected'));
      channel.updateMessage.mockRejectedValueOnce(new Error('still down'));
      const error = await rejectionOf(
        pipeStream(
          streamOf<TestEvent>(...textEvents('m1', 'a', 'b').slice(0, 3), { type: 'note', text: 'late' }),
          codec,
          writer,
        ),
      );
      expect(error).toBeErrorInfo({ code: ErrorCode.PipeFailed });
      expect((error as Ably.ErrorInfo).message).toContain('write failed for event {"type":"note","text":"late"}');
      expect(channel.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('releases the source after an error', async () => {
      channel.publish.mockRejectedValueOnce(new Error('rejected'));
      const source = streamOf<TestEvent>({ type: 'note', text: 'first' });
      await expect(pipeStream(source, codec, writer)).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      expect(source.locked).toBe(false);
    });
  });
});

/**
 * An iterator that never yields but reports `return()` through the given
 * fixture state, for testing release on cancel.
 * @param iterable - The fixture iterable whose `return` flag to reuse.
 * @param state - The fixture's state.
 * @param state.returned - Set when `return()` is called.
 * @returns The iterator.
 */
const neverYielding = <E>(iterable: AsyncIterable<E>, state: { returned: boolean }): AsyncIterator<E> => {
  const inner = iterable[Symbol.asyncIterator]();
  return {
    next: async () => neverSettles(),
    return: async () => {
      state.returned = true;
      return inner.return ? inner.return() : { done: true, value: undefined };
    },
  };
};

/**
 * An iterator that never yields and whose `return()` rejects, the way a
 * provider generator does when its `finally` block throws.
 * @param state - The fixture state whose `returned` flag to set.
 * @param state.returned - Set when `return()` is called.
 * @returns The iterator.
 */
const returnRejecting = <E>(state: { returned: boolean }): AsyncIterator<E> => ({
  next: async () => neverSettles(),
  // eslint-disable-next-line @typescript-eslint/require-await -- fixture iterator: an async throw is the rejection under test
  return: async () => {
    state.returned = true;
    throw new Error('teardown failed');
  },
});

/**
 * An iterator that never yields and whose `return()` throws synchronously, as
 * a hand-rolled iterator can.
 * @param state - The fixture state whose `returned` flag to set.
 * @param state.returned - Set when `return()` is called.
 * @returns The iterator.
 */
const returnThrowing = <E>(state: { returned: boolean }): AsyncIterator<E> => ({
  next: async () => neverSettles(),
  return: () => {
    state.returned = true;
    throw new Error('teardown failed');
  },
});
