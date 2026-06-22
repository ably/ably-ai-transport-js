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
  /** Ably message name — `ai-output` (only outputs stream); not the codec `kind` / stream family. */
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
  /** Ably message name — `ai-output` (only outputs stream); not the codec `kind` / stream family. */
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
// Reducer — pure event-sourced state machine
// ---------------------------------------------------------------------------

/**
 * Transport-derived metadata passed alongside each TEvent into `fold`. Read
 * by the SDK from the inbound Ably message and stamped before each fold call.
 */
export interface ReducerMeta {
  /**
   * Ably channel serial of the wire message that produced this event, or `''`
   * for a not-yet-sequenced optimistic (local) fold. Ordering context only:
   * the transport invokes `fold` in canonical serial order and exactly once
   * per event, so the reducer must not treat a same-or-lower serial as a
   * replay to skip — ordering and dedup are the transport's job, not the
   * reducer's.
   */
  serial: string;
  /**
   * Optional `codec-message-id` from the inbound Ably message. Reducers use this
   * to route an event to a target message within the projection (e.g. to
   * amend an existing assistant message addressed by its codec-message-id).
   */
  messageId?: string;
  /**
   * Optional `event-id` of the inbound wire itself (the per-send identifier
   * the publisher stamped). Distinct from {@link messageId}: a `codec-message-id`
   * can be shared (a continuation amends an existing assistant under the same
   * id), whereas the `event-id` is unique per published event. Reducers that
   * branch on the originating event — e.g. keying a client tool-result's
   * resolution by the event that carried it — read this. `undefined` when the
   * wire carried no `event-id`.
   */
  eventId?: string;
  /**
   * Optional `event-id` of the input event that TRIGGERED the run carrying
   * this event — the agent's `input-event-id` echo. Lets a reducer attribute
   * an agent output back to the specific triggering input (e.g. routing a
   * continuation's follow-up outputs to the sub-projection that input opened),
   * at finer granularity than the shared `input-codec-message-id`. `undefined`
   * on client inputs (which carry their own {@link eventId}, not an echo) and
   * when the wire carried no such header.
   */
  inputEventId?: string;
}

/**
 * The reducer-routing subset of {@link ReducerMeta} — every field except the
 * per-wire {@link ReducerMeta.serial}. Retained per wire in the transport's
 * event log so a refold can reconstruct each event's full {@link ReducerMeta}
 * (the log owns the serial separately).
 */
export type WireRoutingMeta = Omit<ReducerMeta, 'serial'>;

/**
 * Pure, stateless reducer contract. A reducer folds TEvents into an opaque
 * TProjection. The same `(state, event, meta)` triple must produce the same
 * result every time — `fold` is a pure function and the reducer holds no
 * instance state.
 *
 * Ordering, deduplication, and replay are the transport's responsibility, not
 * the reducer's. The transport invokes `fold` exactly once per event, in
 * canonical order — wire messages ascending by serial, events within a wire in
 * decode order — refolding a node from a fresh `init` when a late wire would
 * otherwise land out of order. The reducer therefore folds unconditionally: it
 * must not keep a serial high-water-mark or skip "already-seen" events.
 * Last-writer-wins for events competing over the same state falls out of fold
 * order, since the highest-serial event folds last.
 *
 * Mutation: `fold` is allowed to mutate the projection passed in and return
 * it. The caller treats the projection as single-owner and never retains a
 * reference to an old state.
 */
export interface Reducer<TEvent, TProjection> {
  /**
   * Build an empty initial projection. Called once per conversation node — a
   * Run node or a run-less input node — before any of that node's events are
   * folded, and again on every refold of that node.
   */
  init(): TProjection;
  /**
   * Fold one TEvent into the projection and return the updated projection.
   * Invoked exactly once per event, in canonical order; the reducer may mutate
   * `state` in place.
   */
  fold(state: TProjection, event: TEvent, meta: ReducerMeta): TProjection;
}

/**
 * A decoded event tagged with the wire direction it arrived on. The reducer
 * folds this union (not a bare `TInput | TOutput`) so it can dispatch on
 * `direction` rather than inspecting the event's shape. Direction is derived
 * once, from the Ably message name, at decode time (see `toCodecEvents`) — the
 * authoritative signal, since a single message is either `ai-input` or
 * `ai-output` but never both.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 */
export type CodecEvent<TInput, TOutput> =
  | {
      /** The event arrived on the `ai-input` wire. */
      readonly direction: 'input';
      /** The decoded input event. */
      readonly event: TInput;
    }
  | {
      /** The event arrived on the `ai-output` wire. */
      readonly direction: 'output';
      /** The decoded output event. */
      readonly event: TOutput;
    };

// ---------------------------------------------------------------------------
// Encoder — direction-typed publication API
// ---------------------------------------------------------------------------

/** Options passed to a codec's `createEncoder` factory. */
export interface EncoderOptions {
  /** Default extras (e.g. headers) merged into every Ably message. */
  extras?: Extras;
  /** Hook called before each Ably message is published. Mutate the message in place to add transport-level headers under `extras.ai`. */
  onMessage?: (message: Ably.Message) => void;
  /**
   * Fallback domain message id surfaced to output escape hatches as
   * `ctx.messageId` (e.g. the Vercel `start` hatch injects it when a chunk
   * carries no `messageId` of its own). Unrelated to the wire
   * codec-message-id transport header, which `WriteOptions.messageId` stamps.
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
   * Rejects if the codec cannot encode the given input
   * variant.
   */
  publishInput(input: TInput, options?: WriteOptions): Promise<void>;
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
 *
 * Trackers are version-guarded: a delivery whose `Message.version.serial`
 * is at or below the version already incorporated decodes to nothing. One
 * decoder instance can therefore be shared by the live subscription and
 * history hydration — whichever route delivers a message's content first
 * wins, and the other route's covered deliveries are no-ops.
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
 * `'regenerate'`) — see {@link UserMessage}, {@link Regenerate}.
 */
export interface CodecInputEvent {
  /**
   * Discriminator. Codec authors pick the literal value per variant. The
   * SDK reserves the literals used by well-known variants
   * ({@link UserMessage}, {@link Regenerate}); codec-specific variants pick
   * any other literal.
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
   * regenerate; codec-specific `kind`s may give it other meanings. The
   * input event itself does not create a fork — it requests one: the
   * transport reads `target` off the input (e.g. the client session maps a
   * regenerate's target into its transport headers) and the fork
   * relationship is established on the agent's response (and on
   * `ai-run-start`).
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
 * Well-known input variant: client-published tool result (success). The
 * tool ran and produced output. Mutates the assistant codec-message
 * addressed by `codecMessageId` — the codec's reducer applies the result
 * onto the existing tool-call state of the referenced assistant.
 *
 * The core is domain-independent: it knows only that this input amends the
 * assistant at `codecMessageId` and carries a codec-defined `payload`. The
 * shape of `payload` (e.g. the tool-call id and output value) is supplied
 * by the codec via `TPayload` (e.g. a tool-call id and output value).
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
 * is the codec's domain `payload`.
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
 * `payload`.
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

/**
 * Extract the domain message type (`TMessage`) carried by a codec's
 * {@link UserMessage} member from its `TInput` union, or `never` if the codec
 * has no user-message variant. Lets the core well-known input factories type
 * `createUserMessage` from `TInput` alone, without a separate message type
 * parameter.
 * @template TInput - The codec's input union.
 */
export type UserMessageOf<TInput> = TInput extends UserMessage<infer M> ? M : never;

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
 * reducer can switch on it — any domain union whose members carry a `type`
 * string literal satisfies it structurally.
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
 * The codec describes the wire and folds events into a per-node projection.
 *
 * Type parameters:
 * - `TInput` — the union of input variants the client publishes on the
 *   `ai-input` wire. Every variant extends {@link CodecInputEvent}.
 * - `TOutput` — the union of output variants the agent publishes on the
 *   `ai-output` wire. Every variant extends {@link CodecOutputEvent}.
 * - `TProjection` — the opaque per-node state the reducer folds events into
 *   (one projection per node, whether a RunNode or a run-less input node).
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
> extends Reducer<CodecEvent<TInput, TOutput>, TProjection> {
  /**
   * Optional Ably-Agent identifier. When present, the agent-registration path
   * registers it on the channel (so traffic is attributed to this codec); when
   * absent, the codec opts out of registration. Read directly by `registerAgent`.
   */
  readonly adapterTag?: string;
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
