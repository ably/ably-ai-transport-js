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
      adaptor.openWriter();
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('resolves a publish with the event and its ack serial', async () => {
      const writer = adaptor.openWriter();
      const note: TestEvent = { type: 'note', text: 'hello' };
      await expect(writer.write(note)).resolves.toEqual({ event: note, serial: 'serial-1' });
      expect(channel.publishCalls).toHaveLength(1);
    });

    it('resolves with no serial for an event the codec keeps off the channel', async () => {
      const writer = adaptor.openWriter();
      await expect(writer.write({ type: 'ping' })).resolves.toEqual({ event: { type: 'ping' }, serial: undefined });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it("resolves a later delta with the serial of the message this writer's first delta landed on", async () => {
      const writer = adaptor.openWriter();
      await writer.write(start);
      const first = await writer.write(delta('a'));
      const second = await writer.write(delta('b'));
      expect(first.serial).toBe('serial-2');
      expect(second.serial).toBe('serial-2');
      expect(channel.appendCalls).toMatchObject([{ serial: 'serial-2', data: 'b' }]);
    });

    it('resolves a later delta before the channel has acknowledged the delta before it', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      await writer.write(delta('b'));
      await expect(writer.write(delta('c'))).resolves.toMatchObject({ serial: 'serial-1' });
      pending.resolve(ack);
      await writer.close();
    });

    it('publishes the end event only once every delta of its message is acknowledged', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      await writer.write(delta('b'));
      const ended = writer.write(end);
      expect(await isSettled(ended)).toBe(false);
      expect(channel.publishCalls).toHaveLength(1);
      pending.resolve(ack);
      await expect(ended).resolves.toMatchObject({ serial: 'serial-2' });
      expect(extrasOf(channel.publishCalls[1]).ai).toMatchObject({ ends: 'serial-1' });
    });

    it('appends to the message of a stream it never ended when a later event reuses the key', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      await writer.write(start);
      await expect(writer.write(delta('b'))).resolves.toMatchObject({ serial: 'serial-1' });
      expect(channel.publishCalls).toHaveLength(2);
      expect(channel.appendCalls).toMatchObject([{ serial: 'serial-1', data: 'b' }]);
    });
  });

  describe('beside a pipe', () => {
    it('publishes what a pipe publishes for the same events', async () => {
      const events: TestEvent[] = [{ type: 'note', text: 'hi' }, ...textEvents('t1', 'a', 'b', 'c'), { type: 'ping' }];
      const piped = createMockChannel();
      await createAgentAdaptor(piped, createTestCodec()).pipe(streamOf(...events));

      const writer = adaptor.openWriter();
      for (const event of events) await writer.write(event);
      await writer.close();

      expect(channel.publishCalls).toEqual(piped.publishCalls);
      expect(channel.appendCalls).toEqual(piped.appendCalls);
      expect(channel.updateCalls).toEqual(piped.updateCalls);
    });
  });

  describe('order', () => {
    it('holds a write made before the last has completed, and makes it after', async () => {
      const writer = adaptor.openWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      const first = writer.write({ type: 'note', text: 'one' });
      const second = writer.write({ type: 'note', text: 'two' });
      await flushMicrotasks();
      expect(channel.publish).toHaveBeenCalledTimes(1);
      pending.resolve({ serials: ['first'] });
      await expect(first).resolves.toMatchObject({ serial: 'first' });
      await expect(second).resolves.toMatchObject({ serial: 'serial-1' });
      expect(channel.publishCalls).toMatchObject([{ data: 'two' }]);
    });

    it('writes deltas handed over at once in the order they were handed over', async () => {
      const writer = adaptor.openWriter();
      const writes = ['a', 'b', 'c', 'd'].map(async (text) => writer.write(delta(text)));
      await Promise.all(writes);
      expect(channel.publishCalls).toMatchObject([{ data: 'a' }]);
      expect(channel.appendCalls.map((m): unknown => m.data)).toEqual(['b', 'c', 'd']);
    });
  });

  describe('close', () => {
    it('waits for the acks of what it wrote and publishes no end event', async () => {
      const writer = adaptor.openWriter();
      await writer.write(start);
      await writer.write(delta('a'));
      const pending = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.appendMessage.mockReturnValueOnce(pending.promise);
      await writer.write(delta('b'));
      const closed = writer.close();
      expect(await isSettled(closed)).toBe(false);
      pending.resolve(ack);
      await closed;
      expect(channel.publishCalls).toHaveLength(2);
      expect(channel.updateMessage).not.toHaveBeenCalled();
    });

    it('resolves for a writer that wrote nothing', async () => {
      await adaptor.openWriter().close();
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('resolves again once closed, publishing nothing', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      await writer.close();
      await writer.close();
      expect(channel.publishCalls).toHaveLength(1);
    });

    it('resolves a second close when the first settles, without its failure', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      const repair = Promise.withResolvers<Ably.UpdateDeleteResult>();
      channel.updateMessage.mockReturnValueOnce(repair.promise);
      const first = writer.close();
      const second = writer.close();
      expect(await isSettled(second)).toBe(false);
      repair.reject(channelError());
      await expect(first).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(second).resolves.toBeUndefined();
      await expect(writer.close()).resolves.toBeUndefined();
    });

    it('rejects a write made after close was called, publishing nothing', async () => {
      const writer = adaptor.openWriter();
      const closed = writer.close();
      await expect(writer.write({ type: 'note', text: 'late' })).rejects.toBeErrorInfo({
        code: ErrorCode.StreamClosed,
        statusCode: 400,
        message: 'unable to write event; the writer is closed',
      });
      await closed;
      await expect(writer.write({ type: 'note', text: 'later' })).rejects.toBeErrorInfoWithCode(ErrorCode.StreamClosed);
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('lets the write in progress and the writes held behind it finish first', async () => {
      const writer = adaptor.openWriter();
      const pending = Promise.withResolvers<Ably.PublishResult>();
      channel.publish.mockReturnValueOnce(pending.promise);
      const first = writer.write({ type: 'note', text: 'one' });
      const second = writer.write({ type: 'note', text: 'two' });
      const closed = writer.close();
      expect(await isSettled(closed)).toBe(false);
      pending.resolve({ serials: ['first'] });
      await expect(first).resolves.toMatchObject({ serial: 'first' });
      await expect(second).resolves.toMatchObject({ serial: 'serial-1' });
      await closed;
      expect(channel.publishCalls).toMatchObject([{ data: 'two' }]);
    });

    it('resolves when a write handed over before it fails', async () => {
      const writer = adaptor.openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      const failed = writer.write({ type: 'note', text: 'one' });
      const closed = writer.close();
      await expect(failed).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(closed).resolves.toBeUndefined();
    });
  });

  describe('carrying on with a new writer', () => {
    it('publishes a later delta as a new message and ends it', async () => {
      const first = adaptor.openWriter();
      await first.write(start);
      await first.write(delta('a'));
      await first.close();

      const second = adaptor.openWriter();
      await expect(second.write(delta('b'))).resolves.toMatchObject({ serial: 'serial-3' });
      await expect(second.write(delta('c'))).resolves.toMatchObject({ serial: 'serial-3' });
      await second.write(end);
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
      const first = adaptor.openWriter();
      await first.write(delta('a'));
      await first.close();

      const second = adaptor.openWriter();
      await expect(second.write(end)).resolves.toMatchObject({ serial: 'serial-2' });
      expect(extrasOf(channel.publishCalls[1]).ai).not.toHaveProperty('ends');
    });

    it('rejects an event that replaces a message the writer did not begin, publishing nothing', async () => {
      const first = adaptor.openWriter();
      await first.write(delta('a'));
      await first.close();

      const second = adaptor.openWriter();
      await expect(second.write({ type: 'text-replace', id: 't1', text: 'z' })).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        cause: { code: ErrorCode.InvalidArgument },
      });
      expect(channel.publishCalls).toHaveLength(1);
      expect(channel.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('rejects the write of an event the codec cannot encode, naming the event', async () => {
      const writer = adaptor.openWriter();
      // CAST: an event outside the union, to exercise the unlisted-type path.
      const rogue = { type: 'not-an-event' } as unknown as TestEvent;
      await expect(writer.write(rogue)).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message:
          'unable to write event; encode failed for event {"type":"not-an-event"}: unable to encode event; no row for type \'not-an-event\'',
        cause: { code: ErrorCode.InvalidArgument },
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it("rejects the write of an event whose message lacks the codec's name, publishing nothing", async () => {
      const misnamed: Codec<TestEvent> = {
        id: 'misnamed',
        name: 'ai',
        encode: () => [{ message: { name: 'chat', data: 'x', extras: { ai: { codec: 'misnamed', type: 'note' } } } }],
        decode: () => [],
      };
      const writer = createAgentAdaptor(channel, misnamed).openWriter();
      await expect(writer.write({ type: 'note', text: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        cause: {
          code: ErrorCode.InvalidArgument,
          message:
            "unable to write event; codec 'misnamed' encoded a message named 'chat' with codec id 'misnamed', and its decoder only reads messages named 'ai' with codec id 'misnamed'",
        },
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it("rejects the write of a publish the channel refuses, with the channel's error as the cause", async () => {
      const writer = adaptor.openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      await expect(writer.write({ type: 'note', text: 'one' })).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message: 'unable to write event; write failed for event {"type":"note","text":"one"}: channel refused',
        cause: { code: 50000 },
      });
    });

    it("logs a failed write with the channel's error and none of the event's content", async () => {
      const logHandler = vi.fn();
      const logger = makeLogger({ logLevel: LogLevel.Error, logHandler });
      const writer = createAgentAdaptor(channel, createTestCodec(), { logger }).openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      await expect(writer.write({ type: 'note', text: 'private text' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.PipeFailed,
      );
      expect(logHandler).toHaveBeenCalledTimes(1);
      expect(logHandler).toHaveBeenCalledWith(
        expect.stringContaining('DefaultEventWriter.write(); write failed'),
        LogLevel.Error,
        expect.objectContaining({ error: 'channel refused' }),
      );
      expect(JSON.stringify(logHandler.mock.calls)).not.toContain('private text');
    });

    it("rejects the write of a replacement the channel refuses, with the channel's error as the cause", async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      await expect(writer.write({ type: 'text-replace', id: 't1', text: 'z' })).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        cause: { code: 50000 },
      });
    });

    it('repairs a delta the channel did not acknowledge before the end event', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      await writer.write(end);
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
      expect(channel.publishCalls).toHaveLength(2);
    });

    it('repairs a delta the channel did not acknowledge when it closes', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      await writer.close();
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
    });

    it('rejects the end event when the repair fails, publishes no end event, and repairs again on a retry', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      await expect(writer.write(end)).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        cause: { code: ErrorCode.StreamedMessageFinalizeFailed },
      });
      expect(channel.publishCalls).toHaveLength(1);

      await expect(writer.write(end)).resolves.toMatchObject({ serial: 'serial-2' });
      expect(channel.updateCalls).toMatchObject([{ serial: 'serial-1', data: 'ab' }]);
      expect(extrasOf(channel.publishCalls[1]).ai).toMatchObject({ ends: 'serial-1' });
      await expect(writer.close()).resolves.toBeUndefined();
    });

    it('rejects close when the repair that failed before the end event fails again', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError()).mockRejectedValueOnce(channelError());
      await expect(writer.write(end)).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(writer.close()).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
    });

    it('rejects close when the repair fails', async () => {
      const writer = adaptor.openWriter();
      await writer.write(delta('a'));
      channel.appendMessage.mockRejectedValueOnce(channelError());
      await writer.write(delta('b'));
      channel.updateMessage.mockRejectedValueOnce(channelError());
      await expect(writer.close()).rejects.toBeErrorInfo({
        code: ErrorCode.PipeFailed,
        message: 'unable to close writer; repair failed: unable to repair stream; 1 of 1 repairs failed',
        cause: { code: ErrorCode.StreamedMessageFinalizeFailed, cause: { code: 50000 } },
      });
    });

    it('keeps accepting writes after one has failed', async () => {
      const writer = adaptor.openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      await expect(writer.write({ type: 'note', text: 'one' })).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(writer.write({ type: 'note', text: 'two' })).resolves.toMatchObject({ serial: 'serial-1' });
    });

    it('makes a write held behind one that fails', async () => {
      const writer = adaptor.openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      const first = writer.write({ type: 'note', text: 'one' });
      const second = writer.write({ type: 'note', text: 'two' });
      await expect(first).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(second).resolves.toMatchObject({ serial: 'serial-1' });
    });

    it('publishes the next delta of a message whose first delta the channel refused', async () => {
      const writer = adaptor.openWriter();
      channel.publish.mockRejectedValueOnce(channelError());
      await expect(writer.write(delta('a'))).rejects.toBeErrorInfoWithCode(ErrorCode.PipeFailed);
      await expect(writer.write(delta('b'))).resolves.toMatchObject({ serial: 'serial-1' });
      expect(channel.publishCalls).toMatchObject([{ data: 'b' }]);
    });
  });

  describe('headers', () => {
    it("lays the writer's headers over the adaptor's defaults on every message", async () => {
      const withDefaults = createAgentAdaptor(channel, createTestCodec(), { headers: { a: 'default', b: 'default' } });
      const writer = withDefaults.openWriter({ headers: { b: 'writer' } });
      await writer.write(delta('a'));
      await writer.write(delta('b'));
      await writer.write(end);
      const expected = { a: 'default', b: 'writer' };
      expect(channel.publishCalls.map((m) => extrasOf(m).headers)).toEqual([expected, expected]);
      expect(extrasOf(channel.appendCalls[0]).headers).toEqual(expected);
    });

    it('throws InvalidArgument for a header Ably would not store', () => {
      // CAST: deliberately outside MessageHeaders to exercise the runtime check.
      const headers = { meta: { nested: true } } as unknown as MessageHeaders;
      expect(() => adaptor.openWriter({ headers })).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to open writer; header 'meta' is not a string, number, boolean or null",
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });
  });
});
