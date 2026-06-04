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

/** Shape of the extras config passed through WriteOptions and EncoderOptions. */
export interface Extras {
  /** Transport-tier headers to attach to the message's `extras.ai.transport` namespace. */
  headers?: Record<string, string>;
}

/** Per-write overrides for encoder operations. */
export interface WriteOptions {
  /** Override the default clientId for this write. */
  clientId?: string;
  /** Override the default extras for this write. */
  extras?: Extras;
  /** Message identity for projection routing. Stamped as `codec-message-id`. */
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
  /** Ably message name (e.g. "text", "reasoning", "tool-input"). */
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
  /** Whether this stream has been closed (complete or cancelled). */
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
   * Optional `codec-message-id` from the inbound Ably message. Reducers use this
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
// Encoder — direction-typed publication API
// ---------------------------------------------------------------------------

/** Options passed to a codec's `createEncoder` factory. */
export interface EncoderOptions {
  /** Default clientId for all writes. */
  clientId?: string;
  /** Default extras (e.g. headers) merged into every Ably message. */
  extras?: Extras;
  /** Hook called before each Ably message is published. Mutate the message in place to add transport-level headers under `extras.ai`. */
  onMessage?: (message: Ably.Message) => void;
  /**
   * Default `codec-message-id` for messages where the event payload doesn't
   * supply one. Overridden by `WriteOptions.messageId` per-publish.
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
export interface Encoder<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
  /**
   * Encode and publish a single client input on the `ai-input` wire.
   * Throws synchronously if the codec cannot encode the given input
   * variant.
   */
  publishInput(input: TInput, options?: WriteOptions): Promise<void>;
  /**
   * Encode and publish a single agent output on the `ai-output` wire.
   * Throws synchronously if the codec cannot encode the given output
   * variant.
   */
  publishOutput(output: TOutput, options?: WriteOptions): Promise<void>;
  /**
   * Cancel any in-progress streams and emit a codec-specific cancel signal.
   * Idempotent — safe to call after `cancel` or `close`.
   * @param reason - Optional reason string for the cancellation (e.g. 'cancelled').
   */
  cancel(reason?: string): Promise<void>;
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
export interface DecodedMessage<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
  /** Inputs decoded from the inbound message (only populated when the wire `name` is `ai-input`). */
  inputs: TInput[];
  /** Outputs decoded from the inbound message (only populated when the wire `name` is `ai-output`). */
  outputs: TOutput[];
}

/**
 * Stateful decoder for a single channel subscription. Maintains internal
 * stream-tracker state across messages so that mid-stream join (history
 * compaction, partial-history page boundary, rewind miss) synthesizes any
 * missing start events before deltas reach the SDK — the reducer always
 * sees a clean `(start, delta*, end)` sequence.
 */
export interface Decoder<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> {
  /** Decode one Ably inbound message into the input/output halves. */
  decode(message: Ably.InboundMessage): DecodedMessage<TInput, TOutput>;
}

// ---------------------------------------------------------------------------
// Codec input events — well-known input variant shapes
// ---------------------------------------------------------------------------

/**
 * Structural base every codec input variant must satisfy. Codec authors
 * compose their `TInput` union from variants extending this type; the
 * transport reads the routing fields directly off the variant to stamp
 * wire headers, so no runtime classification step is needed.
 *
 * The `kind` discriminator is required on every variant so the codec's
 * reducer can switch on it. Codec authors pick the literal value per
 * variant; the SDK ships well-known literals (`'user-message'`,
 * `'regenerate'`, `'edit'`) — see {@link UserMessage},
 * {@link Regenerate}, {@link Edit}.
 */
export interface CodecInputEvent {
  /**
   * Discriminator. Codec authors pick the literal value per variant. The
   * SDK reserves the literals used by well-known variants
   * ({@link UserMessage}, {@link Regenerate}, {@link Edit});
   * codec-specific variants pick any other literal.
   */
  kind: string;
  /**
   * Sets the wire `parent` header — the codec-message-id of the
   * preceding codec-message on this branch. When omitted, the SDK
   * auto-computes the parent from the visible branch tail at send time.
   */
  parent?: string;
  /**
   * Pointer to another codec-message this input references. The semantic
   * depends on `kind` — for `regenerate`, the assistant codec-message to
   * regenerate; for `edit`, the codec-message to replace; codec-specific
   * `kind`s may give it other meanings. The input event itself does not
   * create a fork — it requests one. The fork relationship is established
   * on the agent's response (and on `ai-run-start`), which the codec
   * encoder maps `target` to via the wire's `fork-of` header.
   */
  target?: string;
  /**
   * Targets an existing codec-message-id instead of minting a fresh one.
   * Used by continuation inputs (tool results, approval responses) that
   * amend an existing assistant message rather than creating a new one;
   * the wire's `codec-message-id` is stamped with this value so
   * the reducer's direct-fold path matches by codec-message-id.
   */
  codecMessageId?: string;
}

/**
 * Well-known input variant: a new user message in the codec's domain
 * representation. Pinned `kind: 'user-message'`. Produced by the SDK's
 * `Codec.createUserMessage` factory and published via `View.send`
 * (e.g. `view.send(codec.createUserMessage(message))`).
 * @template TMessage - The codec's per-message domain type.
 */
export interface UserMessage<TMessage> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'user-message';
  /** The user's message in the codec's domain representation. */
  message: TMessage;
}

/**
 * Well-known input variant: request that an existing assistant
 * codec-message be regenerated. Pinned `kind: 'regenerate'`. This event
 * is a signal, not itself a fork — `target` names the assistant message
 * to regenerate, and `parent` names the user message the new assistant
 * threads under. Both are required; the codec cannot regenerate without
 * both. Produced by the SDK's `Codec.createRegenerate` factory and
 * surfaced via `View.regenerate`.
 */
export interface Regenerate extends CodecInputEvent {
  /** Discriminator. */
  kind: 'regenerate';
  /** The codec-message-id of the assistant to regenerate. Required. */
  target: string;
  /** The codec-message-id of the parent user message the new assistant threads under. Required. */
  parent: string;
}

/**
 * Well-known input variant: request that an existing codec-message be
 * replaced with new content. Pinned `kind: 'edit'`. This event is a
 * signal, not itself a fork — `target` names the codec-message to
 * replace, and `parent` names the preceding codec-message on the new
 * branch. Carries the replacement content in the codec's domain
 * representation.
 *
 * Codecs opt in to edit support by including this variant in their
 * `TInput` union; the SDK does not require it.
 * @template TMessage - The codec's per-message domain type.
 */
export interface Edit<TMessage> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'edit';
  /** The codec-message-id of the codec-message to replace. Required. */
  target: string;
  /** The codec-message-id of the preceding codec-message on the new branch. Required. */
  parent: string;
  /** The replacement content in the codec's domain representation. */
  message: TMessage;
}

/**
 * Well-known input variant: client-published tool result (success). The
 * tool ran and produced output. Mutates the assistant codec-message
 * addressed by `codecMessageId` — the codec's reducer applies the result
 * onto the existing tool-call state of the referenced assistant.
 *
 * The core is domain-independent: it knows only that this input amends the
 * assistant at `codecMessageId` and carries a codec-defined `payload`. The
 * shape of `payload` (e.g. the tool-call id and output value) is supplied
 * by the codec via `TPayload` — see the Vercel layer's payload type.
 *
 * Codecs opt in to client-side tool resolution by including this variant
 * in their `TInput` union. Codecs whose domain model doesn't natively
 * distinguish client-side tool results as a top-level event type (e.g.
 * Anthropic Messages, where tool results are normally embedded in a
 * user-role message) can still use this variant — the codec's reducer
 * translates the wire-level update into the codec's domain representation.
 * @template TPayload - The codec's domain payload for a tool result.
 */
export interface ToolResult<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-result';
  /** The assistant codec-message containing the tool call. Required. */
  codecMessageId: string;
  /** The codec's domain payload describing the tool result. */
  payload: TPayload;
}

/**
 * Well-known input variant: client-published tool result (failure). The
 * tool ran and failed. Mutates the assistant codec-message addressed by
 * `codecMessageId`. The failure detail (e.g. tool-call id and error text)
 * is the codec's domain `payload` — see the Vercel layer's payload type.
 * @template TPayload - The codec's domain payload for a tool-result failure.
 */
export interface ToolResultError<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-result-error';
  /** The assistant codec-message containing the tool call. Required. */
  codecMessageId: string;
  /** The codec's domain payload describing the failure. */
  payload: TPayload;
}

/**
 * Well-known input variant: client-published response to an
 * agent-emitted tool-approval request. Mutates the assistant
 * codec-message addressed by `codecMessageId` — flipping the targeted
 * tool call from pending-approval to approved or denied. The decision
 * detail (e.g. tool-call id, approved flag, reason) is the codec's domain
 * `payload` — see the Vercel layer's payload type.
 *
 * Codecs may layer approval semantics on top of domain models that don't
 * natively support gating tool execution behind an approval — the codec
 * is responsible for mapping the decision into its own representation.
 * @template TPayload - The codec's domain payload for an approval response.
 */
export interface ToolApprovalResponse<TPayload> extends CodecInputEvent {
  /** Discriminator. */
  kind: 'tool-approval-response';
  /** The assistant codec-message containing the tool call. Required. */
  codecMessageId: string;
  /** The codec's domain payload describing the approval decision. */
  payload: TPayload;
}

/**
 * Extract the domain `payload` type of a codec's {@link ToolResult} member
 * from its `TInput` union, or `never` if the codec has no tool-result
 * variant. Used to type {@link Codec.createToolResult} without adding a
 * standalone type parameter to the codec.
 * @template TInput - The codec's input union.
 */
export type ToolResultPayloadOf<TInput> = TInput extends ToolResult<infer P> ? P : never;

/**
 * Extract the domain `payload` type of a codec's {@link ToolResultError}
 * member from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type ToolResultErrorPayloadOf<TInput> = TInput extends ToolResultError<infer P> ? P : never;

/**
 * Extract the domain `payload` type of a codec's {@link ToolApprovalResponse}
 * member from its `TInput` union, or `never` if absent.
 * @template TInput - The codec's input union.
 */
export type ToolApprovalResponsePayloadOf<TInput> = TInput extends ToolApprovalResponse<infer P> ? P : never;

// ---------------------------------------------------------------------------
// Codec output events — base shape for the output side
// ---------------------------------------------------------------------------

/**
 * Structural base every codec output variant must satisfy. The output
 * counterpart of {@link CodecInputEvent}: pins a `type` discriminator so
 * the SDK can reliably narrow `TInput | TOutput` (inputs carry `kind`,
 * outputs carry `type`) and reserves a contract for future routing
 * fields on outputs without a breaking generic-arity change.
 *
 * The `type` discriminator is required on every variant so the codec's
 * reducer can switch on it. `AI.UIMessageChunk` already satisfies this
 * constraint structurally — its `type` literal is assignable to
 * `string` — so the Vercel codec needs no implementation changes.
 *
 * No routing fields today: outputs carry no per-event `codecMessageId` /
 * `parent` / `forkOf` overrides. Those move onto this base when a concrete
 * output needs to carry them.
 */
export interface CodecOutputEvent {
  /** Discriminator. Codec authors pick the literal value per variant. */
  type: string;
}

// ---------------------------------------------------------------------------
// Codec message — a per-message domain object paired with its identity
// ---------------------------------------------------------------------------

/**
 * A single domain message paired with the codec-message-id that identifies
 * it on the wire. Returned from {@link Codec.getMessages}.
 *
 * The two fields are deliberately separate: `message` is reconstructed to
 * faithfully reproduce the values the source produced (e.g. the id the AI
 * SDK stream assigned) and is surfaced to the application as-is; the SDK
 * never inspects `message` for identity. All internal correlation —
 * Tree indexing, parent/fork/regenerate routing, branch grouping — keys on
 * `codecMessageId`, the SDK's own client-minted identifier. The two need
 * not be equal.
 * @template TMessage - The codec's per-message domain type.
 */
export interface CodecMessage<TMessage> {
  /** The SDK's codec-message-id for this message — the correlation key. */
  codecMessageId: string;
  /** The domain message, reconstructed verbatim from the source values. */
  message: TMessage;
}

// ---------------------------------------------------------------------------
// Codec — full contract for the transport
// ---------------------------------------------------------------------------

/**
 * The codec describes the wire and folds events into a per-Run projection.
 *
 * Type parameters:
 * - `TInput` — the union of input variants the client publishes on the
 *   `ai-input` wire. Every variant extends {@link CodecInputEvent}.
 * - `TOutput` — the union of output variants the agent publishes on the
 *   `ai-output` wire. Every variant extends {@link CodecOutputEvent}.
 * - `TProjection` — the opaque per-Run state the reducer folds events into.
 *   The SDK never inspects it directly; use {@link Codec.getMessages} to
 *   extract messages for the conversation Tree.
 * - `TMessage` — the per-message shape consumed by the Tree. Returned from
 *   {@link Codec.getMessages}.
 */
export interface Codec<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends Reducer<TInput | TOutput, TProjection> {
  /** Create a stateful encoder bound to the given channel. */
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): Encoder<TInput, TOutput>;
  /** Create a stateful decoder for converting Ably inbound messages into typed inputs and outputs. */
  createDecoder(): Decoder<TInput, TOutput>;
  /**
   * Extract the per-message list from a projection, each message paired
   * with its codec-message-id (see {@link CodecMessage}). The SDK uses the
   * `codecMessageId` to correlate messages — it never reads identity from
   * the message itself — and surfaces `message` to the application
   * unchanged.
   */
  getMessages(projection: TProjection): CodecMessage<TMessage>[];
  /**
   * Wrap a TMessage as the codec's well-known {@link UserMessage} variant,
   * returned as a `TInput` ready to publish on the `ai-input` wire. This is
   * the public way to turn a caller-provided TMessage into an input for
   * `View.send`; the client session's seed-message path uses it too. The
   * returned value is a `UserMessage<TMessage>` member of the codec's
   * `TInput` union — typed as `TInput` so callers need no cast.
   * @param message - The user's message in the codec's domain representation.
   * @returns A `TInput` (the codec's {@link UserMessage} variant).
   */
  createUserMessage(message: TMessage): TInput;
  /**
   * Build a {@link Regenerate} for the codec, returned as a `TInput`. The
   * View calls this from `regenerate(messageId)`; the input event is a
   * signal (not itself a fork) that targets the assistant codec-message to
   * be regenerated.
   *
   * The new Run is a CONTINUATION of the regenerated message's Run, not a
   * fork at the Run level. The message-level replacement (the new
   * assistant supersedes the original) happens at the View's
   * projection-extraction step (Spec: AIT-CT13d).
   * @param target - The codec-message-id of the assistant being regenerated.
   * @param parent - The codec-message-id of the parent user message the new assistant threads under.
   * @returns A `TInput` (the codec's {@link Regenerate} variant).
   */
  createRegenerate(target: string, parent: string): TInput;
  /**
   * Build an {@link Edit} for the codec, returned as a `TInput`. Replaces
   * the codec-message at `target` with `message` on a new branch rooted at
   * `parent`. Optional — only codecs whose `TInput` includes the
   * {@link Edit} variant implement it.
   * @param target - The codec-message-id of the codec-message to replace.
   * @param parent - The codec-message-id of the preceding codec-message on the new branch.
   * @param message - The replacement content in the codec's domain representation.
   * @returns A `TInput` (the codec's {@link Edit} variant).
   */
  createEdit?(target: string, parent: string, message: TMessage): TInput;
  /**
   * Build a {@link ToolResult} for the codec, returned as a `TInput`.
   * Amends the assistant at `codecMessageId` with the codec's domain
   * `payload`. Optional — only codecs whose `TInput` includes the
   * {@link ToolResult} variant implement it.
   * @param codecMessageId - The assistant codec-message the result amends.
   * @param payload - The codec's domain tool-result payload.
   * @returns A `TInput` (the codec's {@link ToolResult} variant).
   */
  createToolResult?(codecMessageId: string, payload: ToolResultPayloadOf<TInput>): TInput;
  /**
   * Build a {@link ToolResultError} for the codec, returned as a `TInput`.
   * Optional — only codecs whose `TInput` includes the variant implement it.
   * @param codecMessageId - The assistant codec-message the error amends.
   * @param payload - The codec's domain tool-result-failure payload.
   * @returns A `TInput` (the codec's {@link ToolResultError} variant).
   */
  createToolResultError?(codecMessageId: string, payload: ToolResultErrorPayloadOf<TInput>): TInput;
  /**
   * Build a {@link ToolApprovalResponse} for the codec, returned as a
   * `TInput`. Optional — only codecs whose `TInput` includes the variant
   * implement it.
   * @param codecMessageId - The assistant codec-message the response amends.
   * @param payload - The codec's domain approval-decision payload.
   * @returns A `TInput` (the codec's {@link ToolApprovalResponse} variant).
   */
  createToolApprovalResponse?(codecMessageId: string, payload: ToolApprovalResponsePayloadOf<TInput>): TInput;
}
