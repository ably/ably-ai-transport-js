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

  /** The client's identity. Sent to the server in the POST body. */
  clientId?: string;

  /** Server endpoint URL for the HTTP POST. */
  api: string;

  /** Headers for the HTTP POST. Function form for dynamic values (e.g. auth tokens). */
  headers?: Record<string, string> | (() => Record<string, string>);

  /** Additional body fields merged into the HTTP POST. Function form for dynamic values. */
  body?: Record<string, unknown> | (() => Record<string, unknown>);

  /** Fetch credentials mode for the HTTP POST. */
  credentials?: RequestCredentials;

  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;

  /** Initial messages to seed the conversation tree with. Forms a linear chain. */
  messages?: TMessage[];

  /** Logger instance for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Per-send options for customizing the HTTP POST and branching metadata. */
export interface SendOptions {
  /** Additional fields merged into the HTTP POST body. */
  body?: Record<string, unknown>;
  /** Additional headers for the HTTP POST. */
  headers?: Record<string, string>;
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

/** A structured event describing a run starting or ending. */
export type RunLifecycleEvent =
  | {
      type: 'ai-run-start';
      runId: string;
      clientId: string;
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
  | { type: 'ai-run-end'; runId: string; clientId: string; reason: RunEndReason };

// ---------------------------------------------------------------------------
// Active run handle
// ---------------------------------------------------------------------------

/** A handle to an active client-side run, returned by `sendMessage()`, `sendInput()`, `regenerate()`, and `edit()`. */
export interface ActiveRun<TOutput extends CodecOutputEvent> {
  /** The decoded output stream for this run. May error if the delivery guarantee is broken (e.g. POST failure, channel continuity loss). */
  stream: ReadableStream<TOutput>;
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
  /** The run-id of this Run — primary key in the tree. */
  runId: string;
  /**
   * The runId of the immediately preceding Run on this conversation chain,
   * or undefined for the root Run. Resolved by the Tree from the first
   * observed message's `parent` header via the codecMessageId -> runId index.
   * May be `undefined` transiently if the parent's first message hasn't
   * been observed yet.
   */
  parentRunId: string | undefined;
  /**
   * The runId of the Run this Run replaces, or `undefined` if this Run is
   * not a fork. Populated when the wire's `fork-of` header points at
   * a codec-message-id that has been observed; the Tree resolves it to a runId via
   * the codecMessageId -> runId index.
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
 * Materializes a branching conversation tree from a flat oplog of Ably
 * messages, keyed by `run-id`.
 *
 * The Tree owns the complete conversation state across every observed Run.
 * Each RunNode holds a per-Run codec {@link TProjection} which the Tree folds
 * from inbound events. The View walks the parent chain to extract a flat
 * message list for rendering.
 */
export interface Tree<TProjection> {
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

  /** Subscribe to tree structural changes (Run insert, delete, sort-reorder). */
  on(event: 'update', handler: () => void): () => void;

  /** Subscribe to raw Ably messages arriving on the channel. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** Subscribe to run lifecycle events (start and end). */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /**
   * Subscribe to per-Run projection updates. Fires after every successful
   * `codec.fold` on an existing Run's projection. Does NOT fire on
   * structural changes (Run insert/delete); use 'update' for those.
   * Used by the View to detect streaming deltas without a full tree walk.
   */
  on(event: 'run-projection-updated', handler: (event: { runId: string }) => void): () => void;
}

// ---------------------------------------------------------------------------
// View — windowed projection over the tree
// ---------------------------------------------------------------------------

/**
 * Per-message metadata derived from the owning Run, returned by
 * {@link View.getMessageMetadata}.
 *
 * Mirrors the subset of pre-tree-of-runs `MessageNode` fields that
 * applications consumed for rendering: identifiers, owner client id,
 * and stream status. Designed so the rendering layer receives
 * structured primitives without touching SDK domain types like
 * {@link RunNode}. If you need the full Run record (projection,
 * regeneratesMsgId, etc.), reach through the {@link Tree} surface
 * instead.
 */
export interface MessageMetadata {
  /** The codec-message-id this metadata describes. */
  codecMessageId: string;
  /** The runId of the Run that owns this message. */
  runId: string;
  /**
   * The clientId of the Run owner (Ably client that started the Run).
   * Empty string when the wire did not carry an owner client id.
   */
  clientId: string;
  /**
   * `'streaming'` while the owning Run is active, otherwise the
   * {@link RunEndReason} the Run terminated with — `'complete'`,
   * `'cancelled'`, `'error'`, or `'suspended'`.
   */
  status: 'streaming' | RunEndReason;
}

/**
 * A paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of the selected branch. New live messages
 * appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers
 * are only notified when the visible output changes.
 */
export interface View<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /**
   * The visible domain messages along the selected branch. Computed by
   * walking the visible {@link RunNode} chain (newest to root) and
   * concatenating each Run's `codec.getMessages(projection)` in chronological
   * order.
   */
  getMessages(): TMessage[];

  /** Visible Runs along the selected branch, filtered by the pagination window. */
  flattenNodes(): RunNode<TProjection>[];

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

  // --- Branch navigation ---

  /**
   * Select a sibling Run at a fork point by index. Updates this view's
   * branch selection. Index is clamped to `[0, siblings.length - 1]`.
   * Emits 'update' when the visible output changes.
   * @param runId - Any runId in the sibling group. The View resolves the
   *   group root internally.
   */
  select(runId: string, index: number): void;

  /** Get the index of the currently selected sibling Run at a fork point. */
  getSelectedIndex(runId: string): number;

  /**
   * Per-message metadata derived from the owning Run. The natural
   * accessor for the rendering layer: returns primitives (runId,
   * clientId, status) without leaking {@link RunNode} or the codec's
   * projection generic into UI components. Returns `undefined` when
   * the msg-id hasn't been observed.
   * @param msgId - The msg-id to look up.
   * @returns Structured per-message metadata, or `undefined`.
   */
  getMessageMetadata(msgId: string): MessageMetadata | undefined;

  /**
   * Whether the message at `codecMessageId` is a branch-point anchor — i.e.
   * the UI should render navigation arrows next to this specific bubble.
   *
   * Per AITRFC-014, branch points are message-anchored: edit forks point at
   * the user prompt's codec-message-id, regenerate forks point at the
   * assistant message's codec-message-id. A Run that owns multiple messages
   * may be "in a sibling group" via its runId, but only the message that
   * corresponds to the branch anchor (the user prompt for edits, the
   * assistant slot for regens) is the actual nav target.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @returns True iff `codecMessageId` is the branch anchor of a sibling group.
   */
  hasMessageSiblings(codecMessageId: string): boolean;

  /**
   * Resolved sibling messages at the branch point anchored at
   * `codecMessageId` — one TMessage per sibling Run, picking the message
   * that occupies the anchor slot in each sibling. For an edit fork
   * (anchor is the user prompt) this is each sibling's first message;
   * for a regenerate fork (anchor is an assistant slot) this is each
   * sibling's content for that slot.
   *
   * The returned list includes the currently-selected sibling, in the
   * same order as the underlying sibling Runs (oldest first). Returns
   * `[]` when `codecMessageId` is not a branch anchor.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   */
  getMessageSiblings(codecMessageId: string): TMessage[];

  /**
   * Index of the currently selected sibling Run for the branch point
   * anchored at `codecMessageId`. Returns `0` if `codecMessageId` is not a
   * branch anchor.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   */
  getSelectedMessageSiblingIndex(codecMessageId: string): number;

  /**
   * Select a sibling Run at the branch point anchored at `codecMessageId`.
   * Updates this view's branch selection and emits `update`. No-op when
   * `codecMessageId` is not a branch anchor or `index` is out of range.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @param index - The index of the sibling to select.
   */
  selectMessageSibling(codecMessageId: string, index: number): void;

  /** Get a Run by runId, or undefined if not found. */
  getRunNode(runId: string): RunNode<TProjection> | undefined;

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
  sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun<TOutput>>;

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
  sendInput(events: TInput | TInput[], options?: SendOptions): Promise<ActiveRun<TOutput>>;

  /**
   * Regenerate an assistant message. Creates a new run that forks the
   * target message with no new user inputs. Automatically computes
   * `target` (the assistant being regenerated), `parent`, and truncated
   * `history` from this view's branch.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun<TOutput>>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf`, `parent`,
   * and `history` from this view's branch.
   */
  edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ActiveRun<TOutput>>;

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
// Internal sub-component types
// ---------------------------------------------------------------------------

/** Entry in the StreamRouter's run map. Not part of the public API. */
export interface RunEntry<TOutput extends CodecOutputEvent> {
  /** The ReadableStream consumed by the caller — retained so `getStream` can re-expose it across a suspend/resume cycle. */
  stream: ReadableStream<TOutput>;
  /** The ReadableStream controller for this run. */
  controller: ReadableStreamDefaultController<TOutput>;
  /** The run's unique identifier. */
  runId: string;
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
  readonly tree: Tree<TProjection>;

  /** The default paginated, branch-aware view for rendering — events scoped to visible messages. */
  readonly view: View<TInput, TOutput, TProjection, TMessage>;

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
  createView(): View<TInput, TOutput, TProjection, TMessage>;

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
