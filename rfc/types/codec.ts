import type * as Ably from 'ably';

/**
 * Translation layer between domain events and channel operations. The codec
 * is an interface — the session and transport depend on the codec contract
 * and know nothing about the domain model.
 *
 * TEvent is the granular domain event type (e.g., a UIMessageChunk).
 * TMessage is the assembled domain message type (e.g., a UIMessage).
 */
export interface Codec<TEvent, TMessage> {
  /** Creates an encoder for producing channel messages from domain events. */
  createEncoder(): Encoder<TEvent>;

  /** Creates a decoder for consuming channel messages into domain events. */
  createDecoder(): Decoder<TEvent>;

  /** Creates an accumulator for assembling events into messages. */
  createAccumulator(): Accumulator<TEvent, TMessage>;
}

/**
 * Output of a decoder: a domain event carrying the optional message ID
 * the accumulator uses to route the event to the correct in-progress
 * message.
 */
export interface DecodedEvent<TEvent> {
  /** The decoded domain event. */
  event: TEvent;
  /** Message ID read from `x-ably-msg-id`, if present. */
  messageId?: string;
}

/**
 * Produces channel messages (domain events encoded onto the wire) from
 * a stream of domain events. The encoder is stateful — it owns any
 * in-flight streaming lifecycle for the duration of a step.
 */
export interface Encoder<TEvent> {
  /**
   * Encode one domain event and yield the resulting channel messages.
   * The caller publishes them; the encoder does no I/O itself.
   */
  encodeEvent(event: TEvent): Ably.Message[];

  /**
   * Flush any in-progress streaming state and yield the closing channel
   * messages. Called once per encoder when the producing stream ends.
   */
  close(): Ably.Message[];
}

/**
 * Consumes channel messages and yields decoded domain events. Stateful —
 * tracks in-flight streams across appends so partial payloads resolve
 * into the same event sequence the encoder produced.
 */
export interface Decoder<TEvent> {
  /**
   * Decode one inbound Ably message into zero or more domain events.
   * A streaming unit may emit nothing until enough data has arrived.
   */
  decode(message: Ably.InboundMessage): DecodedEvent<TEvent>[];
}

/**
 * Assembles a sequence of decoded domain events into complete domain
 * messages. The accumulator is the bridge between the granular event
 * stream and the assembled message shape the session exposes to callers.
 */
export interface Accumulator<TEvent, TMessage> {
  /**
   * Process one decoded event, updating internal per-message state.
   * The optional `messageId` identifies which in-progress message the
   * event contributes to.
   */
  processEvent(event: TEvent, messageId?: string): void;

  /** Return the current assembled state of a message by ID. */
  getMessage(messageId: string): TMessage | undefined;

  /**
   * Replace the assembled state of a message. Used by external updates
   * (for example, a cross-step amendment or a correction from storage).
   */
  setMessage(messageId: string, message: TMessage): void;

  /**
   * Mark a message as complete so no further events will contribute to
   * it. No-op if the message is already complete or unknown.
   */
  completeMessage(messageId: string): void;
}
