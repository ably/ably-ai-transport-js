import type * as Ably from 'ably';

/**
 * Translation layer between domain parts and channel operations. The codec
 * is an interface — the session and transport depend on the codec contract
 * and know nothing about the domain model.
 *
 * `TPart` is the granular domain delta type — the smallest unit that arrives
 * on the wire when a message streams in (e.g. Vercel's `UIMessageChunk`,
 * Anthropic's `content_block_delta`, OpenAI Responses' `response.*.delta`).
 * Multiple `TPart`s accumulate into one `TMessage`.
 *
 * The codec handles **content messages only**. Lifecycle events
 * (`x-ably-run-*`, `x-ably-step-*`) and control signals (see
 * {@link ControlSignal} — `x-ably-abort`, `x-ably-pause`, `x-ably-resume`,
 * `x-ably-retry`) are SDK-owned: the transport layer filters them out before
 * the decoder is called, and a codec implementor does not need to guard
 * against seeing them.
 */
export interface Codec<TPart, TMessage> {
  /** Creates an encoder for producing channel messages from domain parts. */
  createEncoder(): Encoder<TPart>;

  /** Creates a decoder for consuming channel messages into domain parts. */
  createDecoder(): Decoder<TPart>;

  /** Creates an accumulator for assembling parts into messages. */
  createAccumulator(): Accumulator<TPart, TMessage>;
}

/**
 * Output of a decoder: a domain part carrying the optional message ID the
 * accumulator uses to route the part to the correct in-progress message.
 */
export interface DecodedPart<TPart> {
  /** The decoded domain part. */
  part: TPart;
  /** Message ID read from `x-ably-msg-id`, if present. */
  messageId?: string;
}

/**
 * Produces channel messages (domain parts encoded onto the wire) from a
 * stream of domain parts. The encoder is stateful — it owns any in-flight
 * streaming lifecycle for the duration of a step.
 */
export interface Encoder<TPart> {
  /**
   * Encode one domain part and yield the resulting channel messages.
   * The caller publishes them; the encoder does no I/O itself.
   */
  encodePart(part: TPart): Ably.Message[];

  /**
   * Flush any in-progress streaming state and yield the closing channel
   * messages. Called once per encoder when the producing stream ends.
   */
  close(): Ably.Message[];
}

/**
 * Consumes content channel messages and yields decoded domain parts.
 * Stateful — tracks in-flight streams across appends so partial payloads
 * resolve into the same part sequence the encoder produced.
 *
 * The decoder sees only content messages; lifecycle events and control
 * signals are handled by the SDK before this method is called.
 */
export interface Decoder<TPart> {
  /**
   * Decode one inbound content message into zero or more domain parts.
   * A streaming unit may emit nothing until enough data has arrived.
   */
  decode(message: Ably.InboundMessage): DecodedPart<TPart>[];
}

/**
 * Assembles a sequence of decoded domain parts into complete domain
 * messages. The accumulator is the bridge between the granular part stream
 * and the assembled message shape the session exposes to callers.
 */
export interface Accumulator<TPart, TMessage> {
  /**
   * Process one decoded part, updating internal per-message state. The
   * optional `messageId` identifies which in-progress message the part
   * contributes to.
   */
  processPart(part: TPart, messageId?: string): void;

  /** Return the current assembled state of a message by ID. */
  getMessage(messageId: string): TMessage | undefined;

  /**
   * Replace the assembled state of a message. Called by the transport
   * whenever a published message ID already identifies an assembled
   * message — the same-ID republish path used by HITL tool-approval
   * responses and other in-place mutation patterns (see
   * {@link ClientRun.sendMessages}) — and by external update paths such
   * as cross-step amendments or corrections from storage.
   */
  setMessage(messageId: string, message: TMessage): void;

  /**
   * Mark a message as complete so no further parts will contribute to it.
   * No-op if the message is already complete or unknown.
   */
  completeMessage(messageId: string): void;
}
