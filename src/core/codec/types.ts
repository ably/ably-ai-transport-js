/**
 * Core codec interfaces — the wire tier.
 *
 * A codec encodes and decodes: it describes the wire as a flat stream of
 * TInput / TOutput values and does nothing else. Merging events into messages
 * is the application's job, so no reducer or projection contract lives here.
 *
 * All types are framework-agnostic. Domain codecs (e.g. the Vercel codec)
 * choose concrete shapes for TInput / TOutput.
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
// Extras / WriteOptions — per-write overrides for encoder operations
// ---------------------------------------------------------------------------

/** Shape of the extras config passed through WriteOptions and EncoderOptions. */
export interface Extras {
  /** Transport-tier headers to attach to the message's `extras.ai.transport` namespace. */
  headers?: Record<string, string>;
}

/** Per-write overrides for encoder operations. */
export interface WriteOptions {
  /** Override the default extras for this write. */
  extras?: Extras;
  /** Message identity for consumer-side routing. Stamped as `transport-message-id`. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// MessagePayload / StreamPayload — codec-internal wire descriptions
// ---------------------------------------------------------------------------

/**
 * A codec-agnostic description of a discrete Ably message. Used on both sides:
 * - **Encode:** the domain encoder describes what to publish; the encoder core
 *   handles header merging and the actual publish.
 * - **Decode:** the decoder core extracts these fields from an
 *   `Ably.InboundMessage` before calling domain hooks, keeping hooks free of
 *   Ably SDK types.
 *
 * Data is `unknown` because discrete messages can carry arbitrary payloads
 * (strings, objects, etc.) — Ably handles serialization natively.
 */
export interface MessagePayload {
  /** Ably message name — the wire direction (`ai-output` / `ai-input`). */
  name: string;
  /** Message data. Ably handles serialization — strings, objects, and arrays are all valid. */
  data: unknown;
  /** Codec-tier headers — the codec's own fields, carried under `extras.ai.codec`. */
  codecHeaders?: Record<string, string>;
  /**
   * Transport-tier headers a codec needs to stamp directly (e.g. `role`,
   * `status`), carried under `extras.ai.transport`. Most codec payloads leave
   * this unset and let the transport layer supply transport headers via config.
   */
  transportHeaders?: Record<string, string>;
  /** Mark this message as ephemeral (not persisted in channel history). Only meaningful on encode. */
  ephemeral?: boolean;
}

/**
 * Payload for streamed messages. Data must be a string because the message
 * append lifecycle uses text append/accumulate semantics — deltas are
 * concatenated for recovery and prefix-matching on the decoder.
 */
export interface StreamPayload {
  /** Ably message name — `ai-output` (only outputs stream); not the codec `kind` / stream group. */
  name: string;
  /** Initial or closing data for the stream. Must be a string for append/accumulate semantics. */
  data: string;
  /** Codec-tier headers — the codec's own fields, carried under `extras.ai.codec`. */
  codecHeaders?: Record<string, string>;
  /**
   * Transport-tier headers a codec needs to stamp directly (e.g. `role`,
   * `status`), carried under `extras.ai.transport`.
   */
  transportHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// StreamSequenceState — accumulated state of a streamed message
// ---------------------------------------------------------------------------

/**
 * Running state of a streamed message tracked by the decoder core.
 * Accumulates text across appends and tracks lifecycle (open/closed).
 */
export interface StreamSequenceState {
  /** Ably message name — `ai-output` (only outputs stream); not the codec `kind` / stream group. */
  name: string;
  /** Stream identifier (e.g. chunk.id for text, toolCallId for tool-input). */
  streamId: string;
  /** Full accumulated text so far. */
  accumulated: string;
  /**
   * Current codec-tier headers (`extras.ai.codec`) for this stream. Initially
   * set from the first publish, but may be replaced on update.
   */
  codecHeaders: Record<string, string>;
  /**
   * Current transport-tier headers (`extras.ai.transport`) for this stream.
   * Initially set from the first publish, but may be replaced on update.
   */
  transportHeaders: Record<string, string>;
  /**
   * Highest `Message.version.serial` incorporated into this tracker.
   * Versions are lexicographically comparable within one message serial, so
   * a delivery carrying a version at or below this value is already
   * incorporated and decodes to nothing. Stamped at first contact (a
   * never-mutated message's version serial equals the message serial, which
   * is also the fallback when the version carries no serial) and advanced by
   * each version-bearing delivery.
   */
  version: string;
  /** Whether this stream has been closed (complete or cancelled). */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Encoder — direction-typed publication API
// ---------------------------------------------------------------------------

/** Options passed to a codec's `createEncoder` factory. */
export interface EncoderOptions {
  /** Default extras (e.g. headers) merged into every Ably message. */
  extras?: Extras;
  /** Hook called before each Ably message is published. Mutate the message in place to add transport-level headers under `extras.ai`. */
  onAblyMessage?: (message: Ably.Message) => void;
  /**
   * Fallback domain message id surfaced to output escape hatches as
   * `ctx.messageId` (e.g. the Vercel `start` hatch injects it when a chunk
   * carries no `messageId` of its own). Unrelated to the
   * `transport-message-id` wire header, which the transport tier owns and
   * `WriteOptions.messageId` stamps.
   */
  messageId?: string;
}

/**
 * Stateful encoder for a single channel. Two publish methods enforce
 * direction at the call site — `publishInput` for client-published events
 * (`ai-input` wire) and `publishOutput` for agent-published events
 * (`ai-output` wire). Stream-tracker state lives inside the encoder and
 * is shared across both directions.
 */
export interface Encoder<TInput, TOutput> {
  /**
   * Encode and publish a single client input on the `ai-input` wire.
   * Rejects if the codec cannot encode the given input
   * variant.
   * @returns The publish acknowledgement — the Ably-assigned serials, one per
   *   wire message the input produced (a batch input fans out), in publish
   *   order.
   */
  publishInput(input: TInput, options?: WriteOptions): Promise<Ably.PublishResult>;
  /**
   * Encode and publish a single agent output on the `ai-output` wire.
   * Rejects if the codec cannot encode the given output
   * variant.
   */
  publishOutput(output: TOutput, options?: WriteOptions): Promise<void>;
  /**
   * Close all in-progress streamed messages as cancelled (status:cancelled) and
   * flush pending appends. Pure transport mechanics — emits no codec output.
   * Idempotent: streams already cancelled are not re-appended. Must not be
   * called after `close`; doing so throws because the encoder is already closed.
   * Run termination is signalled separately by the transport `ai-run-end` event.
   */
  cancelStreams(): Promise<void>;
  /** Flush pending appends and release encoder resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Decoder — direction-tagged output
// ---------------------------------------------------------------------------

/**
 * Tagged result of decoding one inbound Ably message — the codec routes
 * by the wire `name` and returns inputs and outputs separately so the
 * SDK never has to introspect direction.
 */
export interface DecodedMessage<TInput, TOutput> {
  /** Inputs decoded from the inbound message (only populated when the wire `name` is `ai-input`). */
  inputs: TInput[];
  /** Outputs decoded from the inbound message (only populated when the wire `name` is `ai-output`). */
  outputs: TOutput[];
}

/**
 * Stateful decoder for a single channel subscription. Maintains internal
 * stream-tracker state across messages so that mid-stream join (history
 * compaction, partial-history page boundary, rewind miss) synthesizes any
 * missing start events before deltas leave the decoder — a consumer's merge
 * (the provider's own strict reducer included) always sees a clean
 * `(start, delta*, end)` sequence. That repair is a contract, not a
 * convenience: the provider reducers throw on a delta with no opener.
 *
 * Trackers are version-guarded: a delivery whose `Message.version.serial`
 * is at or below the version already incorporated decodes to nothing. One
 * decoder instance can therefore be shared by the live subscription and
 * history hydration — whichever route delivers a message's content first
 * wins, and the other route's covered deliveries are no-ops.
 */
export interface Decoder<TInput, TOutput> {
  /** Decode one Ably inbound message into the input/output halves. */
  decode(message: Ably.InboundMessage): DecodedMessage<TInput, TOutput>;
}

// ---------------------------------------------------------------------------
// WireCodec — the wire tier: everything a transport needs
// ---------------------------------------------------------------------------

/**
 * A codec: encode and decode, nothing else. This is the whole contract the
 * transports require — they publish inputs and classify inbound messages
 * without ever merging a projection, so they stay parameterized by `TInput` /
 * `TOutput` alone. The transport carries both as opaque values and never
 * inspects them; a codec's `TInput` is simply its own body union.
 * @template TInput - The union of input bodies the client publishes on the
 *   `ai-input` wire.
 * @template TOutput - The union of output events the agent publishes on the
 *   `ai-output` wire.
 */
export interface WireCodec<TInput, TOutput> {
  /**
   * Optional Ably-Agent identifier. When present, the caller stamps it on the
   * channel alongside this SDK's own agent, so traffic is attributed to this
   * codec; when absent, the codec opts out. Read by `channelAgent`, which
   * renders the `params.agent` string.
   */
  readonly adapterTag?: string;
  /** Create a stateful encoder bound to the given channel. */
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): Encoder<TInput, TOutput>;
  /** Create a stateful decoder for converting Ably inbound messages into typed inputs and outputs. */
  createDecoder(): Decoder<TInput, TOutput>;
}
