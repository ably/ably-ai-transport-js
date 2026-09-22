/**
 * A simulated Ably wire for codec round-trip tests: turn what a codec encodes
 * into the inbound messages a live subscriber would receive, with the serial
 * bookkeeping the pipe writer does on a real channel.
 */

import type * as Ably from 'ably';

import type { Codec, EncodedMessage } from '../../src/core/codec/index.js';
import { ENDS_FIELD, STREAM_FIELD, withOwnField } from '../../src/core/wire.js';

/**
 * Encode every event to the messages it produces.
 * @param codec - The codec.
 * @param events - The events, in order.
 * @returns The encoded messages, in order.
 */
export const encodeAll = <E>(codec: Codec<E>, events: E[]): EncodedMessage[] => events.flatMap((e) => codec.encode(e));

/**
 * The inbound messages a subscriber receives for a sequence of encoded
 * messages: a publish, or an append to a key that is not live, becomes a
 * `message.create` with a fresh serial that is remembered under its key; an
 * append to a live key or an update becomes the matching action on the key's
 * serial with a fresh version; and `ends` forgets its key. The publish that
 * opens a key and every append carry the transport's `stream` field, an update
 * goes without it, and a closer carries `ends` with the serial it ends, as the
 * pipe writer writes them. This mirrors the pipe writer's key table.
 * @param encoded - The encoded messages, in order.
 * @returns The inbound messages, in order.
 */
export const deliveriesOf = (encoded: EncodedMessage[]): Ably.InboundMessage[] => {
  const keys = new Map<string, string>();
  let serials = 0;
  let versions = 0;
  const messages: Ably.InboundMessage[] = [];

  for (const { message, publish, append, update, ends } of encoded) {
    const key = append ?? update;
    const live = key === undefined ? undefined : keys.get(key);
    const ended = ends === undefined ? undefined : keys.get(ends);
    let stamped = ended === undefined ? message : withOwnField(message, ENDS_FIELD, ended);
    if (live === undefined) {
      if (update !== undefined) throw new Error(`no live key '${update}'`);
      serials += 1;
      const serial = `s${String(serials)}`;
      const opens = publish ?? append;
      if (opens !== undefined) {
        keys.set(opens, serial);
        stamped = withOwnField(stamped, STREAM_FIELD, true);
      }
      // CAST: a fixture inbound message with the fields a codec decodes.
      messages.push({ ...stamped, action: 'message.create', serial, version: { serial } } as Ably.InboundMessage);
    } else {
      const serial = live;
      versions += 1;
      const version = `${serial}:v${String(versions)}`;
      const action = append === undefined ? 'message.update' : 'message.append';
      // An append grows the stream, and an `update:` write replaces its
      // content, so only the append carries `stream`.
      if (append !== undefined) stamped = withOwnField(stamped, STREAM_FIELD, true);
      // CAST: as above.
      messages.push({ ...stamped, action, serial, version: { serial: version } } as Ably.InboundMessage);
    }
    if (ends !== undefined) keys.delete(ends);
  }
  return messages;
};

const stringOf = (data: unknown): string => (typeof data === 'string' ? data : '');

/**
 * What history holds after a sequence of encoded messages: one stored message
 * per serial, in publish order, with the appends' `data` joined onto it and the
 * `name` and `extras` of the last write, as Ably's append and update replace
 * them.
 * @param encoded - The encoded messages, in order.
 * @returns The stored messages, oldest first.
 */
export const historyOf = (encoded: EncodedMessage[]): Ably.InboundMessage[] => {
  const stored = new Map<string, Ably.InboundMessage>();
  for (const delivery of deliveriesOf(encoded)) {
    const previous = stored.get(delivery.serial ?? '');
    if (previous === undefined || delivery.action === 'message.update') {
      stored.set(delivery.serial ?? '', { ...delivery, action: 'message.create' });
    } else {
      // CAST: `data` is typed `any`; the fixture joins the strings the codecs stream.
      const data: unknown = stringOf(previous.data) + stringOf(delivery.data);
      stored.set(delivery.serial ?? '', { ...delivery, action: 'message.create', data });
    }
  }
  return [...stored.values()];
};

/**
 * Encode `events` and decode the resulting wire with the same codec.
 * @param codec - The codec.
 * @param events - The events, in order.
 * @returns The decoded events, in order.
 */
export const roundTrip = <E>(codec: Codec<E>, events: E[]): E[] =>
  deliveriesOf(encodeAll(codec, events)).flatMap((m) => codec.decode(m));
