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
 * into the serial an append targets, and delivery. Every message a codec
 * encodes carries the codec's `name` as its message name and the codec's `id`
 * under `extras.ai.codec`, appends and updates included, since Ably replaces
 * the stored name and extras with the last write's; a decoder over the codec
 * reads both to tell its messages from anyone else's. The transport owns two
 * fields under `extras.ai`: `stream`, on every write under a live key, and
 * `ends`, on the message that ends one, carrying the serial it ends. It also adds
 * the headers of the `send` or `pipe` call under `extras.headers`, preferring
 * the codec's own where both name a key. Everything else in `data` and
 * `extras` is the codec's.
 */

import type * as Ably from 'ably';

/**
 * What a codec's `encode` returns for one event: the Ably message to write and
 * where it goes. A message with none of `publish`, `append` or `update` is a
 * plain publish that nothing will append to.
 */
export interface EncodedMessage {
  /** The message the transport publishes, appends or updates. `name`, `data` and `extras` are the codec's, and must carry the codec's `name` and its `id` under `extras.ai.codec`. The transport adds its own two fields under `extras.ai` to a write under a key and to the message that ends one, and adds the call's headers under `extras.headers`, preferring the codec's. */
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
 * from. Every message a decoder is given is delivered: one delivery per event
 * the codec decodes from it, and one with `event: undefined` when there is
 * none: a message that is not the codec's (a foreign publish on the shared
 * channel, or another codec's), a replay the decoder's version guard dropped,
 * a `message.delete`, or a message whose decode threw (the error is reported
 * on the decoder's error stream as well).
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
 * their input, and a codec holds no state. The decoder sits in front of
 * `decode`: it hands on only messages with this codec's `name` and `id`, and
 * runs each through its core first, which drops a delivery already seen and
 * reduces a full-content update to the text not yet handed on. The core reads
 * `data` as a string, so when a hand-written codec updates a stream with
 * object `data`, the update is dropped as adding nothing if the stream has no
 * text yet, and handed on whole as a replacement if earlier writes carried
 * text.
 * @template E - The codec's event union, covering everything either side publishes.
 */
export interface Codec<E> {
  /**
   * The codec's identity. The codec writes it under `extras.ai.codec` on every
   * message it encodes, so a decoder over this codec can tell its messages
   * from another codec's on the same channel. The transport also appends it to
   * its channel's `params.agent`, so traffic is attributed to this codec. An
   * empty id contributes nothing to the attribution. Two codecs that share a
   * channel need different ids.
   */
  readonly id: string;
  /**
   * The name the codec gives every message it encodes. A decoder over this
   * codec decodes only messages with this name and the codec's `id`.
   * `defineCodec` uses `ai` unless told otherwise.
   */
  readonly name: string;
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
   * Decode one Ably message to the events it carries, in order. The decoder
   * calls this only for a message with this codec's `name` and `id`. An empty
   * array is a message that carries no event for the application. `data` is
   * what this delivery adds: an append's fragment, the unseen tail of a
   * full-content update, or a plain publish's body. `defineCodec` builds a
   * codec whose rows produce at most one event; a hand-written codec may fold
   * one message into several. Throws for a message the codec recognises as its own but
   * cannot decode.
   * @param message - The inbound message, as the channel delivered it.
   * @returns The events, in order.
   */
  decode(message: Ably.InboundMessage): E[];
}
