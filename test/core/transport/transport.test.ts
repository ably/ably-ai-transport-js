import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OBJECT_MODES, resolveChannelModes } from '../../../src/core/channel-options.js';
import type { Delivery } from '../../../src/core/codec/index.js';
import { defineCodec } from '../../../src/core/codec/index.js';
import { fromSerial } from '../../../src/core/transport/from-serial.js';
import type { MessageHeaders } from '../../../src/core/transport/headers.js';
import type { Transport } from '../../../src/core/transport/transport.js';
import { createTransport } from '../../../src/core/transport/transport.js';
import { ErrorCode } from '../../../src/errors.js';
import { VERSION } from '../../../src/version.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createMockClient } from '../../helper/mock-client.js';
import { createSplitCodec, type SplitEvent } from '../../helper/split-codec.js';
import { flushMicrotasks } from '../../helper/streams.js';
import {
  asyncIterableOf,
  createTestCodec,
  neverEndingStream,
  streamOf,
  type TestEvent,
  textEvents,
} from '../../helper/test-codec.js';

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

// eslint-disable-next-line @typescript-eslint/no-empty-function -- a handler that ignores its deliveries
const noop = (): void => {};

/** The channel name every transport here is built on. */
const CHANNEL = 'chat';

/**
 * The `extras` the builder writes for a set of fields: `type` under `ai`, the
 * rest under `ai.fields` when there are any.
 * @param fields - The fields.
 * @param fields.type - The event type.
 * @returns The extras.
 */
const extrasFor = ({ type, ...fields }: Record<string, unknown>): Record<string, unknown> =>
  Object.keys(fields).length > 0 ? { ai: { type, fields } } : { ai: { type } };

const inbound = (opts: {
  action?: Ably.InboundMessage['action'];
  serial: string;
  data?: unknown;
  /** The builder's fields under `extras.ai`: `type` beside the rest under `fields`. */
  fields?: Record<string, unknown>;
  /** The whole `extras`, verbatim, for a message that is not the codec's. */
  extras?: unknown;
  version?: string;
}): Ably.InboundMessage =>
  ({
    action: opts.action ?? 'message.create',
    serial: opts.serial,
    data: 'data' in opts ? opts.data : '',
    extras: 'extras' in opts ? opts.extras : extrasFor(opts.fields ?? { type: 'note' }),
    version: opts.version === undefined ? {} : { serial: opts.version },
    // CAST: a minimal InboundMessage stub with the fields the transport and codec read.
  }) as Ably.InboundMessage;

const noteMessage = (serial: string, text: string): Ably.InboundMessage =>
  inbound({ serial, data: text, fields: { type: 'note' } });

/**
 * The message a stream's deltas share, as the pipe writer marks it: the codec
 * remembers this one.
 * @param serial - The message serial.
 * @param text - The delta text.
 * @returns The inbound message.
 */
const deltaMessage = (serial: string, text: string): Ably.InboundMessage =>
  inbound({ serial, data: text, extras: { ai: { type: 'text-delta', stream: true, fields: { id: 'm1' } } } });

/**
 * A promise the test settles, so a replay function can keep a history replay
 * open while live deliveries arrive.
 * @returns The promise and its resolver.
 */
const gate = (): { opened: Promise<void>; open: () => void } => {
  let open = noop;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

/**
 * A handler that records the serial of each delivery it is called with.
 * @returns The record and the handler.
 */
const serialsSeen = (): { seen: string[]; handler: (d: Delivery<TestEvent>) => void } => {
  const seen: string[] = [];
  return { seen, handler: (d) => seen.push(d.message.serial ?? '') };
};

describe('createTransport', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let transport: Transport<TestEvent>;

  beforeEach(() => {
    channel = createMockChannel();
    transport = createTransport({ client: createMockClient(channel), channelName: CHANNEL, codec: createTestCodec() });
  });

  /**
   * Rebuild the channel and the transport over history pages, for a scenario
   * that reads them.
   * @param pages - The pages the channel serves, newest first.
   */
  const withPages = (pages: Ably.InboundMessage[][]): void => {
    channel = createMockChannel(pages);
    transport = createTransport({
      client: createMockClient(channel),
      channelName: CHANNEL,
      codec: createTestCodec(),
    });
  };

  describe('channel resolution', () => {
    it('resolves the channel by name, attributed to the SDK and the codec', () => {
      const client = createMockClient(channel);
      const codec = createTestCodec();
      createTransport({ client, channelName: CHANNEL, codec });
      expect(client.channels.get).toHaveBeenCalledWith(CHANNEL, {
        params: { agent: `ai-transport-js/${VERSION} streaming test-codec/${VERSION}` },
      });
    });

    it('registers the SDK on the client, so the connection it opens is attributed too', () => {
      const client = createMockClient(channel);
      client.options.agents = { 'other-lib': '1.0.0' };
      createTransport({ client, channelName: CHANNEL, codec: createTestCodec() });
      expect(client.options.agents).toEqual({
        'other-lib': '1.0.0',
        'ai-transport-js': VERSION,
        streaming: VERSION,
        'test-codec': VERSION,
      });
    });

    it('leaves the platform echo in place, so a publisher is delivered its own message', () => {
      const client = createMockClient(channel);
      createTransport({ client, channelName: CHANNEL, codec: createTestCodec() });
      expect(client.channels.get.mock.calls[0]?.[1]?.params).not.toHaveProperty('echo');
    });

    it('turns the channel echo off when echoMessages opts out', () => {
      const client = createMockClient(channel);
      createTransport({ client, channelName: CHANNEL, codec: createTestCodec(), echoMessages: false });
      expect(client.channels.get.mock.calls[0]?.[1]?.params?.echo).toBe('false');
    });

    it('requests no modes when none are asked for, so the server applies its default set', () => {
      const client = createMockClient(channel);
      createTransport({ client, channelName: CHANNEL, codec: createTestCodec(), channelModes: [] });
      expect(client.channels.get.mock.calls[0]?.[1]).not.toHaveProperty('modes');
    });

    it('requests the resolved mode set when channelModes opts in', () => {
      const client = createMockClient(channel);
      createTransport({ client, channelName: CHANNEL, codec: createTestCodec(), channelModes: OBJECT_MODES });
      expect(client.channels.get.mock.calls[0]?.[1]?.modes).toEqual(resolveChannelModes(OBJECT_MODES));
    });

    it('throws InvalidArgument for an empty channel name and resolves nothing', () => {
      const client = createMockClient(channel);
      expect(() => createTransport({ client, channelName: '', codec: createTestCodec() })).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
        message: 'unable to create transport; channelName must be a non-empty string',
      });
      expect(client.channels.get).not.toHaveBeenCalled();
    });

    it('wraps a channel that cannot be resolved, keeping the failure as the cause', () => {
      const client = createMockClient(channel);
      // ably-js rejects a name already resolved with options that would
      // reattach the channel, which is how two transports asking for
      // different modes surfaces.
      const conflict = new Ably.ErrorInfo('cannot be used to set channel options', 40000, 400);
      client.channels.get.mockImplementationOnce(() => {
        throw conflict;
      });
      expect(() =>
        createTransport({ client, channelName: CHANNEL, codec: createTestCodec(), channelModes: OBJECT_MODES }),
      ).toThrowErrorInfo({ code: 40000, statusCode: 400, cause: conflict });
    });
  });

  describe('send', () => {
    it('publishes one event as one message and returns the serial', async () => {
      await expect(transport.send({ type: 'note', text: 'hello' })).resolves.toEqual({ serial: 'serial-1' });
      expect(channel.publishCalls).toEqual([{ name: 'test', data: 'hello', extras: { ai: { type: 'note' } } }]);
    });

    it('resolves with no serial when the codec publishes nothing', async () => {
      await expect(transport.send({ type: 'ping' })).resolves.toEqual({ serial: undefined });
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('publishes a stream opener as a one-off', async () => {
      await expect(transport.send({ type: 'text-start', id: 'm1' })).resolves.toEqual({ serial: 'serial-1' });
    });

    it('throws for an event that appends or updates', async () => {
      await expect(transport.send({ type: 'text-delta', id: 'm1', delta: 'x' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      await expect(transport.send({ type: 'text-replace', id: 'm1', text: 'x' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('maps a capability rejection to InsufficientCapability', async () => {
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('denied', 40160, 401));
      await expect(transport.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.InsufficientCapability,
        statusCode: 401,
        message: 'unable to publish; missing publish capability on the channel',
        cause: { code: 40160 },
      });
    });

    it('wraps any other publish failure as SessionSendFailed with the cause', async () => {
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('network', 80000, 500));
      await expect(transport.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfo({
        code: ErrorCode.SessionSendFailed,
        message: 'unable to publish; network',
        cause: { code: 80000 },
      });
    });

    it('throws InternalError when the ack carries no serial', async () => {
      channel.publish.mockResolvedValueOnce({ serials: [] });
      await expect(transport.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InternalError);
    });

    it('lets a codec failure propagate', async () => {
      // CAST: an event outside the union.
      const rogue = { type: 'rogue' } as unknown as TestEvent;
      await expect(transport.send(rogue)).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('publishes every message the codec encodes an event to, in order, and returns the last serial', async () => {
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      await expect(split.send({ type: 'both', a: 'x', b: 'y' })).resolves.toEqual({ serial: 'serial-2' });
      expect(channel.publishCalls.map((m) => m.data as unknown)).toEqual(['x', 'y']);
    });

    it('publishes nothing when any of an event’s messages appends or updates', async () => {
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      await expect(split.send({ type: 'mixed', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('rejects on the first publish that fails and leaves the earlier ones published', async () => {
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      channel.publish
        .mockResolvedValueOnce({ serials: ['serial-1'] })
        .mockRejectedValueOnce(new Ably.ErrorInfo('network', 80000, 500));
      await expect(split.send({ type: 'both', a: 'x', b: 'y' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionSendFailed,
      );
      expect(channel.publish).toHaveBeenCalledTimes(2);
    });

    it("carries the call's headers on every message it publishes", async () => {
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      await split.send({ type: 'both', a: 'x', b: 'y' }, { headers: { requestId: 'r1' } });
      expect(channel.publishCalls.map((m) => headersOf(m))).toEqual([{ requestId: 'r1' }, { requestId: 'r1' }]);
    });

    it('prefers the encoder headers over the pipe headers', async () => {
      // An encode row that writes Ably headers on purpose, which is what the
      // row property is for. The test codec and both shipped codecs write
      // none, so only a codec like this one can collide with a caller.
      interface TaggedEvent {
        type: 'note';
      }
      const tagged = defineCodec({
        name: 'tagged',
        typeOf: (e: TaggedEvent) => e.type,
        events: {
          note: {
            encode: () => ({ headers: { tenant: 'row' } }),
            decode: (): TaggedEvent => ({ type: 'note' }),
          },
        },
      });
      const taggedTransport = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: tagged,
      });
      await taggedTransport.send({ type: 'note' }, { headers: { tenant: 'caller', requestId: 'r1' } });
      expect(channel.publishCalls[0]?.extras).toEqual({
        ai: { type: 'note' },
        headers: { tenant: 'row', requestId: 'r1' },
      });
    });

    it("carries the call's headers alone when the codec's rows write none", async () => {
      await transport.send({ type: 'text-start', id: 'm1' }, { headers: { requestId: 'r1' } });
      expect(channel.publishCalls[0]?.extras).toEqual({
        ai: { type: 'text-start', fields: { id: 'm1' } },
        headers: { requestId: 'r1' },
      });
    });

    it('drops an undefined header value', async () => {
      // CAST: an undefined value is outside MessageHeaders; a JavaScript caller can still pass one.
      const headers = { requestId: 'r1', empty: undefined } as unknown as MessageHeaders;
      await transport.send({ type: 'note', text: 'x' }, { headers });
      expect(headersOf(channel.publishCalls[0] ?? {})).toEqual({ requestId: 'r1' });
    });

    it('rejects InvalidArgument for a header that is not a primitive, before encoding', async () => {
      const codec = createTestCodec();
      const encode = vi.spyOn(codec, 'encode');
      const spied = createTransport({ client: createMockClient(channel), channelName: CHANNEL, codec });
      await expect(spied.send({ type: 'note', text: 'x' }, { headers: badHeaders })).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to send; header 'meta' is not a string, number, boolean or null",
      });
      expect(encode).not.toHaveBeenCalled();
      expect(channel.publishCalls).toHaveLength(0);
    });
  });

  describe('pipe', () => {
    it('writes a stream through its own key table and resolves with the serial of the last publish', async () => {
      const result = await transport.pipe(streamOf<TestEvent>(...textEvents('m1', 'Hello', ' world')));
      // The start, the message the first delta opens, and the end are the
      // publishes; the second delta appends to the message the first opened.
      expect(result).toEqual({ serial: 'serial-3' });
      expect(channel.appendCalls.map((m) => m.serial)).toEqual(['serial-2']);
    });

    it('gives each pipe its own key table', async () => {
      // The same key in two concurrent pipes does not collide: each pipe's
      // first delta opens its own message, and each end closes its own key.
      const [a, b] = await Promise.all([
        transport.pipe(streamOf<TestEvent>(...textEvents('0', 'a', 'b'))),
        transport.pipe(streamOf<TestEvent>(...textEvents('0', 'c', 'd'))),
      ]);
      expect(a.serial).toBeDefined();
      expect(b.serial).toBeDefined();
      expect(a.serial).not.toBe(b.serial);
      expect(channel.publishCalls).toHaveLength(6);
      expect(channel.appendCalls.map((m) => m.data as unknown).toSorted()).toEqual(['b', 'd']);
      expect(new Set(channel.appendCalls.map((m) => m.serial)).size).toBe(2);
    });

    it('rejects OperationCancelled on the caller signal', async () => {
      const controller = new AbortController();
      const pending = transport.pipe(neverEndingStream<TestEvent>(), { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    });

    it("carries the call's headers on the opener, every append, an update, the repair and the closer", async () => {
      // The second delta's append fails and is not recorded (the rejection
      // replaces the mock's recording for that call); the third is recorded.
      // The end repairs the stream with an update, and the replace before it
      // is an update of its own.
      channel.appendMessage.mockRejectedValueOnce(new Error('network'));
      const events: TestEvent[] = [
        ...textEvents('m1', 'a', 'b', 'c').slice(0, -1),
        { type: 'text-replace', id: 'm1', text: 'abc' },
        { type: 'text-end', id: 'm1' },
      ];
      await transport.pipe(streamOf<TestEvent>(...events), { headers: { requestId: 'r1' } });

      // The test codec writes no Ably headers, so each message carries the
      // call's alone.
      const expected = { requestId: 'r1' };
      expect(channel.publishCalls.map((m) => headersOf(m))).toEqual([expected, expected, expected]);
      expect(channel.appendCalls.map((m) => headersOf(m))).toEqual([expected]);
      expect(channel.updateCalls.map((m) => headersOf(m))).toEqual([expected, expected]);
    });

    it('rejects InvalidArgument for a header that is not a primitive, without touching the source', async () => {
      const stream = streamOf<TestEvent>({ type: 'note', text: 'a' });
      await expect(transport.pipe(stream, { headers: badHeaders })).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to pipe; header 'meta' is not a string, number, boolean or null",
      });
      expect(stream.locked).toBe(false);

      const { iterable, state } = asyncIterableOf<TestEvent>({ type: 'note', text: 'a' });
      await expect(transport.pipe(iterable, { headers: badHeaders })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      expect(state.returned).toBe(false);
      expect(channel.publishCalls).toHaveLength(0);
    });
  });

  describe('subscribe', () => {
    it('registers the channel listener and then attaches on the first call', async () => {
      transport.subscribe(noop);
      await flushMicrotasks();
      expect(channel.subscribe).toHaveBeenCalledOnce();
      expect(channel.attach).toHaveBeenCalledOnce();
      const [subOrder = 0] = channel.subscribe.mock.invocationCallOrder;
      const [attachOrder = 0] = channel.attach.mock.invocationCallOrder;
      expect(subOrder).toBeLessThan(attachOrder);
    });

    it('attaches once for any number of subscribers', async () => {
      transport.subscribe(noop);
      transport.subscribe(noop);
      await flushMicrotasks();
      expect(channel.attach).toHaveBeenCalledOnce();
    });

    it('delivers a decoded event with its message', () => {
      const deliveries: unknown[] = [];
      transport.subscribe((d) => deliveries.push(d));
      const message = noteMessage('s1', 'hello');
      channel.listener?.(message);
      expect(deliveries).toEqual([{ event: { type: 'note', text: 'hello' }, message }]);
    });

    it('fans out to every handler and unsubscribes one without the other', () => {
      const first: unknown[] = [];
      const second: unknown[] = [];
      const offFirst = transport.subscribe((d) => first.push(d.event));
      transport.subscribe((d) => second.push(d.event));
      channel.listener?.(noteMessage('s1', 'one'));
      offFirst();
      channel.listener?.(noteMessage('s2', 'two'));
      expect(first).toEqual([{ type: 'note', text: 'one' }]);
      expect(second).toEqual([
        { type: 'note', text: 'one' },
        { type: 'note', text: 'two' },
      ]);
      expect(channel.listener).toBeDefined();
    });

    it('keeps delivering to the other handlers when one throws', () => {
      const seen: unknown[] = [];
      transport.subscribe(() => {
        throw new Error('handler bug');
      });
      transport.subscribe((d) => seen.push(d.event));
      channel.listener?.(noteMessage('s1', 'one'));
      expect(seen).toEqual([{ type: 'note', text: 'one' }]);
    });

    it('delivers a message the codec has nothing for with no event', () => {
      const deliveries: unknown[] = [];
      transport.subscribe((d) => deliveries.push(d));
      const withHeaders = inbound({ serial: 'f1', data: { foreign: true }, extras: { headers: { topic: 'x' } } });
      const bare = inbound({ serial: 'f2', data: 'no extras', extras: undefined });
      channel.listener?.(withHeaders);
      channel.listener?.(bare);
      expect(deliveries).toEqual([
        { event: undefined, message: withHeaders },
        { event: undefined, message: bare },
      ]);
    });

    it('delivers a message whose row returns undefined with no event, and does not report an error', () => {
      const deliveries: unknown[] = [];
      const errors: Ably.ErrorInfo[] = [];
      transport.on('error', (e) => errors.push(e));
      transport.subscribe((d) => deliveries.push(d));
      const message = inbound({ serial: 's1', fields: { type: 'ping' } });
      channel.listener?.(message);
      expect(deliveries).toEqual([{ event: undefined, message }]);
      expect(errors).toEqual([]);
    });

    it('delivers a message whose decode threw with no event, and reports the error', () => {
      const deliveries: unknown[] = [];
      const errors: Ably.ErrorInfo[] = [];
      transport.on('error', (e) => errors.push(e));
      transport.subscribe((d) => deliveries.push(d));
      const message = inbound({ serial: 's1', fields: { type: 'rogue' } });
      channel.listener?.(message);
      expect(deliveries).toEqual([{ event: undefined, message }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfo({
        code: ErrorCode.SessionMessageProcessingFailed,
        cause: { code: ErrorCode.InvalidArgument },
      });
    });

    it('delivers a delete with no event', () => {
      const deliveries: unknown[] = [];
      transport.subscribe((d) => deliveries.push(d));
      channel.listener?.(noteMessage('s1', 'hello'));
      const deletion = inbound({ serial: 's1', action: 'message.delete', fields: { type: 'note' }, version: 's1:v2' });
      channel.listener?.(deletion);
      expect(deliveries).toEqual([
        { event: { type: 'note', text: 'hello' }, message: noteMessage('s1', 'hello') },
        { event: undefined, message: deletion },
      ]);
    });

    it('delivers one delivery per event when the codec decodes a message to several', () => {
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      const deliveries: Delivery<SplitEvent>[] = [];
      split.subscribe((d) => deliveries.push(d));
      // CAST: a fixture inbound message with the name the split codec reads.
      const message = {
        ...inbound({ serial: 's1', data: 'x|y', extras: undefined }),
        name: 'split',
      } as Ably.InboundMessage;
      channel.listener?.(message);
      expect(deliveries.map((d) => d.event)).toEqual([
        { type: 'half', text: 'x' },
        { type: 'half', text: 'y' },
      ]);
      // Both deliveries carry the one message they came from.
      expect(deliveries.map((d) => d.message)).toEqual([message, message]);
    });

    it('delivers a replay of a stream message the codec has already seen with no event', () => {
      const deliveries: Delivery<TestEvent>[] = [];
      transport.subscribe((d) => deliveries.push(d));
      channel.listener?.(deltaMessage('s1', 'hello'));
      channel.listener?.(deltaMessage('s1', 'hello'));
      expect(deliveries.map((d) => d.event)).toEqual([{ type: 'text-delta', id: 'm1', delta: 'hello' }, undefined]);
    });

    it('reports a discontinuity, and stops once its handler is removed', async () => {
      const gaps = vi.fn();
      const off = transport.on('discontinuity', gaps);
      transport.subscribe(noop);
      await flushMicrotasks();
      channel.emitStateChange({ current: 'suspended', previous: 'attached', resumed: false });
      channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });
      expect(gaps).toHaveBeenCalledTimes(2);
      expect(gaps).toHaveBeenLastCalledWith();
      off();
      channel.emitStateChange({ current: 'suspended', previous: 'attached', resumed: false });
      expect(gaps).toHaveBeenCalledTimes(2);
    });

    it('reports a failed attach on the error stream and retries it on the next subscribe', async () => {
      const errors: Ably.ErrorInfo[] = [];
      transport.on('error', (e) => errors.push(e));
      channel.attach.mockRejectedValueOnce(new Ably.ErrorInfo('attach timed out', 90007, 500));
      transport.subscribe(noop);
      await flushMicrotasks();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionSubscriptionFailed);

      transport.subscribe(noop);
      await flushMicrotasks();
      expect(channel.attach).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
    });

    it('keeps the listener registered once every handler has unsubscribed, until close', async () => {
      const seen: unknown[] = [];
      const off = transport.subscribe((d) => seen.push(d.event));
      await flushMicrotasks();
      off();
      off();
      channel.listener?.(noteMessage('s1', 'one'));
      expect(seen).toEqual([]);
      expect(channel.listener).toBeDefined();
      expect(channel.subscribe).toHaveBeenCalledOnce();
    });

    it('returns a stream message a subscriber already received from history with no event', async () => {
      channel = createMockChannel([[deltaMessage('s2', 'two'), noteMessage('s1', 'one')]]);
      transport = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createTestCodec(),
      });
      const deliveries: Delivery<TestEvent>[] = [];
      transport.subscribe((d) => deliveries.push(d));
      channel.listener?.(deltaMessage('s2', 'two'));
      // The recovery pattern after a discontinuity: page history back to the
      // last serial applied. The stream message the handler already saw comes
      // back raw, and the one it missed decodes.
      const page = await transport.history({ limit: 2 });
      expect(page.items.map((d) => [d.message.serial, d.event])).toEqual([
        ['s1', { type: 'note', text: 'one' }],
        ['s2', undefined],
      ]);
    });

    it('throws once closed', async () => {
      await transport.close();
      expect(() => transport.subscribe(noop)).toThrowErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });

  describe('history', () => {
    it('pages backwards from the attach point through the codec', async () => {
      channel = createMockChannel([[noteMessage('s2', 'two')], [noteMessage('s1', 'one')]]);
      transport = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createTestCodec(),
      });
      const first = await transport.history({ limit: 1 });
      expect(first.items.map((d) => d.event)).toEqual([{ type: 'note', text: 'two' }]);
      expect(first.hasNext).toBe(true);
      const second = await first.next();
      expect(second.items.map((d) => d.event)).toEqual([{ type: 'note', text: 'one' }]);
      expect(second.hasNext).toBe(false);
    });

    it('lists one delivery per event when the codec decodes a message to several', async () => {
      // CAST: a fixture inbound message with the name the split codec reads.
      const twin = {
        ...inbound({ serial: 's1', data: 'x|y', extras: undefined }),
        name: 'split',
      } as Ably.InboundMessage;
      channel = createMockChannel([[twin]]);
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      const page = await split.history({ limit: 1 });
      expect(page.items.map((d) => d.event)).toEqual([
        { type: 'half', text: 'x' },
        { type: 'half', text: 'y' },
      ]);
    });

    it('starts a new walk at the attach point on each call', async () => {
      channel = createMockChannel([[deltaMessage('s2', 'two')], [noteMessage('s1', 'one')]]);
      transport = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createTestCodec(),
      });
      const first = await transport.history({ limit: 1 });
      const again = await transport.history({ limit: 1 });
      expect(first.items.map((d) => d.message.serial)).toEqual(['s2']);
      // The same stream message again, raw: the codec decoded it on the first walk.
      expect(again.items.map((d) => [d.message.serial, d.event])).toEqual([['s2', undefined]]);
      expect(channel.history).toHaveBeenCalledTimes(2);
    });

    it('includes a message whose decode threw, with no event, and reports the error', async () => {
      channel = createMockChannel([[inbound({ serial: 's1', fields: { type: 'rogue' } })]]);
      transport = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createTestCodec(),
      });
      const errors: Ably.ErrorInfo[] = [];
      transport.on('error', (e) => errors.push(e));
      const page = await transport.history({ limit: 1 });
      expect(page.items.map((d) => d.event)).toEqual([undefined]);
      expect(errors.map((e) => e.code)).toEqual([ErrorCode.SessionMessageProcessingFailed]);
    });

    it('throws once closed', async () => {
      await transport.close();
      await expect(transport.history({ limit: 1 })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });

  describe('subscribe with history', () => {
    it('replays what the function returns, then the live deliveries buffered during the history replay, in order', async () => {
      withPages([[noteMessage('s2', 'two'), noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const hold = gate();
      const sub = transport.subscribe(handler, {
        history: {
          replay: async (page) => {
            await hold.opened;
            return page.items;
          },
        },
      });
      await flushMicrotasks();
      // A live delivery during the history replay is buffered for this handler.
      channel.listener?.(noteMessage('s3', 'three'));
      expect(seen).toEqual([]);
      hold.open();
      const report = await sub.replayed;
      expect(seen).toEqual(['s1', 's2', 's3']);
      expect(report).toEqual({ replayed: 2, serial: 's3', found: undefined });
      // Live from here.
      channel.listener?.(noteMessage('s4', 'four'));
      expect(seen).toEqual(['s1', 's2', 's3', 's4']);
    });

    it('pages history from the attach point with the page size asked for, 100 by default', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      await transport.subscribe(noop, { history: { replay: (page) => page.items, pageSize: 5 } }).replayed;
      expect(channel.history).toHaveBeenLastCalledWith({ limit: 5, untilAttach: true });
      await transport.subscribe(noop, { history: { replay: (page) => page.items } }).replayed;
      expect(channel.history).toHaveBeenLastCalledWith({ limit: 100, untilAttach: true });
    });

    it('reads every page the function asks for and reports the position reached', async () => {
      withPages([[noteMessage('s3', 'three')], [noteMessage('s2', 'two')], [noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const report = await transport.subscribe(handler, {
        history: {
          replay: async (first) => {
            const out: Delivery<TestEvent>[] = [];
            let page = first;
            for (;;) {
              out.push(...page.items);
              if (!page.hasNext) return out;
              page = await page.next();
            }
          },
          pageSize: 1,
        },
      }).replayed;
      expect(seen).toEqual(['s1', 's2', 's3']);
      expect(report).toMatchObject({ replayed: 3, serial: 's3' });
    });

    it('delivers what the function returned in channel order, whatever order it returned it in', async () => {
      withPages([[noteMessage('s3', 'three')], [noteMessage('s2', 'two')], [noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const report = await transport.subscribe(handler, {
        history: {
          pageSize: 1,
          replay: async (first) => {
            const second = await first.next();
            const third = await second.next();
            return [...first.items, ...third.items, ...second.items];
          },
        },
      }).replayed;
      expect(seen).toEqual(['s1', 's2', 's3']);
      expect(report).toMatchObject({ replayed: 3, serial: 's3' });
    });

    it('keeps the deliveries of one message in the order the codec decoded them', async () => {
      // CAST: a fixture inbound message with the name the split codec reads.
      const twin = {
        ...inbound({ serial: 's1', data: 'x|y', extras: undefined }),
        name: 'split',
      } as Ably.InboundMessage;
      channel = createMockChannel([[twin]]);
      const split = createTransport({
        client: createMockClient(channel),
        channelName: CHANNEL,
        codec: createSplitCodec(),
      });
      const seen: unknown[] = [];
      await split.subscribe((d) => seen.push(d.event), { history: { replay: (page) => page.items } }).replayed;
      expect(seen).toEqual([
        { type: 'half', text: 'x' },
        { type: 'half', text: 'y' },
      ]);
    });

    it('reports a builder verdict', async () => {
      withPages([[noteMessage('s3', 'three'), noteMessage('s2', 'two'), noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const report = await transport.subscribe(handler, { history: { replay: fromSerial('s2', { inclusive: true }) } })
        .replayed;
      expect(seen).toEqual(['s2', 's3']);
      expect(report).toMatchObject({ replayed: 2, found: true });
    });

    it('buffers only the handler that asked for history', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const caught = serialsSeen();
      const plain = serialsSeen();
      const hold = gate();
      const sub = transport.subscribe(caught.handler, {
        history: {
          replay: async (page) => {
            await hold.opened;
            return page.items;
          },
        },
      });
      transport.subscribe(plain.handler);
      await flushMicrotasks();
      channel.listener?.(noteMessage('s2', 'two'));
      expect(plain.seen).toEqual(['s2']);
      expect(caught.seen).toEqual([]);
      hold.open();
      await sub.replayed;
      expect(caught.seen).toEqual(['s1', 's2']);
      expect(plain.seen).toEqual(['s2']);
    });

    it('keeps replaying when the handler throws on one delivery', async () => {
      withPages([[noteMessage('s2', 'two'), noteMessage('s1', 'one')]]);
      const seen: string[] = [];
      const report = await transport.subscribe(
        (d) => {
          if (d.message.serial === 's1') throw new Error('handler bug');
          seen.push(d.message.serial ?? '');
        },
        { history: { replay: (page) => page.items } },
      ).replayed;
      expect(seen).toEqual(['s2']);
      expect(report).toMatchObject({ replayed: 2 });
    });

    it('releases the handler with a gap and rejects when the function throws', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const hold = gate();
      const sub = transport.subscribe(handler, {
        history: {
          replay: async () => {
            await hold.opened;
            throw new Error('replay bug');
          },
        },
      });
      await flushMicrotasks();
      channel.listener?.(noteMessage('s2', 'two'));
      hold.open();
      await expect(sub.replayed).rejects.toBeErrorInfo({
        code: ErrorCode.SessionHistoryFetchFailed,
        message: 'unable to replay history; replay function threw: replay bug',
      });
      // Live from here, with a gap.
      expect(seen).toEqual(['s2']);
      channel.listener?.(noteMessage('s3', 'three'));
      expect(seen).toEqual(['s2', 's3']);
    });

    it('rejects with an ErrorInfo the function throws, as it is', async () => {
      withPages([[noteMessage('s2', 'two')]]);
      const sub = transport.subscribe(noop, { history: { replay: fromSerial('s1', { onExhausted: 'error' }) } });
      await expect(sub.replayed).rejects.toBeErrorInfo({
        code: ErrorCode.SessionHistoryFetchFailed,
        message: 'unable to replay from serial; history ran out before the serial was reached',
      });
    });

    it('does not surface a failed replay as an unhandled rejection when nobody awaits it', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        transport.subscribe(noop, {
          history: {
            replay: () => {
              throw new Error('replay bug');
            },
          },
        });
        await flushMicrotasks();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('stops the history replay and drops the buffered deliveries on unsubscribe, rejecting OperationCancelled', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const hold = gate();
      const sub = transport.subscribe(handler, {
        history: {
          replay: async (page) => {
            await hold.opened;
            return page.items;
          },
        },
      });
      await flushMicrotasks();
      channel.listener?.(noteMessage('s2', 'two'));
      sub();
      hold.open();
      await expect(sub.replayed).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(seen).toEqual([]);
      channel.listener?.(noteMessage('s3', 'three'));
      expect(seen).toEqual([]);
    });

    it('runs one history replay at a time, so a second subscribe with history waits for the first', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const first = serialsSeen();
      const second = serialsSeen();
      const hold = gate();
      const firstSub = transport.subscribe(first.handler, {
        history: {
          replay: async (page) => {
            await hold.opened;
            return page.items;
          },
        },
      });
      const secondSub = transport.subscribe(second.handler, { history: { replay: (page) => page.items } });
      await flushMicrotasks();
      expect(channel.history).toHaveBeenCalledTimes(1);
      expect(second.seen).toEqual([]);
      hold.open();
      await firstSub.replayed;
      await secondSub.replayed;
      expect(channel.history).toHaveBeenCalledTimes(2);
      expect(first.seen).toEqual(['s1']);
      expect(second.seen).toEqual(['s1']);
    });

    it('resolves the report at once with nothing replayed for a subscription without history', async () => {
      await expect(transport.subscribe(noop).replayed).resolves.toEqual({ replayed: 0, serial: undefined });
    });

    it('throws InvalidArgument for a page size below one, registering nothing', () => {
      expect(() =>
        transport.subscribe(noop, { history: { replay: (page) => page.items, pageSize: 0 } }),
      ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(channel.subscribe).not.toHaveBeenCalled();
    });

    it('stops a history replay in flight on close and rejects OperationCancelled', async () => {
      withPages([[noteMessage('s1', 'one')]]);
      const { seen, handler } = serialsSeen();
      const hold = gate();
      const sub = transport.subscribe(handler, {
        history: {
          replay: async (page) => {
            await hold.opened;
            return page.items;
          },
        },
      });
      await flushMicrotasks();
      await transport.close();
      hold.open();
      await expect(sub.replayed).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      expect(seen).toEqual([]);
    });
  });

  describe('close', () => {
    it('unsubscribes the channel listener and stops delivering', async () => {
      const deliveries: unknown[] = [];
      transport.subscribe((d) => deliveries.push(d));
      await flushMicrotasks();
      const listener = channel.listener;
      await transport.close();
      expect(channel.listener).toBeUndefined();
      listener?.(noteMessage('s1', 'x'));
      expect(deliveries).toEqual([]);
    });

    it('aborts pipes in flight, and each rejects OperationCancelled once flushed', async () => {
      const pending = transport.pipe(neverEndingStream<TestEvent>());
      // The expectation is attached before the close so the rejection is
      // handled the moment it happens.
      const outcome = expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
      await transport.close();
      await outcome;
    });

    it('detaches the channel a subscribe attached', async () => {
      transport.subscribe(vi.fn());
      await flushMicrotasks();
      await transport.close();
      expect(channel.detach).toHaveBeenCalledTimes(1);
    });

    it('detaches the channel a history walk attached', async () => {
      await transport.history({ limit: 10 });
      await transport.close();
      expect(channel.detach).toHaveBeenCalledTimes(1);
    });

    it('leaves a channel nothing attached, since send and pipe do not attach', async () => {
      await transport.send({ type: 'note', text: 'x' });
      await transport.pipe(streamOf<TestEvent>(...textEvents('m1', 'a')));
      await transport.close();
      expect(channel.detach).not.toHaveBeenCalled();
    });

    it('detaches only once the pipes in flight have settled', async () => {
      transport.subscribe(vi.fn());
      await flushMicrotasks();
      let settled = false;
      const outcome = transport.pipe(neverEndingStream<TestEvent>()).catch(() => {
        settled = true;
      });
      let settledAtDetach: boolean | undefined;
      channel.detach.mockImplementation(async (): Promise<void> => {
        settledAtDetach = settled;
        await Promise.resolve();
      });
      await transport.close();
      await outcome;
      expect(settledAtDetach).toBe(true);
    });

    it('resolves when the detach fails, since close never rejects', async () => {
      transport.subscribe(vi.fn());
      await flushMicrotasks();
      channel.detach.mockRejectedValue(new Ably.ErrorInfo('detach failed', 90000, 500));
      await expect(transport.close()).resolves.toBeUndefined();
    });

    it('rejects send and pipe once closed', async () => {
      await transport.close();
      await expect(transport.send({ type: 'note', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
      await expect(transport.pipe(streamOf<TestEvent>())).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });

    it('is idempotent', async () => {
      await transport.close();
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
});
