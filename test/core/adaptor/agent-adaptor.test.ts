import * as Ably from 'ably';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentAdaptor, MessageHeaders, Published } from '../../../src/core/adaptor/index.js';
import { createAgentAdaptor } from '../../../src/core/adaptor/index.js';
import { type Codec, defineCodec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createSplitCodec } from '../../helper/split-codec.js';
import { asyncIterableOf, createTestCodec, streamOf, type TestEvent, textEvents } from '../../helper/test-codec.js';

/** A headers map the type would refuse, for the runtime check a cast or a JavaScript caller reaches. */
// CAST: deliberately outside MessageHeaders to exercise the runtime check.
const badHeaders = { ok: 'x', meta: { nested: true } } as unknown as MessageHeaders;

/**
 * The `extras.headers` a recorded message carries.
 * @param message - A message the mock channel recorded.
 * @returns Its `extras.headers`, or `undefined` when it has none.
 */
const headersOf = (message: Ably.Message): unknown =>
  // CAST: Ably types `extras` as `any`; the test reads one key off it.
  (message.extras as { headers?: unknown } | undefined)?.headers;

/**
 * Collect what an iterable pipe yields.
 * @param iterable - The iterable pipe.
 * @returns What it yielded.
 */
const collect = async <E>(iterable: AsyncIterable<Published<E>>): Promise<Published<E>[]> => {
  const yielded: Published<E>[] = [];
  for await (const published of iterable) yielded.push(published);
  return yielded;
};

interface TaggedEvent {
  type: 'note';
}

/** A codec whose one row writes a header of its own, the case a caller's header can collide with. */
const taggedCodec = defineCodec({
  id: 'tagged',
  typeOf: (e: TaggedEvent) => e.type,
  events: {
    note: {
      encode: () => ({ headers: { tenant: 'row' } }),
      decode: (): TaggedEvent => ({ type: 'note' }),
    },
  },
});

describe('createAgentAdaptor', () => {
  let channel: MockChannel;
  let adaptor: AgentAdaptor<TestEvent>;

  beforeEach(() => {
    channel = createMockChannel();
    adaptor = createAgentAdaptor(channel, createTestCodec());
  });

  describe('send', () => {
    it('publishes one event named ai with the codec id, and resolves with the serial', async () => {
      await expect(adaptor.send({ type: 'note', text: 'hello' })).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publishCalls).toEqual([
        { name: 'ai', data: 'hello', extras: { ai: { codec: 'test-codec', type: 'note' } } },
      ]);
    });

    it('resolves with no serial when the codec publishes nothing', async () => {
      await expect(adaptor.send({ type: 'ping' })).resolves.toEqual({ serial: undefined });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it("rejects a message without the codec's name or id, publishing nothing", async () => {
      const unnamed: Codec<{ type: 'x' }> = {
        id: 'unnamed',
        name: 'ai',
        // Written to the old contract: no name, and no codec id under extras.ai.
        encode: () => [{ message: { data: 'x', extras: { ai: { type: 'x' } } } }],
        decode: () => [],
      };
      await expect(createAgentAdaptor(channel, unnamed).send({ type: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        message:
          "unable to send; codec 'unnamed' encoded a message named 'undefined' with codec id 'undefined', and its decoder only reads messages named 'ai' with codec id 'unnamed'",
      });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('rejects an event that appends, publishing nothing', async () => {
      const split = createAgentAdaptor(channel, createSplitCodec());
      await expect(split.send({ type: 'mixed', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('publishes every message an event encodes to and resolves with the last serial', async () => {
      const split = createAgentAdaptor(channel, createSplitCodec());
      await expect(split.send({ type: 'both', a: 'x', b: 'y' })).resolves.toEqual({ serial: 'serial-2' });
    });

    it('rejects InsufficientCapability when the channel refuses the publish for a capability reason', async () => {
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('denied', 40160, 401));
      await expect(adaptor.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.InsufficientCapability,
        cause: { code: 40160 },
      });
    });

    it('rejects SessionSendFailed for any other publish failure', async () => {
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('down', 50000, 500));
      await expect(adaptor.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.SessionSendFailed,
        cause: { code: 50000 },
      });
    });

    it('rejects InternalError when the ack carries no serial', async () => {
      channel.publish.mockResolvedValueOnce({ serials: [] });
      await expect(adaptor.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InternalError);
    });
  });

  describe('headers', () => {
    it("lays the call's headers over the adaptor's defaults, and the row's over both", async () => {
      const tagged = createAgentAdaptor(channel, taggedCodec, { headers: { tenant: 'default', region: 'eu' } });
      await tagged.send({ type: 'note' }, { headers: { tenant: 'call', region: 'us', requestId: 'r1' } });
      expect(headersOf(channel.publishCalls[0] ?? {})).toEqual({ tenant: 'row', region: 'us', requestId: 'r1' });
    });

    it("carries the adaptor's defaults on a call that passes none", async () => {
      const withDefaults = createAgentAdaptor(channel, createTestCodec(), { headers: { region: 'eu' } });
      await withDefaults.pipe(streamOf(...textEvents('m1', 'a', 'b')));
      const written = [...channel.publishCalls, ...channel.appendCalls];
      expect(written.map((m) => headersOf(m))).toEqual(written.map(() => ({ region: 'eu' })));
    });

    it('throws InvalidArgument for a default header Ably would not store', () => {
      expect(() => createAgentAdaptor(channel, createTestCodec(), { headers: badHeaders })).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to create agent adaptor; header 'meta' is not a string, number, boolean or null",
      });
    });

    it('rejects a send with a header Ably would not store, publishing nothing', async () => {
      await expect(adaptor.send({ type: 'note', text: 'x' }, { headers: badHeaders })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('rejects a pipe with a header Ably would not store before it touches the source', async () => {
      const { iterable, state } = asyncIterableOf<TestEvent>({ type: 'note', text: 'x' });
      await expect(adaptor.pipe(iterable, { headers: badHeaders })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      expect(state.returned).toBe(false);
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('throws from pipeEach for a header Ably would not store, before the loop starts', () => {
      expect(() => adaptor.pipeEach(streamOf<TestEvent>(), { headers: badHeaders })).toThrowErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });
  });

  describe('pipe', () => {
    it('writes every event and resolves with the serial of the last publish', async () => {
      await expect(adaptor.pipe(streamOf(...textEvents('m1', 'a', 'b')))).resolves.toEqual({ serial: 'serial-3' });
      expect(channel.appendCalls.map((m) => m.data as unknown)).toEqual(['b']);
    });

    it('rejects OperationCancelled when its signal has fired', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        adaptor.pipe(streamOf<TestEvent>({ type: 'note', text: 'x' }), { signal: controller.signal }),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });

    it('gives each pipe its own key table, so two pipes may use the same key', async () => {
      await Promise.all([
        adaptor.pipe(streamOf(...textEvents('m1', 'a'))),
        adaptor.pipe(streamOf(...textEvents('m1', 'b'))),
      ]);
      // Each pipe's first delta opens a message of its own; neither appends.
      expect(channel.appendMessage).not.toHaveBeenCalled();
      expect(channel.publishCalls.map((m) => m.data as unknown)).toContain('a');
      expect(channel.publishCalls.map((m) => m.data as unknown)).toContain('b');
    });
  });

  describe('pipeEach', () => {
    it('yields each event with the serial of the message it landed on', async () => {
      const events = textEvents('m1', 'a', 'b');
      await expect(collect(adaptor.pipeEach(streamOf(...events)))).resolves.toEqual([
        { event: events[0], serial: 'serial-1' },
        { event: events[1], serial: 'serial-2' },
        { event: events[2], serial: 'serial-2' },
        { event: events[3], serial: 'serial-3' },
      ]);
    });

    it('throws OperationCancelled from the loop when its signal has fired', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(adaptor.pipeEach(streamOf<TestEvent>({ type: 'note', text: 'x' }), { signal: controller.signal })),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });
  });
});
