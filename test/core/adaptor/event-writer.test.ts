import * as Ably from '@ably/pubsub-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdaptor, MessageHeaders } from '../../../src/core/adaptor/index.js';
import { createAgentAdaptor } from '../../../src/core/adaptor/index.js';
import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { flushMicrotasks, nextMacrotask } from '../../helper/streams.js';
import { createTestCodec, streamOf, type TestEvent, textEvents } from '../../helper/test-codec.js';

// CAST: the pipe writer reads nothing off an append's or an update's ack.
const ack = {} as Ably.UpdateDeleteResult;

const channelError = (): Ably.ErrorInfo => new Ably.ErrorInfo('channel refused', 50000, 500);

/**
 * Whether a promise has settled, once every microtask already queued has run:
 * a promise still pending then is waiting on something the test holds.
 * @param promise - The promise.
 * @returns True once it has resolved or rejected.
 */
const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  // A probe, not control flow: the test awaits the promise itself afterwards.
  promise.then(mark, mark);
  await nextMacrotask();
  return settled;
};

const start: TestEvent = { type: 'text-start', id: 't1' };
// CAST: an event outside the union, so the test codec cannot encode it.
const rogue = { type: 'not-an-event' } as unknown as TestEvent;
const delta = (text: string): TestEvent => ({ type: 'text-delta', id: 't1', delta: text });
const end: TestEvent = { type: 'text-end', id: 't1' };

/**
 * The `extras` a recorded message carries.
 * @param message - A message the mock channel recorded.
 * @returns Its extras.
 */
const extrasOf = (message: Ably.Message | undefined): { ai?: Record<string, unknown>; headers?: unknown } =>
  // CAST: Ably types `extras` as `any`; the test reads two keys off it.
  (message?.extras ?? {}) as { ai?: Record<string, unknown>; headers?: unknown };

describe('an event writer', () => {
  let channel: MockChannel;
  let adaptor: AgentAdaptor<TestEvent>;

  beforeEach(() => {
    channel = createMockChannel();
    adaptor = createAgentAdaptor(channel, createTestCodec());
  });

  describe('write', () => {
    it('publishes nothing until its first write', () => {
      adaptor.newWriter();
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('returns before the channel has acknowledged the event, and flush waits for it', async () => {
      const writer = adaptor.newWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      writer.write({ type: 'note', text: 'hello' });
      const flushed = writer.flush();
      expect(await isSettled(flushed)).toBe(false);
      pending.resolve({ serials: ['first'] });
      await expect(flushed).resolves.toEqual({ serial: 'first' });
    });

    it("writes an event's messages after those of the events handed over before it", async () => {
      const writer = adaptor.newWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      writer.write({ type: 'note', text: 'one' });
      writer.write({ type: 'note', text: 'two' });
      await flushMicrotasks();
      expect(channel.publish).toHaveBeenCalledTimes(1);
      pending.resolve({ serials: ['first'] });
      await writer.flush();
      expect(channel.publish.mock.calls.map(([m]) => m.data as unknown)).toEqual(['one', 'two']);
    });

    it('appends the later deltas of a stream to the message its first delta opened', async () => {
      const writer = adaptor.newWriter();
      for (const text of ['a', 'b', 'c']) writer.write(delta(text));
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publishCalls).toMatchObject([{ data: 'a' }]);
      expect(channel.appendCalls.map((m) => [m.serial, m.data as unknown])).toEqual([
        ['serial-1', 'b'],
        ['serial-1', 'c'],
      ]);
    });

    it('sends a delta without waiting for the acknowledgement of the delta before it', async () => {
      const writer = adaptor.newWriter();
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      writer.write(delta('a'));
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      writer.write(delta('b'));
      writer.write(delta('c'));
      await nextMacrotask();
      expect(channel.appendMessage).toHaveBeenCalledTimes(2);
      pending.resolve(ack);
      await writer.flush();
    });

    it('publishes the end event only once every delta of its message is acknowledged', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      writer.write(delta('b'));
      writer.write(end);
      await nextMacrotask();
      expect(channel.publishCalls).toHaveLength(1);
      pending.resolve(ack);
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-2' });
      expect(extrasOf(channel.publishCalls[1]).ai).toMatchObject({ ends: 'serial-1' });
    });

    it('appends to the message of a stream it never ended when a later event reuses the key', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      writer.write(start);
      writer.write(delta('b'));
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publishCalls).toHaveLength(2);
      expect(channel.appendCalls).toMatchObject([{ serial: 'serial-1', data: 'b' }]);
    });
  });

  describe('beside a pipe', () => {
    it('publishes what a pipe publishes for the same events', async () => {
      const events: TestEvent[] = [{ type: 'note', text: 'hi' }, ...textEvents('t1', 'a', 'b', 'c'), { type: 'ping' }];
      const piped = createMockChannel();
      await createAgentAdaptor(piped, createTestCodec()).pipe(streamOf(...events));

      const writer = adaptor.newWriter();
      for (const event of events) writer.write(event);
      await writer.close();

      expect(channel.publishCalls).toEqual(piped.publishCalls);
      expect(channel.appendCalls).toEqual(piped.appendCalls);
      expect(channel.updateCalls).toEqual(piped.updateCalls);
    });
  });

  describe('flush', () => {
    it('resolves with the serial of the message the last event landed on', async () => {
      const writer = adaptor.newWriter();
      await expect(writer.flush()).resolves.toEqual({ serial: undefined });
      writer.write({ type: 'ping' });
      await expect(writer.flush()).resolves.toEqual({ serial: undefined });
      writer.write({ type: 'note', text: 'one' });
      writer.write({ type: 'ping' });
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-1' });
      writer.write(delta('a'));
      writer.write({ type: 'note', text: 'two' });
      writer.write(delta('b'));
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-2' });
    });

    it('keeps the writer and its streams open, so a later delta carries on the same message', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      writer.write(delta('b'));
      const flushed = writer.flush();
      expect(await isSettled(flushed)).toBe(false);
      pending.resolve(ack);
      await flushed;

      writer.write(delta('c'));
      writer.write(end);
      await writer.flush();
      expect(channel.publishCalls.map((m) => m.data as unknown)).toEqual(['a', '']);
      expect(channel.appendMessage.mock.calls.map(([m]) => [m.serial, m.data as unknown])).toEqual([
        ['serial-1', 'b'],
        ['serial-1', 'c'],
      ]);
    });

    it('writes the events handed over after it once it settles', async () => {
      const writer = adaptor.newWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      writer.write({ type: 'note', text: 'before' });
      const flushed = writer.flush();
      writer.write({ type: 'note', text: 'after' });
      await flushMicrotasks();
      expect(channel.publish).toHaveBeenCalledTimes(1);
      pending.resolve({ serials: ['first'] });
      await expect(flushed).resolves.toEqual({ serial: 'first' });
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publish.mock.calls.map(([m]) => m.data as unknown)).toEqual(['before', 'after']);
    });

    it('settles as close does once close has been called', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      const closed = writer.close();
      await expect(writer.flush()).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      await expect(closed).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
    });
  });

  describe('close', () => {
    it('waits for the acks of what it wrote, publishes no end event, and resolves with the last serial', async () => {
      const writer = adaptor.newWriter();
      writer.write(start);
      writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      writer.write(delta('b'));
      const closed = writer.close();
      expect(await isSettled(closed)).toBe(false);
      pending.resolve(ack);
      await expect(closed).resolves.toEqual({ serial: 'serial-2' });
      expect(channel.publishCalls).toHaveLength(2);
      expect(channel.updateMessage).not.toHaveBeenCalled();
    });

    it('resolves for a writer that wrote nothing', async () => {
      await expect(adaptor.newWriter().close()).resolves.toEqual({ serial: undefined });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('settles a second close as the first did, its failure included', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      const repair = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.updateMessage.mockReturnValueOnce(repair.promise);
      const first = writer.close();
      const second = writer.close();
      expect(await isSettled(second)).toBe(false);
      repair.reject(channelError());
      await expect(first).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      await expect(second).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      await expect(writer.close()).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      expect(channel.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('throws StreamClosed at a write made after close was called, publishing nothing', async () => {
      const writer = adaptor.newWriter();
      const closed = writer.close();
      expect(() => {
        writer.write({ type: 'note', text: 'late' });
      }).toThrowErrorInfo({
        code: ErrorCode.StreamClosed,
        statusCode: 400,
        message: 'unable to write event; the writer is closed',
      });
      await closed;
      expect(() => {
        writer.write({ type: 'note', text: 'later' });
      }).toThrowErrorInfoWithCode(ErrorCode.StreamClosed);
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('writes the events handed over before it first', async () => {
      const writer = adaptor.newWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      writer.write({ type: 'note', text: 'one' });
      writer.write({ type: 'note', text: 'two' });
      const closed = writer.close();
      expect(await isSettled(closed)).toBe(false);
      pending.resolve({ serials: ['first'] });
      await expect(closed).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publish.mock.calls.map(([m]) => m.data as unknown)).toEqual(['one', 'two']);
    });
  });

  describe('await using', () => {
    it('closes the writer when the block is left, repairing what it wrote', async () => {
      const writer = adaptor.newWriter();
      {
        await using scoped = writer;
        scoped.write(delta('a'));
        channel.appendMessage.mockRejectedValueOnce(channelError());
        scoped.write(delta('b'));
      }
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
      expect(() => {
        writer.write(end);
      }).toThrowErrorInfoWithCode(ErrorCode.StreamClosed);
    });

    it("throws a failed repair from the block's exit", async () => {
      let thrown: unknown;
      try {
        await using writer = adaptor.newWriter();
        writer.write(delta('a'));
        channel.appendMessage.mockRejectedValueOnce(channelError());
        writer.write(delta('b'));
        channel.updateMessage.mockRejectedValueOnce(channelError());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
    });
  });

  describe('carrying on with a new writer', () => {
    it('publishes a later delta as a new message and ends it', async () => {
      const first = adaptor.newWriter();
      first.write(start);
      first.write(delta('a'));
      await first.close();

      const second = adaptor.newWriter();
      second.write(delta('b'));
      second.write(delta('c'));
      await expect(second.flush()).resolves.toEqual({ serial: 'serial-3' });
      second.write(end);
      await second.close();

      expect(channel.publishCalls.map((m) => extrasOf(m).ai?.type)).toEqual([
        'text-start',
        'text-delta',
        'text-delta',
        'text-end',
      ]);
      expect(channel.publishCalls[2]).toMatchObject({ data: 'b' });
      expect(channel.appendCalls).toMatchObject([{ serial: 'serial-3', data: 'c' }]);
      expect(extrasOf(channel.publishCalls[3]).ai).toMatchObject({ type: 'text-end', ends: 'serial-3' });
    });

    it('publishes an end event for a message whose deltas an earlier writer wrote', async () => {
      const first = adaptor.newWriter();
      first.write(delta('a'));
      await first.close();

      const second = adaptor.newWriter();
      second.write(end);
      await expect(second.close()).resolves.toEqual({ serial: 'serial-2' });
      expect(extrasOf(channel.publishCalls[1]).ai).not.toHaveProperty('ends');
    });

    it('throws at the call for an event that replaces a message the writer did not begin, publishing nothing', async () => {
      const first = adaptor.newWriter();
      first.write(delta('a'));
      await first.close();

      const second = adaptor.newWriter();
      expect(() => {
        second.write({ type: 'text-replace', id: 't1', text: 'z' });
      }).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to write event; it updates stream 't1', which this writer has not opened",
      });
      await second.close();
      expect(channel.publishCalls).toHaveLength(1);
      expect(channel.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('an event that cannot be written', () => {
    it("throws the codec's own InvalidArgument at the call", () => {
      const writer = adaptor.newWriter();
      expect(() => {
        writer.write(rogue);
      }).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
        message: "unable to encode event; no row for type 'not-an-event'",
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('throws InvalidArgument at the call for a plain error a hand-written codec throws', () => {
      const throwing: Codec<TestEvent> = {
        id: 'throwing',
        name: 'ai',
        encode: () => {
          throw new Error('cannot encode');
        },
        decode: () => [],
      };
      const writer = createAgentAdaptor(channel, throwing).newWriter();
      expect(() => {
        writer.write({ type: 'note', text: 'x' });
      }).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to write event; the codec could not encode it: cannot encode',
      });
    });

    it("throws InvalidArgument at the call for a message without the codec's name", () => {
      const misnamed: Codec<TestEvent> = {
        id: 'misnamed',
        name: 'ai',
        encode: () => [{ message: { name: 'chat', data: 'x', extras: { ai: { codec: 'misnamed', type: 'note' } } } }],
        decode: () => [],
      };
      const writer = createAgentAdaptor(channel, misnamed).newWriter();
      expect(() => {
        writer.write({ type: 'note', text: 'x' });
      }).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message:
          "unable to write event; codec 'misnamed' encoded a message named 'chat' with codec id 'misnamed', and its decoder only reads messages named 'ai' with codec id 'misnamed'",
      });
    });

    it('throws InvalidArgument at the call for a publish under a stream that is still open', async () => {
      const keyed: Codec<TestEvent> = {
        id: 'keyed',
        name: 'ai',
        encode: () => [
          { message: { name: 'ai', data: 'x', extras: { ai: { codec: 'keyed', type: 'note' } } }, publish: 'k' },
        ],
        decode: () => [],
      };
      const writer = createAgentAdaptor(channel, keyed).newWriter();
      writer.write({ type: 'note', text: 'one' });
      expect(() => {
        writer.write({ type: 'note', text: 'two' });
      }).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to write event; it publishes under stream 'k', which is still open",
      });
      await writer.close();
      expect(channel.publish).toHaveBeenCalledTimes(1);
    });

    it('leaves the writer running, and the events around it are written', async () => {
      const writer = adaptor.newWriter();
      writer.write({ type: 'note', text: 'one' });
      expect(() => {
        writer.write(rogue);
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
      writer.write({ type: 'note', text: 'two' });
      await expect(writer.flush()).resolves.toEqual({ serial: 'serial-2' });
      expect(channel.publish.mock.calls.map(([m]) => m.data as unknown)).toEqual(['one', 'two']);
    });

    it('is logged with no event content', () => {
      const logHandler = vi.fn();
      const logger = makeLogger({ logLevel: LogLevel.Error, logHandler });
      const writer = createAgentAdaptor(channel, createTestCodec(), { logger }).newWriter();
      expect(() => {
        writer.write(rogue);
      }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(logHandler).toHaveBeenCalledWith(
        expect.stringContaining('DefaultEventWriter.write(); the event cannot be written'),
        LogLevel.Error,
        expect.objectContaining({ error: "unable to encode event; no row for type 'not-an-event'" }),
      );
    });
  });

  describe('a failure to deliver', () => {
    it("stops the writer with the channel's error, as thrown, when the channel refuses a publish", async () => {
      const writer = adaptor.newWriter();
      const refusal = channelError();
      channel.publish.mockRejectedValueOnce(refusal);
      writer.write({ type: 'note', text: 'one' });
      await expect(writer.flush()).rejects.toBe(refusal);
      expect(() => {
        writer.write({ type: 'note', text: 'two' });
      }).toThrow(refusal);
      await expect(writer.close()).rejects.toBe(refusal);
      expect(channel.publish).toHaveBeenCalledTimes(1);
    });

    it('stops the writer with the capability error the channel threw', async () => {
      const writer = adaptor.newWriter();
      const denied = new Ably.ErrorInfo('denied', ErrorCode.InsufficientCapability, 401);
      channel.publish.mockRejectedValueOnce(denied);
      writer.write({ type: 'note', text: 'one' });
      await expect(writer.flush()).rejects.toBe(denied);
    });

    it('wraps a failure that is not an ErrorInfo, so the writer always reports one', async () => {
      const writer = adaptor.newWriter();
      channel.publish.mockRejectedValueOnce(new Error('socket closed'));
      writer.write({ type: 'note', text: 'one' });
      await expect(writer.flush()).rejects.toBeErrorInfo({
        code: ErrorCode.InternalError,
        message: 'unable to write event; socket closed',
      });
    });

    it("stops the writer with the channel's error, as thrown, when the channel refuses a replacement", async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      const refusal = channelError();
      channel.updateMessage.mockRejectedValueOnce(refusal);
      writer.write({ type: 'text-replace', id: 't1', text: 'z' });
      await expect(writer.flush()).rejects.toBe(refusal);
    });

    it('does not write the events queued behind the write that failed', async () => {
      const writer = adaptor.newWriter();
      const refusal = channelError();
      channel.publish.mockRejectedValueOnce(refusal);
      writer.write({ type: 'note', text: 'one' });
      writer.write({ type: 'note', text: 'two' });
      await expect(writer.flush()).rejects.toBe(refusal);
      expect(channel.publish).toHaveBeenCalledTimes(1);
    });

    it('stops the writer when the repair before an end event fails, and publishes no end event', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      writer.write(end);
      await expect(writer.flush()).rejects.toBeErrorInfo({
        code: ErrorCode.StreamedMessageFinalizeFailed,
        cause: { code: 50000 },
      });
      expect(() => {
        writer.write(end);
      }).toThrowErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      expect(channel.publishCalls).toHaveLength(1);
      expect(channel.updateMessage).toHaveBeenCalledTimes(1);
    });

    it("stops the writer when a flush's repair fails", async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      await expect(writer.flush()).rejects.toBeErrorInfo({
        code: ErrorCode.StreamedMessageFinalizeFailed,
        message: 'unable to repair stream; 1 of 1 repairs failed',
        cause: { code: 50000 },
      });
      expect(() => {
        writer.write(delta('c'));
      }).toThrowErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      await expect(writer.close()).rejects.toBeErrorInfoWithCode(ErrorCode.StreamedMessageFinalizeFailed);
      expect(channel.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('is logged once, with no event content', async () => {
      const logHandler = vi.fn();
      const logger = makeLogger({ logLevel: LogLevel.Error, logHandler });
      const writer = createAgentAdaptor(channel, createTestCodec(), { logger }).newWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      writer.write({ type: 'note', text: 'private text' });
      await expect(writer.flush()).rejects.toBeErrorInfoWithCode(50000);
      expect(logHandler).toHaveBeenCalledTimes(1);
      expect(logHandler).toHaveBeenCalledWith(
        expect.stringContaining('DefaultEventWriter.write(); write failed, the writer has stopped'),
        LogLevel.Error,
        expect.objectContaining({ error: 'channel refused' }),
      );
      expect(JSON.stringify(logHandler.mock.calls)).not.toContain('private text');
    });
  });

  describe('repair', () => {
    it('repairs a delta the channel did not acknowledge before the end event', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      writer.write(end);
      await writer.flush();
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
      expect(channel.publishCalls).toHaveLength(2);
    });

    it('repairs a delta the channel did not acknowledge when it closes', async () => {
      const writer = adaptor.newWriter();
      writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      writer.write(delta('b'));
      await writer.close();
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
    });
  });

  describe('headers', () => {
    it("lays the writer's headers over the adaptor's defaults on every message", async () => {
      const withDefaults = createAgentAdaptor(channel, createTestCodec(), { headers: { a: 'default', b: 'default' } });
      const writer = withDefaults.newWriter({ headers: { b: 'writer' } });
      writer.write(delta('a'));
      writer.write(delta('b'));
      writer.write(end);
      await writer.flush();
      const expected = { a: 'default', b: 'writer' };
      expect(channel.publishCalls.map((m) => extrasOf(m).headers)).toEqual([expected, expected]);
      expect(extrasOf(channel.appendCalls[0]).headers).toEqual(expected);
    });

    it('throws InvalidArgument for a header Ably would not store', () => {
      // CAST: deliberately outside MessageHeaders to exercise the runtime check.
      const headers = { meta: { nested: true } } as unknown as MessageHeaders;
      expect(() => adaptor.newWriter({ headers })).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to create writer; header 'meta' is not a string, number, boolean or null",
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });
  });
});
