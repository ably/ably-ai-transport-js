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
 * `TEvent` is the codec-defined shape of auxiliary operations that are
 * neither streaming chunks nor complete messages — state transitions applied
 * to an existing message, client-authored tool results, approval responses,
 * and similar side-channel operations. It defaults to `never` for codecs that
 * have no use for it. For the Vercel codec, `TEvent = AI.ToolModelMessage`
 * covers both `addToolApprovalResponse` (via `ToolApprovalResponse` entries)
 * and `addToolOutput` (via `ToolResultPart` entries) in one native AI SDK
 * shape.
 *
 * The codec handles **content messages only**. Lifecycle events
 * (`x-ably-run-*`, `x-ably-step-*`) and control signals (see
 * {@link ControlSignal} — `x-ably-abort`, `x-ably-pause`, `x-ably-resume`,
 * `x-ably-retry`) are SDK-owned: the transport layer filters them out before
 * the decoder is called, and a codec implementor does not need to guard
 * against seeing them.
 */
export interface Codec<TPart, TMessage, TEvent = never> {
  /** Creates an encoder for producing channel messages from domain parts. */
  createEncoder(): Encoder<TPart, TEvent>;

  /** Creates a decoder for consuming channel messages into domain parts. */
  createDecoder(): Decoder<TPart, TEvent>;

  /** Creates an accumulator for assembling parts into messages. */
  createAccumulator(): Accumulator<TPart, TMessage, TEvent>;
}

/**
 * Loose constraint used by types that are generic over a codec. Lets
 * `ClientRun<C>`, `Step<C>`, `SessionWriter<C>`, and the session types
 * accept any concrete {@link Codec} while still constraining `C` to the
 * codec shape.
 */
export type AnyCodec = Codec<any, any, any>;

/**
 * Extract the streaming-part type (`TPart`) from a codec type. Used by
 * codec-parameterised interfaces (`ClientRun<C>`, `Step<C>`, etc.) so
 * consumers can name the session variant with a single type argument — the
 * codec — rather than enumerating TPart/TMessage/TEvent at every call
 * site.
 */
export type CodecPart<C> = C extends Codec<infer P, any, any> ? P : never;

/** Extract the composed-message type (`TMessage`) from a codec type. */
export type CodecMessage<C> = C extends Codec<any, infer M, any> ? M : never;

/** Extract the auxiliary-event type (`TEvent`) from a codec type. */
export type CodecEvent<C> = C extends Codec<any, any, infer E> ? E : never;

/**
 * Output of a decoder: a domain part or event carrying the optional message
 * ID the accumulator uses to route the value to the correct in-progress or
 * existing message.
 */
export type DecodedValue<TPart, TEvent> =
  | {
      /** Discriminator — this decoded value is a streaming part. */
      readonly kind: 'part';
      /** The decoded domain part. */
      readonly part: TPart;
      /** Message ID read from `x-ably-msg-id`, if present. */
      readonly messageId?: string;
    }
  | {
      /** Discriminator — this decoded value is an auxiliary event. */
      readonly kind: 'event';
      /** The decoded codec event. */
      readonly event: TEvent;
      /** Message ID read from `x-ably-msg-id` when the event targets an existing message. */
      readonly messageId?: string;
    };

/**
 * Produces channel messages (domain parts or events encoded onto the wire)
 * from a stream of domain parts. The encoder is stateful — it owns any
 * in-flight streaming lifecycle for the duration of a step.
 */
export interface Encoder<TPart, TEvent = never> {
  /**
   * Encode one domain part and yield the resulting channel messages.
   * The caller publishes them; the encoder does no I/O itself.
   */
  encodePart(part: TPart): Ably.Message[];

  /**
   * Encode one codec event and yield the resulting channel messages. The
   * wire-level message name is the codec's choice (the Vercel codec uses
   * `x-ably-event`); the transport tags it with `x-ably-msg-id` when
   * {@link EncodeEventOptions.messageId} is supplied so receivers can route
   * the event to the target message.
   */
  encodeEvent(event: TEvent, options?: EncodeEventOptions): Ably.Message[];

  /**
   * Flush any in-progress streaming state and yield the closing channel
   * messages. Called once per encoder when the producing stream ends.
   */
  close(): Ably.Message[];
}

/** Options accepted by {@link Encoder.encodeEvent}. */
export interface EncodeEventOptions {
  /**
   * Target message ID for the event. When set, the transport includes it as
   * the `x-ably-msg-id` header so receivers can route the event to the
   * existing message. Omit for free-floating events that don't bind to a
   * specific message.
   */
  messageId?: string;
}

/**
 * Consumes content channel messages and yields decoded parts or events.
 * Stateful — tracks in-flight streams across appends so partial payloads
 * resolve into the same part sequence the encoder produced.
 *
 * The decoder sees only content messages; lifecycle events and control
 * signals are handled by the SDK before this method is called.
 */
export interface Decoder<TPart, TEvent = never> {
  /**
   * Decode one inbound content message into zero or more decoded values.
   * A streaming unit may emit nothing until enough data has arrived. An
   * event message decodes to a single `kind: 'event'` value.
   */
  decode(message: Ably.InboundMessage): DecodedValue<TPart, TEvent>[];
}

/**
 * Assembles a sequence of decoded parts and events into complete domain
 * messages. The accumulator is the bridge between the granular part/event
 * stream and the assembled message shape the session exposes to callers.
 */
export interface Accumulator<TPart, TMessage, TEvent = never> {
  /**
   * Process one decoded part, updating internal per-message state. The
   * optional `messageId` identifies which in-progress message the part
   * contributes to.
   */
  processPart(part: TPart, messageId?: string): void;

  /**
   * Apply one decoded event. When `messageId` is supplied the event targets
   * an existing message — the codec locates it and mutates its composed
   * state (e.g. transitioning a tool part from `'approval-requested'` to
   * `'approval-responded'`). When `messageId` is omitted the event is
   * free-floating; codec-specific semantics apply. Emits a
   * `'message-updated'` tree event if the applied event changes the
   * composed state of a known message.
   */
  applyEvent(event: TEvent, messageId?: string): void;

  /** Return the current assembled state of a message by ID. */
  getMessage(messageId: string): TMessage | undefined;

  /**
   * Replace the assembled state of a message. Called by the transport
   * whenever a published message ID already identifies an assembled
   * message — the same-ID republish path — and by external update paths
   * such as cross-step amendments or corrections from storage.
   */
  setMessage(messageId: string, message: TMessage): void;

  /**
   * Mark a message as complete so no further parts will contribute to it.
   * No-op if the message is already complete or unknown.
   */
  completeMessage(messageId: string): void;
}
