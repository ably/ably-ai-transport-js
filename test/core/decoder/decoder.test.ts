import * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Codec, Delivery } from '../../../src/core/codec/index.js';
import { createDecoder, type Decoder } from '../../../src/core/decoder/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { createTestCodec, type TestEvent, textEvents } from '../../helper/test-codec.js';
import { deliveriesOf, encodeAll, historyOf } from '../../helper/wire.js';

/**
 * The live deliveries and the stored history of the events the test codec
 * encodes, as the transport would write them.
 * @param events - The events, in order.
 * @returns The live messages and the history messages, both oldest first.
 */
const wire = (events: TestEvent[]): { live: Ably.InboundMessage[]; history: Ably.InboundMessage[] } => {
  const encoded = encodeAll(createTestCodec(), events);
  return { live: deliveriesOf(encoded), history: historyOf(encoded) };
};

const eventsOf = (deliveries: Delivery<TestEvent>[]): (TestEvent | undefined)[] => deliveries.map((d) => d.event);

/**
 * A note message as the transport writes it, under another name or codec id when given.
 * @param opts - The overrides.
 * @param opts.name - The message name.
 * @param opts.codec - The codec id under `extras.ai`.
 * @returns The inbound message.
 */
const note = (opts: { name?: string; codec?: string } = {}): Ably.InboundMessage =>
  ({
    action: 'message.create',
    name: opts.name ?? 'ai',
    serial: 's1',
    data: 'hello',
    extras: { ai: { codec: opts.codec ?? 'test-codec', type: 'note' } },
    version: { serial: 's1' },
    // CAST: a minimal InboundMessage stub with the fields the decoder reads.
  }) as Ably.InboundMessage;

describe('createDecoder', () => {
  let decoder: Decoder<TestEvent>;

  beforeEach(() => {
    decoder = createDecoder(createTestCodec());
  });

  describe('decode', () => {
    it('returns one delivery per event, with the message it came from', () => {
      const message = note();
      expect(decoder.decode(message)).toEqual([{ event: { type: 'note', text: 'hello' }, message }]);
    });

    it('returns no event for a message with another name', () => {
      const message = note({ name: 'chat.message' });
      expect(decoder.decode(message)).toEqual([{ event: undefined, message }]);
    });

    it('returns no event for a message another codec wrote', () => {
      const message = note({ codec: 'other-codec' });
      expect(decoder.decode(message)).toEqual([{ event: undefined, message }]);
    });

    it('leaves the stream state alone for a message that is not its own', () => {
      const { live } = wire(textEvents('m1', 'Hello'));
      const [, opener] = live;
      if (opener === undefined) throw new Error('fixture has no opener');
      // The same serial under another codec's id is skipped, so the real
      // opener that follows is still its first sight of the stream.
      decoder.decode({ ...opener, extras: { ai: { codec: 'other-codec', type: 'text-delta' } } });
      expect(eventsOf(decoder.decode(opener))).toEqual([{ type: 'text-delta', id: 'm1', delta: 'Hello' }]);
    });

    it('does not emit what it returns', () => {
      const handler = vi.fn();
      decoder.onEvent(handler);
      decoder.decode(note());
      expect(handler).not.toHaveBeenCalled();
    });

    it('decodes a stream live, delta for delta', () => {
      const { live } = wire(textEvents('m1', 'Hello', ' world'));
      expect(live.flatMap((m) => eventsOf(decoder.decode(m)))).toEqual(textEvents('m1', 'Hello', ' world'));
    });

    it('decodes a message once when history repeats what live delivered', () => {
      const { live, history } = wire([
        { type: 'text-start', id: 'm1' },
        { type: 'text-delta', id: 'm1', delta: 'Hi' },
      ]);
      for (const message of live) decoder.decode(message);
      const [, stored] = history;
      if (stored === undefined) throw new Error('fixture has no stored stream');
      // History holds the stream at the version live already delivered.
      expect(eventsOf(decoder.decode(stored))).toEqual([undefined]);
    });

    it('reduces a full-content update to the text it has not handed on', () => {
      const { live } = wire([{ type: 'text-delta', id: 'm1', delta: 'Hello' }]);
      const [opener] = live;
      if (opener === undefined) throw new Error('fixture has no opener');
      decoder.decode(opener);
      const update = { ...opener, action: 'message.update', data: 'Hello world', version: { serial: 's1:v9' } };
      // CAST: the opener with the action and version a late full-content update carries.
      expect(eventsOf(decoder.decode(update as Ably.InboundMessage))).toEqual([
        { type: 'text-delta', id: 'm1', delta: ' world' },
      ]);
    });

    it('decodes history fed newest first, where the closer comes before its stream', () => {
      const { history } = wire(textEvents('m1', 'Hello', ' world'));
      const decoded = history.toReversed().flatMap((m) => eventsOf(decoder.decode(m)));
      expect(decoded).toEqual(textEvents('m1', 'Hello world').toReversed());
    });

    it('returns no event for a delete', () => {
      const message = { ...note(), action: 'message.delete' };
      // CAST: a note with the action a delete carries.
      expect(eventsOf(decoder.decode(message as Ably.InboundMessage))).toEqual([undefined]);
    });

    it('forgets a stream on a bare delete that carries no name or codec id', () => {
      const { live } = wire([{ type: 'text-delta', id: 'm1', delta: 'Hello' }]);
      const [opener] = live;
      if (opener === undefined) throw new Error('fixture has no opener');
      decoder.decode(opener);
      // CAST: a delete as `deleteMessage({ serial })` delivers it, with no name or extras.
      const bare = { action: 'message.delete', serial: opener.serial, version: {} } as Ably.InboundMessage;
      expect(decoder.decode(bare)).toEqual([{ event: undefined, message: bare }]);
      // The core forgot the serial, so the same create decodes again rather
      // than being dropped as a duplicate.
      expect(eventsOf(decoder.decode(opener))).toEqual([{ type: 'text-delta', id: 'm1', delta: 'Hello' }]);
    });

    it('returns a message whose decode threw with no event, and reports the error', () => {
      const failing: Codec<TestEvent> = {
        id: 'test-codec',
        name: 'ai',
        encode: () => [],
        decode: () => {
          throw new Ably.ErrorInfo('bad row', ErrorCode.InvalidArgument, 400);
        },
      };
      const errors: Ably.ErrorInfo[] = [];
      const failingDecoder = createDecoder(failing);
      failingDecoder.onError((error) => errors.push(error));
      const message = note();
      expect(failingDecoder.decode(message)).toEqual([{ event: undefined, message }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfo({
        code: ErrorCode.SessionMessageProcessingFailed,
        message: 'unable to process channel message; bad row',
        cause: { code: ErrorCode.InvalidArgument },
      });
    });
  });

  describe('receive', () => {
    it('emits each delivery to every onEvent handler, unbound', () => {
      const first: Delivery<TestEvent>[] = [];
      const second: Delivery<TestEvent>[] = [];
      decoder.onEvent((d) => first.push(d));
      decoder.onEvent((d) => second.push(d));
      // Unbound, as `channel.subscribe(decoder.receive)` calls it.
      const { receive } = decoder;
      const message = note();
      receive(message);
      expect(first).toEqual([{ event: { type: 'note', text: 'hello' }, message }]);
      expect(second).toEqual(first);
    });

    it('emits a message that is not its own with no event', () => {
      const seen: Delivery<TestEvent>[] = [];
      decoder.onEvent((d) => seen.push(d));
      const message = note({ name: 'chat.message' });
      decoder.receive(message);
      expect(seen).toEqual([{ event: undefined, message }]);
    });

    it('keeps emitting to the other handlers when one throws', () => {
      const seen: Delivery<TestEvent>[] = [];
      decoder.onEvent(() => {
        throw new Error('handler failed');
      });
      decoder.onEvent((d) => seen.push(d));
      decoder.receive(note());
      expect(seen).toHaveLength(1);
    });

    it('stops emitting to a handler once unsubscribed', () => {
      const handler = vi.fn();
      const off = decoder.onEvent(handler);
      off();
      decoder.receive(note());
      expect(handler).not.toHaveBeenCalled();
    });

    it('stops reporting errors to a handler once unsubscribed', () => {
      const failing: Codec<TestEvent> = {
        id: 'test-codec',
        name: 'ai',
        encode: () => [],
        decode: () => {
          throw new Error('bad row');
        },
      };
      const failingDecoder = createDecoder(failing);
      const handler = vi.fn();
      const off = failingDecoder.onError(handler);
      off();
      failingDecoder.receive(note());
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
