import type * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import type { EncoderCore } from './encoder-core.js';

/**
 * I/O surface that {@link EncoderCore} drives. `Ably.RealtimeChannel`
 * satisfies this interface structurally, so the writer can pass a channel
 * directly without an adapter — the abstraction exists so unit tests can
 * substitute a recorder that captures publishes for assertion.
 */
export interface ChannelWriter {
  /**
   * Publish one or more discrete `message.create` wires atomically. The
   * encoder core uses this for {@link EncoderCore.publish} and
   * {@link EncoderCore.publishBatch}.
   * @param message A single Ably message or an array to publish atomically.
   * @param options Optional Ably publish options (passed through unchanged).
   * @returns The Ably publish result, including server-assigned serials.
   */
  publish(message: Ably.Message | Ably.Message[], options?: Ably.PublishOptions): Promise<Ably.PublishResult>;

  /**
   * Append data to an existing streamed message identified by its serial.
   * Used by {@link EncoderCore.appendStream} and {@link EncoderCore.closeStream}
   * to extend a stream without re-publishing the full payload.
   * @param message The append payload — must carry the create's `serial`.
   * @param operation Optional operation metadata.
   * @param options Optional Ably publish options.
   * @returns The Ably update/delete result.
   */
  appendMessage(
    message: Ably.Message,
    operation?: Ably.MessageOperation,
    options?: Ably.PublishOptions,
  ): Promise<Ably.UpdateDeleteResult>;

  /**
   * Replace the data of an existing message identified by its serial. Used
   * by the encoder core's recovery path: when a `message.append` rejects,
   * the core falls back to publishing the accumulated buffer via
   * `updateMessage` so receivers still see the full content.
   * @param message The replacement payload — must carry the create's `serial`.
   * @param operation Optional operation metadata.
   * @param options Optional Ably publish options.
   * @returns The Ably update/delete result.
   */
  updateMessage(
    message: Ably.Message,
    operation?: Ably.MessageOperation,
    options?: Ably.PublishOptions,
  ): Promise<Ably.UpdateDeleteResult>;
}

/**
 * Per-call options for the content-emitting encoder methods. The codec
 * applies the supplied headers to every wire it emits during the call,
 * merged with the codec's own per-chunk `x-domain-*` headers (codec
 * headers win on key conflict — the codec's correlation headers are
 * protocol-required for the decoder).
 *
 * For streaming (`encodePart` against a `*-start` chunk) the headers are
 * captured as the stream's persistent headers and re-applied on every
 * subsequent append/close — callers do not need to repeat them on
 * `*-delta`/`*-end` chunks of the same stream.
 */
export interface EncodeOptions {
  /**
   * SDK-owned headers (typically `x-ably-msg-id`, `x-ably-role`,
   * `x-ably-run-id`, `x-ably-client-id`) to stamp on every wire emitted
   * by this call.
   */
  headers?: Record<string, string>;
}

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
  /**
   * Create an encoder backed by the given {@link EncoderCore}. The codec
   * depends on the core's primitives, not on the underlying channel — the
   * writer is responsible for constructing the core from a {@link ChannelWriter}.
   * This keeps the codec layer's dependency surface minimal: it knows about
   * `EncoderCore`, nothing else from the I/O side.
   * @param args Wiring for the encoder; see {@link CreateEncoderArgs}.
   * @returns A new encoder bound to the supplied core.
   */
  createEncoder(args: CreateEncoderArgs): Encoder<TPart, TMessage, TEvent>;

  /** Creates a decoder for consuming channel messages into domain parts. */
  createDecoder(): Decoder<TPart, TEvent>;

  /** Creates an accumulator for assembling parts into messages. */
  createAccumulator(): Accumulator<TPart, TMessage, TEvent>;
}

/** Argument bag passed to {@link Codec.createEncoder}. */
export interface CreateEncoderArgs {
  /** Encoder core the encoder will route its wire-emission calls through. */
  core: EncoderCore;
  /** Optional logger inherited by the encoder. */
  logger?: Logger;
}

/**
 * Loose constraint used by types that are generic over a codec. Lets
 * `ClientRun<C>`, `Step<C>`, `SessionWriter<C>`, and the session types
 * accept any concrete {@link Codec} while still constraining `C` to the
 * codec shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCodec = Codec<any, any, any>;

/**
 * Extract the streaming-part type (`TPart`) from a codec type. Used by
 * codec-parameterised interfaces (`ClientRun<C>`, `Step<C>`, etc.) so
 * consumers can name the session variant with a single type argument — the
 * codec — rather than enumerating TPart/TMessage/TEvent at every call
 * site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodecPart<C> = C extends Codec<infer P, any, any> ? P : never;

/** Extract the composed-message type (`TMessage`) from a codec type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodecMessage<C> = C extends Codec<any, infer M, any> ? M : never;

/** Extract the auxiliary-event type (`TEvent`) from a codec type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * Produces channel wire messages from a stream of domain parts, complete
 * domain messages, or codec events. Every content-emitting method drives
 * I/O directly through the {@link EncoderCore} the codec was given —
 * callers do not publish themselves. The encoder is stateful: it owns any
 * in-flight streaming lifecycle for the duration of a step.
 */
export interface Encoder<TPart, TMessage, TEvent = never> {
  /**
   * Encode one streaming domain part. Drives I/O through the bound core
   * (start/append/close primitives for stream chunks, direct publish for
   * discrete chunks). Headers passed via `options.headers` are stamped on
   * every wire emitted by this call; for `*-start` chunks they are also
   * captured as the stream's persistent headers and re-applied on the
   * subsequent `*-delta`/`*-end` chunks of the same stream.
   * @param part The domain part to encode.
   * @param options Per-call wiring; see {@link EncodeOptions}.
   * @returns Resolves once every wire emitted by this call is on the wire
   *   (or, for fire-and-forget appends, scheduled for flush).
   */
  encodePart(part: TPart, options?: EncodeOptions): Promise<void>;

  /**
   * Encode a complete domain message — drives I/O through the bound core
   * (typically one `core.publishBatch(...)` carrying every wire the codec
   * produces for this message). Headers passed via `options.headers` are
   * stamped on every wire.
   * @param message The complete domain message to encode.
   * @param options Per-call wiring; see {@link EncodeOptions}.
   * @returns Resolves once every wire emitted by this call is on the wire.
   */
  encodeMessage(message: TMessage, options?: EncodeOptions): Promise<void>;

  /**
   * Encode a codec event — drives I/O through the bound core. The
   * wire-level message name is the codec's choice (the Vercel codec uses
   * `x-ably-event`); the SDK-owned `x-ably-msg-id` from
   * {@link EncodeEventOptions.messageId} is stamped on the wire so
   * receivers can route the event to the target message.
   * @param event The codec event to encode.
   * @param options Per-call wiring; see {@link EncodeEventOptions}.
   * @returns Resolves once the wire is on the channel.
   */
  encodeEvent(event: TEvent, options?: EncodeEventOptions): Promise<void>;

  /**
   * Flush any in-progress streaming state — closes (status:aborted) any
   * still-open streams, drains pending appends. Idempotent.
   * @returns Resolves once flush completes.
   */
  close(): Promise<void>;
}

/** Options accepted by {@link Encoder.encodeEvent}. */
export interface EncodeEventOptions extends EncodeOptions {
  /**
   * Target message ID for the event. When set, the encoder includes it as
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
   * @param message The inbound channel message to decode.
   * @returns Zero or more decoded values produced by this message.
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
   * @param part The decoded part.
   * @param messageId The message id this part belongs to.
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
   * @param event The decoded event.
   * @param messageId The message id the event targets (when bound).
   */
  applyEvent(event: TEvent, messageId?: string): void;

  /**
   * Return the current assembled state of a message by ID.
   * @param messageId The message id to look up.
   * @returns The composed message, or `undefined` when the id is unknown.
   */
  getMessage(messageId: string): TMessage | undefined;

  /**
   * Replace the assembled state of a message. Called by the transport
   * whenever a published message ID already identifies an assembled
   * message — the same-ID republish path — and by external update paths
   * such as cross-step amendments or corrections from storage.
   * @param messageId The message id to update.
   * @param message The replacement composed message.
   */
  setMessage(messageId: string, message: TMessage): void;

  /**
   * Mark a message as complete so no further parts will contribute to it.
   * No-op if the message is already complete or unknown.
   * @param messageId The message id to complete.
   */
  completeMessage(messageId: string): void;
}
