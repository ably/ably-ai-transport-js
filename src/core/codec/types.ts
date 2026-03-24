/**
 * Core codec interfaces as defined in the general codec specification.
 *
 * These types define the contract between domain event streams and Ably's
 * native message primitives (publish, append, update, delete).
 */

import type * as Ably from 'ably';

// ---------------------------------------------------------------------------
// ChannelWriter — the I/O interface encoders use
// ---------------------------------------------------------------------------

/**
 * The I/O interface that encoders use to publish to a channel.
 * An `Ably.RealtimeChannel` satisfies this directly, but the interface
 * allows mocking, batching, logging, or any other decorator.
 */
export interface ChannelWriter {
  /** Publish one or more discrete messages to the channel. */
  publish(message: Ably.Message | Ably.Message[], options?: Ably.PublishOptions): Promise<Ably.PublishResult>;

  /** Append data to an existing message identified by its serial. */
  appendMessage(
    message: Ably.Message,
    operation?: Ably.MessageOperation,
    options?: Ably.PublishOptions,
  ): Promise<Ably.UpdateDeleteResult>;

  /** Replace the data of an existing message identified by its serial. */
  updateMessage(
    message: Ably.Message,
    operation?: Ably.MessageOperation,
    options?: Ably.PublishOptions,
  ): Promise<Ably.UpdateDeleteResult>;
}

// ---------------------------------------------------------------------------
// WriteOptions — per-write overrides for encoder operations
// ---------------------------------------------------------------------------

/** Shape of the extras object passed through WriteOptions and EncoderOptions. */
export interface Extras {
  /** Headers to attach to the Ably message extras. */
  headers?: Record<string, string>;
}

/** Per-write overrides for encoder operations. */
export interface WriteOptions {
  /** Override the default clientId for this write. */
  clientId?: string;
  /** Override the default extras for this write. */
  extras?: Extras;
  /** Message identity for accumulator correlation. Stamped as `x-ably-msg-id`. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// MessagePayload — shared description of a message for encode and decode
// ---------------------------------------------------------------------------

/**
 * A codec-agnostic description of a discrete Ably message. Used on both sides:
 * - **Encode:** the domain encoder describes what to publish; the encoder core
 *   handles header merging, clientId resolution, and the actual publish.
 * - **Decode:** the decoder core extracts these fields from an `Ably.InboundMessage`
 *   before calling domain hooks, keeping hooks free of Ably SDK types.
 *
 * Data is `unknown` because discrete messages can carry arbitrary payloads
 * (strings, objects, etc.) — Ably handles serialization natively.
 */
export interface MessagePayload {
  /** Ably message name (e.g. "text", "tool-input", "user-message"). */
  name: string;
  /** Message data. Ably handles serialization — strings, objects, and arrays are all valid. */
  data: unknown;
  /** Headers from the Ably message extras. */
  headers?: Record<string, string>;
  /** Mark this message as ephemeral (not persisted in channel history). Only meaningful on encode. */
  ephemeral?: boolean;
}

/**
 * Payload for streamed messages. Data must be a string because
 * the message append lifecycle uses text append/accumulate semantics —
 * deltas are concatenated for recovery and prefix-matching on the decoder.
 */
export interface StreamPayload {
  /** Ably message name (e.g. "text", "reasoning", "tool-input"). */
  name: string;
  /** Initial or closing data for the stream. Must be a string for append/accumulate semantics. */
  data: string;
  /** Headers from the Ably message extras. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// StreamTrackerState — accumulated state of a streamed message
// ---------------------------------------------------------------------------

/**
 * Running state of a streamed message tracked by the decoder core.
 * Accumulates text across appends and tracks lifecycle (open/closed).
 */
export interface StreamTrackerState {
  /** Ably message name (e.g. "text", "reasoning", "tool-input"). */
  name: string;
  /** Stream identifier (e.g. chunk.id for text, toolCallId for tool-input). */
  streamId: string;
  /** Full accumulated text so far. */
  accumulated: string;
  /** Current headers for this stream. Initially set from the first publish, but may be replaced on update. */
  headers: Record<string, string>;
  /** Whether this stream has been closed (finished or aborted). */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// DiscreteEncoder — stateless discrete publish operations
// ---------------------------------------------------------------------------

/**
 * The subset of encoder operations that are stateless — safe for long-lived
 * reuse across turns. Publishes complete messages and discrete events without
 * any streaming lifecycle (no trackers, no pending appends, no close).
 *
 * The server transport calls `writeMessage` to publish user messages to the
 * channel. `writeMessages` publishes multiple messages atomically as a single
 * logical unit (sharing one `x-ably-msg-id`). `writeEvent` is a public API
 * for consumers to publish standalone discrete events outside the streaming
 * flow — it is not called by the transport internally.
 */
export interface DiscreteEncoder<TEvent, TMessage> {
  /** Encode and publish a single domain message (e.g. a user message). */
  writeMessage(message: TMessage, options?: WriteOptions): Promise<Ably.PublishResult>;
  /** Encode and publish multiple domain messages atomically in a single channel publish. */
  writeMessages(messages: TMessage[], options?: WriteOptions): Promise<Ably.PublishResult>;
  /**
   * Encode and publish a single domain event as a standalone discrete message.
   * Available for consumers to publish events outside the streaming flow.
   * Implementations should throw for event types that are only meaningful
   * within a stream (e.g. text deltas).
   */
  writeEvent(event: TEvent, options?: WriteOptions): Promise<Ably.PublishResult>;
}

// ---------------------------------------------------------------------------
// StreamEncoder — maps domain events to Ably channel operations
// ---------------------------------------------------------------------------

/**
 * Full streaming encoder with single-turn lifecycle. Extends
 * `DiscreteEncoder` with stateful streaming operations (`appendEvent` for
 * content streams, `close` to flush). Used by the server transport.
 */
export interface StreamEncoder<TEvent, TMessage> extends DiscreteEncoder<TEvent, TMessage> {
  /** Encode and append a streaming domain event to an in-progress stream (delta semantics). */
  appendEvent(event: TEvent, options?: WriteOptions): Promise<void>;
  /**
   * Abort all in-progress streams and publish a codec-specific abort signal.
   * Called by the transport when a turn is cancelled. Idempotent — calling
   * abort after all streams are already aborted is a no-op.
   * @param reason - Optional reason string for the abort (e.g. 'cancelled').
   */
  abort(reason?: string): Promise<void>;
  /** Flush all pending appends and close the encoder. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// DecoderOutput — unified return type from the decoder
// ---------------------------------------------------------------------------

/**
 * A single output from the decoder: either a domain event or a complete domain message.
 * Event outputs may carry a `messageId` read from the `x-ably-msg-id` header, which the
 * accumulator uses to route events to the correct in-progress message.
 */
export type DecoderOutput<TEvent, TMessage> =
  | { kind: 'event'; event: TEvent; messageId?: string }
  | { kind: 'message'; message: TMessage };

// ---------------------------------------------------------------------------
// StreamDecoder — maps Ably messages to decoder outputs
// ---------------------------------------------------------------------------

/** Decodes Ably messages into domain events and messages. */
export interface StreamDecoder<TEvent, TMessage> {
  /** Decode a single Ably message into zero or more domain outputs. */
  decode(message: Ably.InboundMessage): DecoderOutput<TEvent, TMessage>[];
}

// ---------------------------------------------------------------------------
// MessageAccumulator — builds messages from decoder outputs
// ---------------------------------------------------------------------------

/** Accumulates decoder outputs into a list of domain messages, tracking active streams. */
export interface MessageAccumulator<TEvent, TMessage> {
  /** Process a batch of decoder outputs, updating internal message state. */
  processOutputs(outputs: DecoderOutput<TEvent, TMessage>[]): void;
  /** Apply an external update to a message (e.g. from an update callback). */
  updateMessage(message: TMessage): void;
  /** All messages accumulated so far (in-progress and completed). */
  readonly messages: TMessage[];
  /** Only messages whose streams have finished. */
  readonly completedMessages: TMessage[];
  /** Whether any stream is still actively receiving data. */
  readonly hasActiveStream: boolean;
}

// ---------------------------------------------------------------------------
// Codec — composite interface for transport use
// ---------------------------------------------------------------------------

/** Options passed to a codec's `createEncoder` factory to configure default identity and message hooks. */
export interface EncoderOptions {
  /** Default clientId for all writes. */
  clientId?: string;
  /** Default extras (e.g. headers) merged into every Ably message. */
  extras?: Extras;
  /** Hook called before each Ably message is published. Mutate the message in place to add transport-level headers. */
  onMessage?: (message: Ably.Message) => void;
}

/**
 * The complete codec contract that a core transport needs.
 *
 * Combines factory methods (createEncoder, createDecoder, createAccumulator)
 * with protocol knowledge (isTerminal). Transport-level concerns like turn
 * correlation, echo detection, and cancel signals
 * are handled by the transport layer using standard `x-ably-*` headers.
 */
export interface Codec<TEvent, TMessage> {
  /** Create a streaming encoder bound to the given channel. */
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): StreamEncoder<TEvent, TMessage>;
  /** Create a decoder for converting Ably messages back into domain outputs. */
  createDecoder(): StreamDecoder<TEvent, TMessage>;
  /** Create an accumulator for building domain messages from decoder outputs. */
  createAccumulator(): MessageAccumulator<TEvent, TMessage>;

  /** Whether an event signals stream completion (finish, error, abort). */
  isTerminal(event: TEvent): boolean;

  /** Return a stable key for a message (used by MessageStore for upsert/delete). */
  getMessageKey(message: TMessage): string;
}
