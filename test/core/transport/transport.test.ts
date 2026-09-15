import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Delivery } from '../../../src/core/codec/index.js';
import type { Transport } from '../../../src/core/transport/transport.js';
import { createTransport } from '../../../src/core/transport/transport.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createSplitCodec, type SplitEvent } from '../../helper/split-codec.js';
import { flushMicrotasks } from '../../helper/streams.js';
import { createTestCodec, neverEndingStream, streamOf, type TestEvent, textEvents } from '../../helper/test-codec.js';

// eslint-disable-next-line @typescript-eslint/no-empty-function -- a handler that ignores its deliveries
const noop = (): void => {};

/**
 * The `extras` the builder writes for a set of primitive fields: `type` under
 * `ai`, the rest under `headers` when there are any.
 * @param fields - The fields.
 * @param fields.type - The event type.
 * @returns The extras.
 */
const extrasFor = ({ type, ...headers }: Record<string, unknown>): Record<string, unknown> =>
  Object.keys(headers).length > 0 ? { ai: { type }, headers } : { ai: { type } };

const inbound = (opts: {
  action?: Ably.InboundMessage['action'];
  serial: string;
  data?: unknown;
  /** The builder's fields, all primitive: `type` goes under `extras.ai`, the rest under `extras.headers`. */
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
  inbound({ serial, data: text, extras: { ai: { type: 'text-delta', stream: true }, headers: { id: 'm1' } } });

describe('createTransport', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let transport: Transport<TestEvent>;

  beforeEach(() => {
    channel = createMockChannel();
    transport = createTransport({ channel, codec: createTestCodec() });
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
      const split = createTransport({ channel, codec: createSplitCodec() });
      await expect(split.send({ type: 'both', a: 'x', b: 'y' })).resolves.toEqual({ serial: 'serial-2' });
      expect(channel.publishCalls.map((m) => m.data as unknown)).toEqual(['x', 'y']);
    });

    it('publishes nothing when any of an event’s messages appends or updates', async () => {
      const split = createTransport({ channel, codec: createSplitCodec() });
      await expect(split.send({ type: 'mixed', text: 'x' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      expect(channel.publishCalls).toHaveLength(0);
    });

    it('rejects on the first publish that fails and leaves the earlier ones published', async () => {
      const split = createTransport({ channel, codec: createSplitCodec() });
      channel.publish
        .mockResolvedValueOnce({ serials: ['serial-1'] })
        .mockRejectedValueOnce(new Ably.ErrorInfo('network', 80000, 500));
      await expect(split.send({ type: 'both', a: 'x', b: 'y' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionSendFailed,
      );
      expect(channel.publish).toHaveBeenCalledTimes(2);
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
      const split = createTransport({ channel, codec: createSplitCodec() });
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
      transport = createTransport({ channel, codec: createTestCodec() });
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
      transport = createTransport({ channel, codec: createTestCodec() });
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
      const split = createTransport({ channel, codec: createSplitCodec() });
      const page = await split.history({ limit: 1 });
      expect(page.items.map((d) => d.event)).toEqual([
        { type: 'half', text: 'x' },
        { type: 'half', text: 'y' },
      ]);
    });

    it('starts a new walk at the attach point on each call', async () => {
      channel = createMockChannel([[deltaMessage('s2', 'two')], [noteMessage('s1', 'one')]]);
      transport = createTransport({ channel, codec: createTestCodec() });
      const first = await transport.history({ limit: 1 });
      const again = await transport.history({ limit: 1 });
      expect(first.items.map((d) => d.message.serial)).toEqual(['s2']);
      // The same stream message again, raw: the codec decoded it on the first walk.
      expect(again.items.map((d) => [d.message.serial, d.event])).toEqual([['s2', undefined]]);
      expect(channel.history).toHaveBeenCalledTimes(2);
    });

    it('includes a message whose decode threw, with no event, and reports the error', async () => {
      channel = createMockChannel([[inbound({ serial: 's1', fields: { type: 'rogue' } })]]);
      transport = createTransport({ channel, codec: createTestCodec() });
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
