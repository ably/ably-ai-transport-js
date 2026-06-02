/**
 * Core transport types, parameterized by codec event and message types.
 *
 * These types define the contract for both client and agent (server-side)
 * session implementations, independent of which codec (Vercel AI SDK, etc.)
 * is used.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../codec/types.js';
import type { Invocation } from './invocation.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Why a run ended.
 *
 * - `complete` — the run finished naturally.
 * - `cancelled` — the run was cancelled by a client.
 * - `error` — the run errored.
 * - `suspended` — the run paused waiting for input (e.g. a client tool
 *   output). The same `runId` can be resumed via a subsequent send that
 *   reuses it; observer state (router stream, tree run-tracking) survives
 *   the suspend signal so the resumed run feeds into the existing
 *   `ReadableStream`.
 */
export type RunEndReason = 'complete' | 'cancelled' | 'error' | 'suspended';

/**
 * Passed to a run's `onCancel` hook for authorization decisions.
 * The hook inspects the incoming cancel message and decides whether to
 * allow the targeted run to be cancelled.
 */
export interface CancelRequest {
  /** The raw Ably message that carried the cancel signal. */
  message: Ably.InboundMessage;
  /** The runId being cancelled. */
  runId: string;
}

// ---------------------------------------------------------------------------
// Agent session options
// ---------------------------------------------------------------------------

/** Options for creating an agent session. */
export interface AgentSessionOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /**
   * The Ably Realtime client. The caller owns its lifecycle —
   * `session.close()` does not close the client.
   */
  client: Ably.Realtime;
  /**
   * The name of the channel to publish to. The session owns this channel —
   * do not also resolve it elsewhere with conflicting channel options.
   */
  channelName: string;
  /** The codec to use for encoding events and messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** Logger instance for diagnostic output. */
  logger?: Logger;
  /**
   * Called with non-fatal session-level errors not scoped to any run.
   * Examples: cancel listener subscription failure, channel attach errors,
   * channel continuity loss (FAILED/SUSPENDED/DETACHED or re-attach with
   * `resumed: false`).
   */
  onError?: (error: Ably.ErrorInfo) => void;

  /**
   * How long `Run.start()` will wait for the input event(s) tagged with
   * the run's `invocationId` to arrive on the channel (rewind + live wait)
   * before rejecting with `InputEventNotFound`. The rejection bubbles up to the
   * developer's HTTP handler, which should surface it as a non-2xx response
   * so the client's pending send fails.
   * Default: 30000 (30 seconds).
   */
  inputEventLookupTimeoutMs?: number;

  /**
   * Maximum number of distinct invocation-ids whose input events
   * may be buffered while waiting for `Run.start()` to register a lookup
   * listener. Channel rewind on attach can replay input events before any
   * run has been created for them; this buffer holds those events so
   * that subsequent `start()` calls can drain them on registration.
   *
   * Each entry corresponds to one invocation-id regardless of how many
   * events that invocation buffered. When the limit is exceeded the
   * oldest invocation entry (and all its buffered events) is FIFO-evicted
   * — the client whose input was dropped will fail their lookup with
   * `InputEventNotFound`. The eviction is logged at warn level so operators
   * can correlate capacity pressure with `InputEventNotFound` errors.
   *
   * Default: 200.
   */
  inputEventBufferLimit?: number;

  /**
   * The channel rewind applied when the agent attaches. Replays the whole
   * channel subscription on attach (not just input events) so the lookup
   * can catch input events published before the session attached. Passed
   * through verbatim to Ably's `params.rewind` channel parameter — accepts
   * duration strings (`"2m"`, `"30s"`) or a count of messages as a string
   * (e.g. `"50"`). Malformed values surface as a channel attach error from
   * Ably; the SDK does not pre-validate.
   *
   * A longer window improves the chances of catching an input event for an
   * agent that takes a while to come up after the client published, but
   * also increases the buffer pressure on `inputEventBufferLimit` because
   * more events may be replayed on attach.
   *
   * Default: `"2m"`.
   */
  rewindWindow?: string;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/** Options for addMessages — per-operation overrides for attribution. */
export interface AddMessageOptions {
  /** The user's clientId for attribution. */
  clientId?: string;
}

/** Result of publishing user messages via addMessages. */
export interface AddMessagesResult {
  /** The `codec-message-id` of each published message, in order. */
  codecMessageIds: string[];
}

/**
 * A batch of events targeting an existing message.
 * Each node specifies the target message and the events to apply to it.
 * Used for cross-run updates such as tool result delivery.
 */
export interface EventsNode<TOutput extends CodecOutputEvent> {
  /** Discriminator — identifies this as an events node. */
  kind: 'event';
  /** The `codec-message-id` of the existing message to update. */
  codecMessageId: string;
  /** Outputs to apply to the target message. */
  events: TOutput[];
}

/**
 * Options for `Run.pipe` — per-operation overrides for the assistant message.
 * @template TOutput - The codec output type carried by the stream; used by the `resolveWriteOptions` hook.
 */
export interface PipeOptions<TOutput extends CodecOutputEvent> {
  /** The codec-message-id of the immediately preceding message in this branch. */
  parent?: string;
  /** The codec-message-id of the message this response replaces (for regeneration). */
  forkOf?: string;
  /**
   * Optional per-output hook invoked before each output is encoded. The
   * returned {@link WriteOptions} (if any) override the stream's default
   * headers and `codecMessageId` for that one encode call only; return `undefined`
   * to use the stream defaults.
   *
   * Used to carry a subset of outputs within the stream to a different
   * message (e.g. `tool-output-available` chunks that belong on a prior
   * assistant message, stamped with `amend`). Must not be used
   * for outputs that participate in the encoder's stream-append pipeline
   * — streaming state (stream tracker, append ordering) is anchored to
   * the stream's default identity and is not affected by per-output
   * overrides.
   * @param output - The output about to be encoded.
   * @returns Per-write overrides for this output, or undefined.
   */
  resolveWriteOptions?: (output: TOutput) => WriteOptions | undefined;
}

/** The result of streaming a response through the encoder. */
export interface StreamResult {
  /** Why the stream ended. */
  reason: RunEndReason;
  /**
   * The error that caused the stream to fail, present when `reason` is
   * `'error'`. This is the original error (e.g. from the LLM provider)
   * preserved so the caller can inspect provider-specific fields. The
   * run's `onError` callback also fires with a wrapped `Ably.ErrorInfo`
   * (code `StreamError`) for standardized observability.
   */
  error?: Error;
}

/** Per-run runtime hooks, signal, and overrides supplied at `createRun()` time. */
export interface RunRuntime<TOutput extends CodecOutputEvent> {
  /**
   * An external AbortSignal (typically the HTTP request's `req.signal`) that,
   * when fired, cancels this run. This allows platform-level cancellation —
   * request cancellation, serverless function timeout — to stop LLM generation
   * and stream piping gracefully.
   */
  signal?: AbortSignal;

  /**
   * Called before each Ably message is published in this run.
   * Mutate the Ably message in place to add custom headers under extras.ai.
   */
  onMessage?: (message: Ably.Message) => void;

  /**
   * Called when the run's stream is cancelled (by client cancel or server).
   * Receives a write function to publish final outputs before the cancellation finalises.
   */
  onCancelled?: (write: (output: TOutput) => Promise<void>) => void | Promise<void>;

  /**
   * Called when a cancel message arrives matching this run.
   * Return true to allow cancellation (fires `abortSignal`, stream cancels).
   * Return false to reject (cancel ignored, stream continues).
   * If not provided, all cancels are accepted.
   */
  onCancel?: (request: CancelRequest) => Promise<boolean>;

  /**
   * Called with non-fatal run-scoped errors that have no other delivery
   * path. Fires in two scenarios:
   * - Stream failures in `pipe` — the underlying error is also returned on
   *   `StreamResult.error`, but this callback delivers it wrapped as an
   *   `Ably.ErrorInfo` (code `StreamError`) for standardized observability.
   * - Failures in the `onCancel` handler.
   *
   * Publish failures in `start`, `addMessages`, `addEvents`, and `end`
   * are not delivered here — those methods reject their returned promise
   * with an `Ably.ErrorInfo`, and the caller should handle it at the await
   * site. Run errors never render the session unusable, but the run may
   * be in an inconsistent state; the caller should typically `end` it
   * with reason `'error'`.
   *
   * Channel-wide events (e.g. continuity loss) are delivered via the
   * session-level `onError` on {@link AgentSessionOptions}, not here.
   */
  onError?: (error: Ably.ErrorInfo) => void;
}

// ---------------------------------------------------------------------------
// Run interface
// ---------------------------------------------------------------------------

/**
 * Read-only view exposed on a {@link Run} of the conversation messages
 * this run was created with.
 *
 * TODO(AIT-771): when the agent rebuilds full conversation history from
 * the channel, this should expose `RunNode[]`-shaped data to match the
 * client side. Today it carries the flat input messages handed to the
 * invocation.
 */
export interface RunView<TMessage> {
  /** Invocation input messages handed to this run; no branch awareness today. */
  readonly messages: MessageNode<TMessage>[];
}

/** Options for {@link Run.loadConversation}. */
export interface LoadConversationOptions {
  /**
   * Number of wire messages to request per history page.
   * Default: 200.
   */
  pageLimit?: number;
  /**
   * Maximum total wire messages to collect across all pages before
   * stopping pagination. A safety bound so a long-lived channel
   * doesn't exhaust memory.
   * Default: 2000.
   */
  maxMessages?: number;
}

/**
 * A server-side run with explicit lifecycle methods. Generic over the
 * full codec signature so callers can write `Run<TInput, TOutput,
 * TProjection, TMessage>` symmetrically with {@link AgentSession} and
 * {@link ClientSession}; `TInput` is unused by Run's surface today but
 * reserved so future input-driven methods can land without a breaking
 * generic-arity change.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TInput reserved for forward compatibility; see JSDoc.
export interface Run<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The run's unique identifier. */
  readonly runId: string;

  /** AbortSignal scoped to this run. Fires when a cancel event arrives for this runId. */
  readonly abortSignal: AbortSignal;

  /** Read-only view of the conversation messages associated with this run. */
  readonly view: RunView<TMessage>;

  /**
   * The conversation messages this run should feed to the model.
   *
   * - Before {@link start} resolves: empty (no view contribution yet).
   * - After {@link start}: the user-prompt messages looked up on the
   *   channel for this invocation.
   * - After {@link loadConversation}: the full multi-turn conversation —
   *   all ancestor run messages followed by the current run's messages,
   *   oldest turn first. This is the value to pass to the LLM when the
   *   agent handles a reply in an ongoing conversation.
   *
   * Each access returns a fresh array — safe to mutate without affecting
   * internal Run state.
   */
  readonly messages: TMessage[];

  /** Publish run-start event to the channel. Must be called before addMessages or pipe. */
  start(): Promise<void>;

  /**
   * Publish user messages to the channel, scoped to this run.
   * Each node's `codecMessageId`, `parentId`, and `forkOf` are used for message identity
   * and branching. The node's `headers` override session-generated defaults
   * (e.g. for optimistic reconciliation with the client's inserts).
   * @returns The codec-message-ids of all published messages, in order.
   */
  addMessages(messages: MessageNode<TMessage>[], options?: AddMessageOptions): Promise<AddMessagesResult>;

  /**
   * Pipe a ReadableStream through the encoder to the channel.
   * Returns when the stream completes, is cancelled, or errors.
   * Does NOT call end() — the caller must call end() after pipe returns.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;

  /**
   * Publish events targeting existing messages in the tree. Each node
   * specifies a target message (by `codecMessageId`) and the events to apply.
   * Events are encoded and published with the target's `codec-message-id`,
   * so receiving clients apply them to the existing node rather than
   * creating a new one.
   *
   * Used for cross-run updates such as tool result delivery after
   * approval or client-side tool execution.
   */
  addEvents(nodes: EventsNode<TOutput>[]): Promise<void>;

  /**
   * Fetch every channel message bound to this run and fold them through
   * the codec into a single projection. Used by the agent to reconstruct
   * the run's full state — including client-published tool-output amends
   * the agent didn't observe live — when resuming a suspended run.
   *
   * Uses `channel.history()` (no `untilAttach`) so messages published
   * after the channel was originally attached are still included. Each
   * call paginates until either there are no more pages or an internal
   * safety bound is reached.
   * @returns The TProjection produced by folding every event for this run
   *   in serial order. The caller extracts what they need via
   *   {@link Codec.getMessages}.
   */
  loadProjection(): Promise<TProjection>;

  /**
   * Reconstruct the full multi-turn conversation by walking the ancestor
   * run chain and concatenating each run's messages, oldest turn first.
   *
   * Performs a single `channel.history()` scan and builds projections for
   * all ancestor runs plus the current run. After this call:
   * - {@link Run.messages} returns the complete conversation (all ancestor
   *   turns followed by the current run's messages), making it ready to
   *   pass directly to the LLM.
   * - The current run's projection is cached so {@link Run.pipe} works
   *   correctly without a separate {@link Run.loadProjection} call.
   * @param options - Optional tuning for history pagination.
   * @returns The same message list now accessible via {@link Run.messages}.
   */
  loadConversation(options?: LoadConversationOptions): Promise<TMessage[]>;

  /** Publish run-end event to the channel and clean up. */
  end(reason: RunEndReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent session interface
// ---------------------------------------------------------------------------

/** Server-side session that manages run lifecycles over an Ably channel. */
export interface AgentSession<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /**
   * Subscribe to the cancel channel and (implicitly) attach. Idempotent —
   * subsequent calls return the same promise. All run methods (`start`,
   * `addMessages`, `addEvents`, `pipe`, `end`) throw `InvalidArgument`
   * until `connect()` resolves.
   */
  connect(): Promise<void>;

  /**
   * Create a new run from an invocation. Synchronous — no channel activity
   * until start() is called. The run is registered for cancel routing
   * immediately so that early cancels fire the AbortSignal.
   * @param invocation - The {@link Invocation} carrying run identity and
   *   conversation messages.
   * @param runtime - Optional runtime hooks and external AbortSignal
   *   (e.g. the HTTP request's `req.signal`).
   */
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): Run<TInput, TOutput, TProjection, TMessage>;

  /** Unsubscribe from cancel messages, cancel all active runs, and clean up. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Client session options
// ---------------------------------------------------------------------------

/** Options for creating a client session. */
export interface ClientSessionOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /**
   * The Ably Realtime client. The caller owns its lifecycle —
   * `session.close()` does not close the client.
   */
  client: Ably.Realtime;

  /**
   * The name of the channel to subscribe to and publish cancel signals on.
   * The session owns this channel — do not also resolve it elsewhere with
   * conflicting channel options.
   */
  channelName: string;

  /** The codec to use for encoding/decoding. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;

  /**
   * The client's identity, used as the Ably publisher `clientId` on
   * everything this session publishes. Surfaces on the wire as the
   * run/input client id so other clients can attribute messages.
   */
  clientId?: string;

  /** Initial messages to seed the conversation tree with. Forms a linear chain. */
  messages?: TMessage[];

  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Per-send options for branching metadata and run identity. */
export interface SendOptions {
  /**
   * The codec-message-id of the message this send replaces (fork).
   * Set for regeneration (forkOf an assistant message) or
   * edit (forkOf a user message).
   */
  forkOf?: string;
  /**
   * The codec-message-id of the message that precedes this one in the
   * conversation thread. If omitted, auto-computed from the last
   * message in the view.
   */
  parent?: string;
  /**
   * Reuse an existing `runId` (e.g. resume a suspended run). When set,
   * the send is treated as a continuation: the run's existing observer
   * state (router stream, tree run-tracking) is reused; no fresh
   * `crypto.randomUUID()` is minted. Pair with a fresh `invocationId`
   * (or rely on the auto-generated one) so each continuation POST has
   * a distinct invocation key.
   */
  runId?: string;
  /**
   * Reuse or override the `invocationId` for this send. Useful for
   * deterministic identification (tests) or for pairing with a reused
   * `runId`. Defaults to `crypto.randomUUID()`.
   */
  invocationId?: string;
  /**
   * Override the `inputEventId` for this send. Useful for deterministic
   * identification (tests). Defaults to `crypto.randomUUID()`.
   */
  inputEventId?: string;
}

// ---------------------------------------------------------------------------
// Run lifecycle events
// ---------------------------------------------------------------------------

/**
 * A structured event describing a run starting or ending. The `type`
 * discriminator (`start` / `end`) is the in-memory domain vocabulary and is
 * intentionally distinct from the wire message names (`ai-run-start` /
 * `ai-run-end`) those events are decoded from.
 */
export type RunLifecycleEvent =
  | {
      type: 'start';
      runId: string;
      clientId: string;
      /**
       * Ably channel serial of the run-start message, or `undefined` for an
       * optimistic local event (no serial assigned yet). The Tree reads it to
       * promote the Run's startSerial.
       */
      serial: string | undefined;
      /**
       * The invocation-id this run-start was published under (wire
       * `invocation-id`). The Tree records it on the RunNode on
       * first creation so the optimistic Run exposes the invocation
       * synchronously, without waiting for a serial-bearing echo.
       */
      invocationId: string;
      /** The codec-message-id of the parent message, if known. Omitted for root runs. */
      parent?: string;
      /**
       * The codec-message-id of the user prompt being forked, when the run is an
       * edit. Carried verbatim from the `fork-of` wire header.
       */
      forkOf?: string;
      /**
       * The codec-message-id of the assistant message this run regenerates, when
       * the run is a regenerate continuation. Carried verbatim from the
       * `msg-regenerate` wire header. The Tree treats regenerates
       * as continuations (no `forkOf` at the Run level) — the View
       * realises the replacement when materialising messages.
       */
      regenerates?: string;
      /**
       * True when the agent published this `run-start` as a continuation
       * of an already-started run (e.g. a tool-result follow-up invocation
       * under the same runId). Surfaced from the `run-continue`
       * wire header. Absent for the first start of a run.
       */
      isContinuation?: boolean;
    }
  | {
      type: 'end';
      runId: string;
      clientId: string;
      /**
       * Ably channel serial of the run-end message, or `undefined` for an
       * optimistic local event. The Tree reads it to set the Run's endSerial.
       */
      serial: string | undefined;
      /**
       * The invocation-id this run-end was published under (wire
       * `invocation-id`), mirroring the run-start. Lets consumers correlate
       * a run's termination back to the invocation that drove it. Empty
       * string if the wire didn't carry an invocation-id.
       */
      invocationId: string;
      reason: RunEndReason;
    };

// ---------------------------------------------------------------------------
// Active run handle
// ---------------------------------------------------------------------------

/**
 * A handle to an active client-side run, returned by `sendMessage()`,
 * `sendInput()`, `regenerate()`, and `edit()`.
 *
 * The core no longer exposes a per-run output stream — streaming is a
 * consumer-layer concern (e.g. the Vercel ChatTransport builds a stream from
 * the Tree's `output` events). The handle carries only run identity and
 * control, so it is not parameterized by the codec output type.
 */
export interface ActiveRun {
  /**
   * Resolves when the agent's `ai-run-start` for this run+invocation is
   * observed on the channel. `send()` itself resolves as soon as the input
   * is published, so callers that need to know the agent has picked up the
   * run `await run.started`. There is no built-in deadline — race it against
   * your own timeout if you need one. Rejects only if the session is closed
   * before run-start arrives.
   */
  started: Promise<void>;
  /** The run's unique identifier. */
  runId: string;
  /**
   * The invocation's unique identifier. Stamped on the published user
   * message and forwarded in the HTTP POST body so the agent's run
   * lifecycle events (`ai-run-start`, `ai-run-end`) can echo it back. The
   * stream router keys on this value to filter output events to the bound
   * invocation.
   */
  invocationId: string;
  /**
   * The input event's unique identifier. Stamped on the primary input event
   * published to the channel and forwarded in the HTTP POST body so the
   * agent can locate the exact triggering event.
   */
  inputEventId: string;
  /** Cancel this specific run. Publishes a cancel message and closes the local stream. */
  cancel(): Promise<void>;
  /**
   * The codec-message-ids of optimistically inserted user messages, in order.
   * Present when the send included user messages (edit); empty for
   * regeneration (no user messages to insert optimistically).
   */
  optimisticCodecMessageIds: string[];
  /**
   * Build the {@link Invocation} pointer for this run — `runId`,
   * `invocationId`, `inputEventId`, and the session's channel name as
   * `sessionName`. The application POSTs `run.toInvocation().toJSON()` to
   * its agent endpoint to wake the agent; the agent rebuilds it via
   * {@link Invocation.fromJSON}. The conversation itself is read from the
   * channel, so the pointer carries only identifiers.
   */
  toInvocation(): Invocation;
}

// ---------------------------------------------------------------------------
// History / pagination
// ---------------------------------------------------------------------------

/** A single decoded history item with its transport metadata. */
export interface HistoryItem<TMessage> {
  /** The decoded domain message. */
  message: TMessage;
  /** Transport headers for tree identity and ordering. */
  headers: Record<string, string>;
  /** Ably serial for tree ordering. */
  serial: string;
}

/** A page of decoded history from the channel. Internal to View/decodeHistory. */
export interface HistoryPage<TMessage> {
  /** Decoded items in chronological order (oldest first). */
  items: HistoryItem<TMessage>[];
  /** Raw Ably messages that produced this page, in chronological order. */
  rawMessages: Ably.InboundMessage[];
  /** Whether there are older pages available. */
  hasNext(): boolean;
  /** Fetch the next (older) page. Returns undefined if no more pages. */
  next(): Promise<HistoryPage<TMessage> | undefined>;
}

/** Options for loading channel history. */
export interface LoadHistoryOptions {
  /** Max messages per page. Default: 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Conversation tree (branching history)
// ---------------------------------------------------------------------------

/** A node in the conversation tree, representing a single domain message. */
export interface MessageNode<TMessage> {
  /** Discriminator — identifies this as a message node. */
  kind: 'message';
  /** The domain message. */
  message: TMessage;
  /** The codec-message-id of this node — primary key in the tree. */
  codecMessageId: string;
  /** Parent node's codec-message-id (parent), or undefined for root messages. */
  parentId: string | undefined;
  /** The codec-message-id this node forks from (fork-of), or undefined if first version. */
  forkOf: string | undefined;
  /** Full Ably headers for this message. */
  headers: Record<string, string>;
  /**
   * Ably serial for this message. Lexicographically comparable for total order.
   * Used to sort siblings deterministically regardless of delivery/history order.
   * Absent for optimistic messages (set when the server relay arrives).
   */
  serial: string | undefined;
}

/** @deprecated Use {@link MessageNode} instead. */
export type TreeNode<TMessage> = MessageNode<TMessage>;

/**
 * A node in the conversation tree, representing a single Run.
 *
 * The Tree is keyed by `runId`. Each RunNode owns a per-Run codec
 * {@link TProjection} folded from every event published under that run-id;
 * the SDK extracts the per-message list via {@link Codec.getMessages} when it
 * needs to render messages for that Run.
 *
 * Sibling structure (edits / regenerates) is derived from `forkOf`:
 * a regenerate or edit publishes a new Run whose `forkOf` points at the
 * (runId, codecMessageId) being forked.
 */
export interface RunNode<TProjection> {
  /**
   * Stable identity of this Run within the tree — the key every index, the
   * parent/fork references, and the View address it by. Assigned once at
   * creation and never changed, so it is safe for callers (and React) to key
   * on across the Run's lifecycle. It is the Run's {@link runId} when one is
   * known at creation (the common case: history and agent-published runs); for
   * a client-originated Run observed before any runId exists it is the
   * triggering input's codec-message-id, and it stays fixed when the agent's
   * runId is later adopted onto {@link runId}.
   */
  key: string;
  /**
   * The run-id of this Run, once known. `undefined` for a provisional Run
   * created from a client input before the agent has minted (and the client
   * has observed) the run's id — adopted later from the run-start lifecycle
   * event. Use {@link key} for stable identity; use `runId` when you need the
   * agent's run id specifically (cancel, continuation).
   */
  runId: string | undefined;
  /**
   * The {@link key} of the immediately preceding Run on this conversation
   * chain, or undefined for the root Run. Resolved by the Tree from the first
   * observed message's `parent` header via the codecMessageId -> key index.
   * May be `undefined` transiently if the parent's first message hasn't
   * been observed yet.
   */
  parentRunId: string | undefined;
  /**
   * The codec-message-id this Run is rooted at — the `parent` header of the
   * first observed message (or the run-start lifecycle event's `parent`
   * field). Distinct from {@link parentRunId} because branch filtering
   * needs the message-level anchor: a follow-up Run parented at a message
   * that gets regen-substituted out of the visible chain disappears
   * alongside its anchor even though its `parentRunId` Run is still visible.
   * `undefined` for the root Run.
   */
  parentCodecMessageId: string | undefined;
  /**
   * The {@link key} of the Run this Run replaces, or `undefined` if this Run
   * is not a fork. Populated when the wire's `fork-of` header points at
   * a codec-message-id that has been observed; the Tree resolves it to a key
   * via the codecMessageId -> key index.
   */
  forkOf: string | undefined;
  /**
   * The codec-message-id this Run regenerates, or `undefined` for non-regenerate
   * Runs. Populated from the wire's `msg-regenerate` header (and
   * the lifecycle event's `regenerates` field) verbatim — the Tree does
   * not resolve it to a runId because the anchor is a message position,
   * not a Run.
   *
   * Regenerate Runs are conversation-history continuations: their
   * `parentRunId` points at the prior Run in the chain, and the message
   * named by `regeneratesCodecMessageId` is replaced by this Run's content when
   * the View materialises the chain into messages (Spec: AIT-CT13d).
   */
  regeneratesCodecMessageId: string | undefined;
  /**
   * Identity of the Ably client that started this Run, sourced from the
   * `run-client-id` wire header (or the run-start lifecycle event's
   * `clientId` field). Set once at Run creation and never updated; persists
   * through the Run's lifecycle, including after `run-end`. Empty string if
   * the wire didn't carry a client id.
   */
  clientId: string;
  /**
   * Run lifecycle status.
   * - `'active'` — run-start observed, no run-end yet.
   * - {@link RunEndReason} — terminal state reflecting the run-end reason.
   */
  status: 'active' | RunEndReason;
  /** Per-Run codec projection. Folded by the Tree from every event published under this run-id. */
  projection: TProjection;
  /**
   * The invocationId observed for this Run (wire `invocation-id`). Set once at
   * Run creation from the optimistic insert's or first wire's headers and never
   * reassigned, so consumers can read it synchronously.
   * Empty string if the wire didn't carry an invocation-id.
   */
  invocationId: string;
  /** Ably serial of the first observed message tagged with this run-id. Absent for optimistic Runs. */
  startSerial: string | undefined;
  /** Ably serial of the run-end lifecycle event, if observed. */
  endSerial: string | undefined;
}

/**
 * Payload of the Tree's `output` event: the decoded agent outputs folded
 * for a Run from a single inbound message, carrying the routing metadata a
 * consumer needs to attribute or stream them.
 */
export interface OutputEvent<TOutput extends CodecOutputEvent> {
  /** The runId the outputs were folded into. */
  runId: string;
  /**
   * The `codec-message-id` the outputs were published under, or `undefined`
   * when the message carried none.
   */
  codecMessageId: string | undefined;
  /**
   * Ably channel serial of the message that carried the outputs, or
   * `undefined` for an optimistic local fold (no serial assigned yet).
   */
  serial: string | undefined;
  /**
   * The decoded agent outputs from this message, in wire order. Empty when
   * the folded message carried only inputs (e.g. an optimistic user
   * message); the event still fires so consumers can observe that the Run's
   * projection changed.
   */
  events: TOutput[];
}

/**
 * Materializes a branching conversation tree from a flat oplog of Ably
 * messages, keyed by `run-id`.
 *
 * The Tree owns the complete conversation state across every observed Run.
 * Each RunNode holds a per-Run codec {@link TProjection} which the Tree folds
 * from inbound events. The View walks the parent chain to extract a flat
 * message list for rendering.
 */
export interface Tree<TOutput extends CodecOutputEvent, TProjection> {
  /**
   * Return the visible Run list along the selected branches, in
   * chronological order. The `selections` map provides the selected
   * sibling's runId at each fork point, keyed by group-root runId.
   * Fork points not present in the map default to the latest sibling
   * (newest by startSerial); a `selectedRunId` not found in its
   * sibling group is treated the same.
   *
   * Pass an empty map (or omit the argument) to get the "latest at
   * every fork" snapshot — useful for tests and for consumers that
   * don't track their own selection state.
   * @param selections - Per-fork-point sibling selection, keyed by
   *   group-root runId. Defaults to an empty map.
   * @returns The Runs along the selected branches in chronological order.
   */
  runs(selections?: Map<string, string>): RunNode<TProjection>[];

  /** Get a Run by runId, or undefined if not found. */
  getRunNode(runId: string): RunNode<TProjection> | undefined;

  /**
   * Get the Run that owns a given codec-message-id (via the Tree's
   * codecMessageId -> runId index), or undefined if the codec-message-id
   * hasn't been observed.
   */
  getRunByCodecMessageId(codecMessageId: string): RunNode<TProjection> | undefined;

  /**
   * Get all Runs that are siblings (alternatives) at a given fork point.
   * Returns an array ordered chronologically by startSerial; the Run
   * identified by `runId` is always included.
   *
   * Two kinds of sibling groups surface through this API:
   * - **Edit forks** — Runs sharing a `parentRunId` and chained via
   *   `forkOf` (the original Run + its edits).
   * - **Regenerate groups** — the Run that owns a regenerated codec-message-id +
   *   every Run whose `regeneratesCodecMessageId` points at that codec-message-id.
   *
   * A Run is in at most one group; if neither applies the returned array
   * is `[runId]`.
   */
  getSiblingRuns(runId: string): RunNode<TProjection>[];

  /** Whether a Run has sibling alternatives (i.e., show navigation arrows). */
  hasSiblingRuns(runId: string): boolean;

  /**
   * Resolve the regenerate sibling group containing `runId`, if any.
   *
   * The group is anchored at a codec-message-id — the one being regenerated —
   * and its members are the Run that owns that codec-message-id plus every
   * Run whose `regeneratesCodecMessageId` points at it. Returns `undefined`
   * when `runId` neither regenerates a known codec-message-id nor owns a
   * codec-message-id that has been regenerated.
   * @param runId - The runId to look up.
   * @returns Anchor codec-message-id and members ordered chronologically by
   *   startSerial (owner first), or `undefined` if there is no group.
   */
  getRegenerateGroup(runId: string):
    | {
        /** The codec-message-id this group regenerates. */
        anchorCodecMessageId: string;
        /** Ordered group members (owner first, then regenerators by serial). */
        runs: RunNode<TProjection>[];
      }
    | undefined;

  // --- Events ---

  /**
   * Subscribe to tree structural changes (Run insert, delete, sort-reorder,
   * startSerial promotion, run-start metadata backfill). Does NOT fire on
   * content-only folds (streaming chunks) or on run-end status changes —
   * those flow through `output` and `run` respectively.
   */
  on(event: 'update', handler: () => void): () => void;

  /** Subscribe to raw Ably messages arriving on the channel. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** Subscribe to run lifecycle events (start and end). */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /**
   * Subscribe to decoded agent outputs as they are folded into a Run.
   * Fires once per inbound message after its fold, carrying the message's
   * output events plus routing metadata (runId, codec-message-id, serial).
   * Fires with an empty `events` array for inputs-only folds so it can also
   * serve as a projection-changed signal.
   */
  on(event: 'output', handler: (event: OutputEvent<TOutput>) => void): () => void;
}

// ---------------------------------------------------------------------------
// View — windowed projection over the tree
// ---------------------------------------------------------------------------

/**
 * Projection-free, View-facing snapshot of a Run.
 *
 * Exposes the Run facts a UI consumer needs (`runId`, owner `clientId`,
 * lifecycle `status`, `invocationId`) without leaking the codec's
 * opaque per-Run projection or the Tree's structural fields. Callers
 * that need the full Run record (parent / fork relationships, serials,
 * projection) reach `session.tree.getRunNode(runId)` directly.
 */
export interface RunInfo {
  /**
   * Stable identity of the Run — safe to key UI state on across the Run's
   * lifecycle. Equals {@link runId} once a runId is known; for a provisional
   * Run (a client input observed before its runId) it is the triggering
   * input's codec-message-id and stays fixed when the runId is adopted.
   */
  key: string;
  /**
   * The Run's run-id, once known. `undefined` for a provisional Run before
   * its runId has been adopted. Use {@link key} for stable identity.
   */
  runId: string | undefined;
  /**
   * Identity of the Ably client that started this Run. Empty string
   * when the wire didn't carry an owner client id.
   */
  clientId: string;
  /**
   * Run lifecycle status. `'active'` while the Run is streaming;
   * otherwise the {@link RunEndReason} the Run terminated with.
   * Literal lifecycle vocabulary — UIs that want `'streaming'`
   * rendering language translate at the component boundary.
   */
  status: 'active' | RunEndReason;
  /**
   * The first `invocationId` observed for this Run. Stable across the
   * Run's lifecycle. Empty string when the wire didn't carry an
   * invocation-id.
   */
  invocationId: string;
}

/**
 * Bundle returned by {@link View.branchSelection} describing the
 * sibling group anchored at a given codec-message-id.
 *
 * Total / always-defined — `view.branchSelection(id)` is safe to call
 * for any message:
 *
 *  - **Branch anchor (N ≥ 2 siblings)**: `siblings` carries every
 *    sibling Run's view of the anchor slot, `index` is the selected
 *    sibling's position, `selected === siblings[index]`,
 *    `hasSiblings: true`.
 *  - **Known non-anchor message**: `siblings = [thisMessage]`,
 *    `index: 0`, `selected: thisMessage`, `hasSiblings: false`.
 *  - **Unknown codec-message-id**: `siblings: []`, `index: 0`,
 *    `selected: undefined`, `hasSiblings: false`.
 *
 * Because `siblings` always contains the currently rendered message
 * (for known ids), `siblings.length` is `1` for a plain bubble (not
 * `0`) and the indexing space matches between read and write —
 * passing `branch.index` back into {@link View.selectSibling} is a
 * round-trip no-op.
 */
export interface BranchSelection<TMessage> {
  /** True when the codec-message-id is a branch anchor with more than one sibling. Equivalent to `siblings.length > 1`. */
  hasSiblings: boolean;
  /**
   * The selected sibling and any alternatives, in tree-order (oldest
   * first). Always contains the currently rendered message itself for
   * known codec-message-ids; empty only when the id is unknown to the
   * view.
   */
  siblings: TMessage[];
  /** Index of the selected sibling within `siblings`. `0` when there is no real branching or the id is unknown. */
  index: number;
  /** Convenience reference to `siblings[index]`. `undefined` only when `siblings` is empty. */
  selected: TMessage | undefined;
}

/**
 * A paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of the selected branch. New live messages
 * appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers
 * are only notified when the visible output changes.
 */
export interface View<TInput extends CodecInputEvent, TMessage> {
  /**
   * The visible domain messages along the selected branch. Computed by
   * walking the visible Run chain (newest to root) and concatenating
   * each Run's `codec.getMessages(projection)` in chronological order.
   */
  getMessages(): TMessage[];

  /**
   * Snapshot of the visible Runs along the selected branch, in
   * chronological order — already filtered by this view's pagination
   * window, branch selection, and regenerate substitution. The
   * companion to {@link getMessages}: same scope, exposed as
   * projection-free {@link RunInfo} so consumers can iterate Run
   * identity (runId, clientId, status, invocationId) without touching
   * the Tree.
   */
  runs(): RunInfo[];

  /** Whether there are older Runs that can be loaded or revealed. */
  hasOlder(): boolean;

  /**
   * Reveal older Runs. Loads from channel history if the tree doesn't have
   * enough, then advances the pagination window by up to `limit` Runs.
   * Emits 'update' when the visible list changes.
   *
   * The pagination unit is the **Run**, not the message. A single Run
   * typically contributes more than one message to the flat list returned
   * by {@link View.getMessages} (e.g. a user prompt + assistant reply
   * pair). Revealing `limit` Runs may add 1..N messages each to the
   * visible window.
   * @param limit - Maximum number of older Runs to reveal. Defaults to 100.
   */
  loadOlder(limit?: number): Promise<void>;

  // --- Run lookup ---

  /**
   * Look up the {@link RunInfo} for the Run that owns
   * `codecMessageId`. Returns `undefined` when the codec-message-id
   * hasn't been observed by the view.
   * @param codecMessageId - The codec-message-id to look up.
   */
  runOf(codecMessageId: string): RunInfo | undefined;

  /**
   * Direct lookup by Run id. Kept for symmetry with {@link runOf} so
   * callers that hold a `runId` (e.g. cancel handlers) get a one-step
   * lookup. Returns `undefined` when the Run hasn't been observed.
   * @param runId - The Run id to look up.
   */
  run(runId: string): RunInfo | undefined;

  // --- Branch navigation ---

  /**
   * Resolve the {@link BranchSelection} bundle anchored at
   * `codecMessageId`. Always returns a safe object — see
   * {@link BranchSelection} for the per-case shape.
   *
   * Per AITRFC-014, branch points are message-anchored: edit forks
   * point at the user prompt's codec-message-id, regenerate forks
   * point at the assistant message's codec-message-id.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   */
  branchSelection(codecMessageId: string): BranchSelection<TMessage>;

  /**
   * Select a sibling at the branch point anchored at
   * `codecMessageId`. `index` is clamped to
   * `[0, siblings.length - 1]`. Silent no-op when `codecMessageId`
   * is not a branch anchor. Emits 'update' when the visible output
   * changes.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @param index - The index of the sibling to select.
   */
  selectSibling(codecMessageId: string, index: number): void;

  // --- Write operations ---

  /**
   * Send one or more user messages and start a new run. Each TMessage is
   * wrapped into a `UserMessage` TInput via `Codec.createUserMessage`
   * before being published, so callers can pass TMessage values directly
   * without manually constructing the input shape.
   *
   * The parent is auto-computed from this view's selected branch unless
   * overridden. The HTTP POST is fire-and-forget — the returned stream is
   * available immediately. If the POST fails, the error is surfaced via
   * the session's `on("error")` and the stream is errored.
   */
  sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun>;

  /**
   * Send one or more TInputs on the channel and fire a POST. Each TInput
   * carries its own routing metadata (`parent` / `target` / `codecMessageId`)
   * via the {@link CodecInputEvent} base; the SDK reads those fields
   * directly without runtime classification.
   *
   * Convention: a send containing at least one `UserMessage` is a
   * fresh send (mints a new `runId`). A send containing only
   * tool-resolution inputs is a continuation — pair with
   * `options.runId` to extend a suspended run.
   */
  sendInput(events: TInput | TInput[], options?: SendOptions): Promise<ActiveRun>;

  /**
   * Regenerate an assistant message. Creates a new run that forks the
   * target message with no new user inputs. Automatically computes
   * `target` (the assistant being regenerated), `parent`, and truncated
   * `history` from this view's branch.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf`, `parent`,
   * and `history` from this view's branch.
   */
  edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ActiveRun>;

  // --- Observation ---

  /** The visible message list changed (new visible node, branch switch, window shift). */
  on(event: 'update', handler: () => void): () => void;

  /** A raw Ably message arrived that corresponds to a visible node. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** A run event occurred for a run with visible messages in the window. */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /** Tear down the view — unsubscribe from tree events and clear internal state. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Client session interface
// ---------------------------------------------------------------------------

/** Client-side session that manages conversation state over an Ably channel. */
export interface ClientSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The complete conversation tree — all known Run nodes, events for any change. */
  readonly tree: Tree<TOutput, TProjection>;

  /** The default paginated, branch-aware view for rendering — events scoped to visible messages. */
  readonly view: View<TInput, TMessage>;

  /**
   * Subscribe to the channel and (implicitly) attach. Idempotent —
   * subsequent calls return the same promise. `sendMessage()`,
   * `sendInput()`, `regenerate()`, `edit()`, `update()`, and `cancel()`
   * throw `InvalidArgument` until `connect()` resolves.
   */
  connect(): Promise<void>;

  /**
   * Create an additional view over the same conversation tree.
   * Each view has independent branch selections and pagination state.
   * The caller is responsible for calling `close()` on the returned view
   * when it is no longer needed, or it will be closed when the session closes.
   */
  createView(): View<TInput, TMessage>;

  /** Cancel the specified run. Publishes a cancel message and closes the local stream. */
  cancel(runId: string): Promise<void>;

  /**
   * Subscribe to non-fatal session errors. These indicate something went
   * wrong but the session is still operational. Returns an unsubscribe function.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Tear down the session: unsubscribe from the channel, close active
   * streams, clear all handlers, and prevent further operations.
   *
   * Local-state-only — the server keeps streaming until its runs end on
   * their own. To stop in-progress runs, call {@link cancel} for each
   * before `close()`.
   */
  close(): Promise<void>;
}
