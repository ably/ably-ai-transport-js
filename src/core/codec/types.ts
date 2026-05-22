/**
 * Core codec interfaces for the event-sourced model.
 *
 * The codec describes the wire as a flat stream of TEvent values. A reducer
 * folds events into an opaque TProjection. The SDK extracts TMessage[] from
 * the projection to populate the conversation Tree.
 *
 * All types are framework-agnostic. Domain codecs (e.g. the Vercel codec)
 * choose concrete shapes for TEvent / TProjection / TMessage.
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
  /** Message identity for projection routing. Stamped as `x-ably-msg-id`. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// MessagePayload / StreamPayload — codec-internal wire descriptions
// ---------------------------------------------------------------------------

/**
 * A codec-agnostic description of a discrete Ably message. Used on both sides:
 * - **Encode:** the domain encoder describes what to publish; the encoder core
 *   handles header merging, clientId resolution, and the actual publish.
 * - **Decode:** the decoder core extracts these fields from an
 *   `Ably.InboundMessage` before calling domain hooks, keeping hooks free of
 *   Ably SDK types.
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
 * Payload for streamed messages. Data must be a string because the message
 * append lifecycle uses text append/accumulate semantics — deltas are
 * concatenated for recovery and prefix-matching on the decoder.
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
// Reducer — pure event-sourced state machine
// ---------------------------------------------------------------------------

/**
 * Transport-derived metadata passed alongside each TEvent into `fold`. Read
 * by the SDK from the inbound Ably message and stamped before each fold call.
 */
export interface ReducerMeta {
  /**
   * Ably channel serial of the message that produced this event. The reducer
   * uses this for idempotency / dedup: events at or below the projection's
   * high-water-mark serial must be skipped (no-op return).
   */
  serial: string;
  /**
   * Optional `x-ably-msg-id` from the inbound Ably message. Reducers use this
   * to route an event to a target message within the projection (e.g. to
   * amend an existing message in the same Run).
   */
  messageId?: string;
}

/**
 * Pure, stateless reducer contract. A reducer folds TEvents into an opaque
 * TProjection. The same `(state, event, meta)` triple must produce the same
 * result every time — `fold` is a pure function and the reducer holds no
 * instance state.
 *
 * Idempotency: re-folding an event whose serial has already been incorporated
 * must be a no-op. The reducer is free to store a high-water-mark inside the
 * projection.
 *
 * Mutation: `fold` is allowed to mutate the projection passed in and return
 * it. The caller treats the projection as single-owner and never retains a
 * reference to an old state.
 */
export interface Reducer<TEvent, TProjection> {
  /**
   * Build an empty initial projection. Called once per Run before any events
   * are folded.
   */
  init(): TProjection;
  /**
   * Fold one TEvent into the projection and return the updated projection.
   * The reducer may mutate `state` in place.
   */
  fold(state: TProjection, event: TEvent, meta: ReducerMeta): TProjection;
}

// ---------------------------------------------------------------------------
// Encoder — single-method publication API
// ---------------------------------------------------------------------------

/** Options passed to a codec's `createEncoder` factory. */
export interface EncoderOptions {
  /** Default clientId for all writes. */
  clientId?: string;
  /** Default extras (e.g. headers) merged into every Ably message. */
  extras?: Extras;
  /** Hook called before each Ably message is published. Mutate the message in place to add transport-level headers. */
  onMessage?: (message: Ably.Message) => void;
  /**
   * Default `x-ably-msg-id` for messages where the event payload doesn't
   * supply one. Overridden by `WriteOptions.messageId` per-publish.
   */
  messageId?: string;
}

/**
 * Stateful encoder for a single channel. The codec decides per event type
 * whether `publish` maps to a streamed wire op (start / append / close) or
 * a discrete publish. Stream-tracker state lives inside the encoder.
 */
export interface Encoder<TEvent> {
  /**
   * Encode and publish a single TEvent. Throws synchronously if the codec
   * cannot encode the given event type (e.g. a chunk variant the encoder
   * has no routing for).
   */
  publish(event: TEvent, options?: WriteOptions): Promise<void>;
  /**
   * Abort any in-progress streams and emit a codec-specific abort signal.
   * Idempotent — safe to call after `abort` or `close`.
   * @param reason - Optional reason string for the abort (e.g. 'cancelled').
   */
  abort(reason?: string): Promise<void>;
  /** Flush pending appends and release encoder resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Decoder — flat TEvent[] output
// ---------------------------------------------------------------------------

/**
 * Stateful decoder for a single channel subscription. Maintains internal
 * stream-tracker state across messages so that mid-stream join (history
 * compaction, partial-history page boundary, rewind miss) synthesizes any
 * missing start events before deltas reach the SDK — the reducer always
 * sees a clean `(start, delta*, end)` sequence.
 */
export interface Decoder<TEvent> {
  /** Decode one Ably inbound message into zero or more TEvents. */
  decode(message: Ably.InboundMessage): TEvent[];
}

// ---------------------------------------------------------------------------
// Codec — full contract for the transport
// ---------------------------------------------------------------------------

/**
 * The runtime category of a TEvent, used by the SDK to dispatch a
 * `View.sendEvent` call to the correct publish path. The codec is the only
 * thing that knows how to inspect its TEvents; the core session asks via
 * {@link Codec.classifyEvent}.
 *
 * - `user-message` — a free-standing channel message published as
 *   `x-ably-role: user`. Covers fresh user prompts AND continuation
 *   tool-resolution messages (tool outputs / approval responses). Both
 *   ride the same wire path and the same optimistic-fold path; the
 *   reducer (not the classifier) inline-detects tool resolutions and
 *   folds them onto the prior assistant via `consumedMsgIds`.
 * - `regenerate` — a wire-only channel message that carries run-routing
 *   metadata (`parent`, `forkOf`) in its headers but materialises no
 *   TMessage. The session publishes the wire, mints a `promptId` so the
 *   agent's prompt-lookup catches it, and skips tree-upsert / projection
 *   fold entirely. Produced by `View.regenerate` to start a new run forked
 *   off an assistant message without re-publishing the parent user.
 * - `other` — anything the codec doesn't recognize as a user-message.
 *   The session rejects `view.sendEvent` calls that include `other`-classified
 *   events.
 */
export type EventClassification =
  | {
      /** Discriminator — user-message event variant. */
      kind: 'user-message';
    }
  | {
      /** Discriminator — wire-only regenerate event variant. */
      kind: 'regenerate';
      /** Wire `x-ably-parent` for this regenerate event — the user prompt the regenerated assistant threads under. */
      parent: string;
      /** Wire `x-ably-msg-regenerate` for this regenerate event — the assistant msg-id being regenerated. */
      regenerates: string;
    }
  | {
      /** Discriminator — unrecognized / not-sendable event variant. */
      kind: 'other';
    };

/**
 * The codec describes the wire and folds events into a per-Run projection.
 *
 * Type parameters:
 * - `TEvent` — the union of every type of record that flows on the channel
 *   for this codec. Codec-defined; not constrained to any framework's
 *   chunk type.
 * - `TProjection` — the opaque per-Run state the reducer folds events into.
 *   The SDK never inspects it directly; use {@link Codec.getMessages} to
 *   extract messages for the conversation Tree.
 * - `TMessage` — the per-message shape consumed by the Tree. Returned from
 *   {@link Codec.getMessages}.
 */
export interface Codec<TEvent, TProjection, TMessage> extends Reducer<TEvent, TProjection> {
  /** Create a stateful encoder bound to the given channel. */
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): Encoder<TEvent>;
  /** Create a stateful decoder for converting Ably inbound messages into TEvents. */
  createDecoder(): Decoder<TEvent>;
  /**
   * Extract the per-message list from a projection. The SDK uses the result
   * to upsert per-msgId nodes into the conversation Tree.
   */
  getMessages(projection: TProjection): TMessage[];
  /**
   * Wrap a TMessage as a TEvent suitable for publishing on the channel as a
   * user-message. Used by the agent session's `addMessages` to translate
   * caller-provided TMessages into wire events.
   */
  userMessageEvent(message: TMessage): TEvent;
  /**
   * Build a regenerate TEvent. The View calls this from
   * `regenerate(messageId)`; the resulting event is classified as
   * `kind: 'regenerate'` and published as a wire-only channel message
   * carrying `parent` / `x-ably-msg-regenerate` headers. No TMessage
   * materialises on either client or agent — the agent's prompt-lookup
   * picks the event up via its `promptId` and reads run-routing metadata
   * from headers.
   *
   * The new Run is a CONTINUATION of the regenerated message's Run,
   * not a fork: it has no `forkOf` at the Run level. The message-level
   * replacement (the new assistant supersedes the original) happens at
   * the View's projection-extraction step (Spec: AIT-CT13d).
   * @param regeneratesMsgId - The assistant being regenerated (wire `x-ably-msg-regenerate`).
   * @param parentMsgId - Parent user msg-id for the new assistant chain (wire `x-ably-parent`).
   * @returns A TEvent that `classifyEvent` will classify as `regenerate`.
   */
  createRegenerateEvent(regeneratesMsgId: string, parentMsgId: string): TEvent;
  /**
   * Classify a TEvent for `View.sendEvent` dispatch. The session inspects the
   * returned discriminant to decide whether the event opens a new run
   * (`user-message`), starts a forked regeneration (`regenerate`), or is
   * unsupported on the send path (`other`).
   *
   * Codecs should return `other` rather than throw for unrecognized event
   * types — `_internalSend` is the one place that errors on `other`, which
   * keeps the codec permissive for future wire variants.
   * @param event - The event being sent.
   * @returns The classification driving the publish path.
   */
  classifyEvent(event: TEvent): EventClassification;
  /**
   * Return the existing message id a stream event should be attributed
   * to, based on the projection's current state. Used by `Run.pipe` to
   * override the wire `HEADER_MSG_ID` when a tool-output event (or
   * similar message-modifying event) emitted by `streamText`'s second
   * pass should land on the original message that holds the matching
   * tool call.
   *
   * Codecs implement the lookup over their own projection shape. The
   * Vercel codec, for example, scans `dynamic-tool` parts in
   * `approval-responded` / `approval-requested` state for a matching
   * `toolCallId`.
   *
   * Returns `undefined` when the event has no projection-derived
   * target (the caller's default `messageId` is used).
   * @param event - The event about to be encoded.
   * @param projection - The current per-run projection.
   * @returns The target message id, or `undefined` to use the default.
   */
  resolveToolTarget(event: TEvent, projection: TProjection): string | undefined;
  /**
   * Whether an event signals stream/run completion.
   * @deprecated Temporary bridge. Removed when wire-level `run-end`
   * LifecycleEvents land (Tier 1 #3). Until then the SDK reads this to
   * detect Run completion and clean up observer state.
   */
  isTerminal(event: TEvent): boolean;
}
