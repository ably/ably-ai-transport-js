/**
 * The codec contract: two functions between a provider's events and Ably
 * messages.
 *
 * A codec maps an event to the Ably messages that carry it on the way out and
 * an Ably message to the events it carries on the way in. The builder's rows
 * are one-to-one; the contract admits zero or several so a hand-written codec
 * can split a payload that is too large for one message, or fold one message
 * into several events. A codec holds the wire format and nothing else: the
 * transport owns the channel, the per-pipe key table that turns a stream key
 * into the serial an append targets, and delivery. The SDK owns two
 * fields on the wire, both the transport's and both under `extras.ai`:
 * `stream`, on every write under a live key, and `ends`, on the message that
 * ends one, carrying the serial it ends. Everything else in `name`, `data` and
 * `extras` is the codec's.
 */

import type * as Ably from 'ably';

/**
 * What a codec's `encode` returns for one event: the Ably message to write and
 * where it goes. A message with none of `publish`, `append` or `update` is a
 * plain publish that nothing will append to.
 */
export interface EncodedMessage {
  /** The message the transport publishes, appends or updates. `name`, `data` and `extras` are the codec's; the transport adds its own two fields under `extras.ai` to a write under a key and to the message that ends one. */
  message: Ably.Message;
  /**
   * Publish `message` and remember the serial the ack returns under this key,
   * so later events can `append` to it or `update` it. Publishing under a key
   * that is still live throws; an author who means to replace the content uses
   * `update`.
   */
  publish?: string;
  /**
   * Append `message.data` to the message remembered under this key (Ably
   * `appendMessage`), or, when no message is live under it, publish `message`
   * and remember the serial the ack returns under the key. A stream's deltas
   * therefore need no opener of their own: the first delta is the publish.
   */
  append?: string;
  /** Replace the content of the message remembered under this key (Ably `updateMessage`). */
  update?: string;
  /** Forget this key once this message has been written. Independent of where the message itself goes. */
  ends?: string;
}

/**
 * One delivery to a subscriber: a decoded event and the Ably message it came
 * from. Every message on the channel is delivered: one delivery per event the
 * codec decodes from it, and one with `event: undefined` when the codec
 * produced none for it: a message that is not the codec's (a foreign publish
 * on the shared channel), a replay the codec's version guard dropped, a
 * `message.delete`, or a message whose decode threw (the error is reported on
 * the transport's error stream as well).
 * @template E - The codec's event union.
 */
export interface Delivery<E> {
  /** The decoded event, or `undefined` when the codec produced none for the message. */
  event: E | undefined;
  /** The Ably message as delivered: `serial`, `clientId`, `timestamp`, `action`, `data` and `extras`. */
  message: Ably.InboundMessage;
}

/**
 * A codec: encode an event to the Ably messages that carry it, decode an Ably
 * message to the events it carries. Both directions are pure functions of
 * their input; any state a codec needs to reduce a full-content update to what
 * it adds lives inside the codec (the builder supplies it), never in the
 * transport.
 * @template E - The codec's event union, covering everything either side publishes.
 */
export interface Codec<E> {
  /**
   * Optional Ably-Agent identifier appended to the channel's `params.agent`
   * by `channelAgent`, so traffic is attributed to this codec. Omit to
   * contribute nothing.
   */
  readonly adapterTag?: string;
  /**
   * Encode one event to the Ably messages that carry it, in the order they are
   * written. An empty array publishes nothing. `defineCodec` builds a codec
   * whose rows each produce at most one message; a hand-written codec may
   * return several, which the transport writes in order. Throws for an event
   * the codec does not know.
   * @param event - The event to encode.
   * @returns The messages and the operation to perform with each, in order.
   */
  encode(event: E): EncodedMessage[];
  /**
   * Decode one Ably message to the events it carries, in order. An empty
   * array is a message that is not this codec's, or that adds nothing (a
   * replay the codec has already seen). `defineCodec` builds a codec whose
   * rows produce at most one event; a hand-written codec may fold one message
   * into several. Throws for a message the codec recognises as its own but
   * cannot decode.
   * @param message - The inbound message, as the channel delivered it.
   * @returns The events, in order.
   */
  decode(message: Ably.InboundMessage): E[];
}
