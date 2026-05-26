/**
 * Core transport types, parameterized by codec event and message types.
 *
 * These types define the contract for both client and agent (server-side)
 * session implementations, independent of which codec (Vercel AI SDK, etc.)
 * is used.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import type { Codec, WriteOptions } from '../codec/types.js';
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

/** Filter for cancel operations. At most one field should be set. */
export interface CancelFilter {
  /** Cancel a specific run by ID. */
  runId?: string;
  /** Cancel a specific invocation by ID. Targets exactly the run+invocation tuple, leaving other invocations under the same run-id untouched. */
  invocationId?: string;
  /** Cancel all runs belonging to the sender's clientId. */
  own?: boolean;
  /** Cancel all runs belonging to a specific clientId. */
  clientId?: string;
  /** Cancel all runs on the channel. */
  all?: boolean;
}

/**
 * Passed to a run's `onCancel` hook for authorization decisions.
 * The hook inspects the incoming cancel message and decides whether to
 * allow each matched run to be aborted.
 */
export interface CancelRequest {
  /** The raw Ably message that carried the cancel signal. */
  message: Ably.InboundMessage;
  /** The parsed cancel scope from the message headers. */
  filter: CancelFilter;
  /** Which active runIds would be cancelled if allowed. */
  matchedRunIds: string[];
  /** Map of runId to the ownerClientId for the matched runs. */
  runOwners: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Agent session options
// ---------------------------------------------------------------------------

/** Options for creating an agent session. */
export interface AgentSessionOptions<TEvent, TProjection, TMessage> {
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
  codec: Codec<TEvent, TProjection, TMessage>;
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
   * How long `Run.start()` will wait for the user-prompt message tagged with
   * the run's `invocationId` to arrive on the channel (rewind + live wait)
   * before rejecting with `PromptNotFound`. The rejection bubbles up to the
   * developer's HTTP handler, which should surface it as a non-2xx response
   * so the client's pending send fails.
   * Default: 30000 (30 seconds).
   */
  promptLookupTimeoutMs?: number;

  /**
   * Maximum number of distinct invocation-ids whose user-prompt messages
   * may be buffered while waiting for `Run.start()` to register a lookup
   * listener. Channel rewind on attach can replay user messages before any
   * run has been created for them; this buffer holds those messages so
   * that subsequent `start()` calls can drain them on registration.
   *
   * Each entry corresponds to one invocation-id regardless of how many
   * messages that invocation buffered. When the limit is exceeded the
   * oldest invocation entry (and all its buffered messages) is FIFO-evicted
   * — the client whose prompt was dropped will fail their lookup with
   * `PromptNotFound`. The eviction is logged at warn level so operators
   * can correlate capacity pressure with `PromptNotFound` errors.
   *
   * Default: 200.
   */
  promptBufferLimit?: number;

  /**
   * How far back the agent's channel attach rewinds when looking for
   * user-prompt messages that were published before the session
   * attached. Passed through verbatim to Ably's `params.rewind` channel
   * parameter — accepts duration strings (`"2m"`, `"30s"`) or a count of
   * messages as a string (e.g. `"50"`). Malformed values surface as a
   * channel attach error from Ably; the SDK does not pre-validate.
   *
   * A longer window improves the chances of finding a user prompt for an
   * agent that takes a while to come up after the client published, but
   * also increases the buffer pressure on `promptBufferLimit` because
   * more user messages may be replayed on attach.
   *
   * Default: `"2m"`.
   */
  promptRewindWindow?: string;
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
  /** The `x-ably-msg-id` of each published message, in order. */
  msgIds: string[];
}

/**
 * A batch of events targeting an existing message.
 * Each node specifies the target message and the events to apply to it.
 * Used for cross-run updates such as tool result delivery.
 */
export interface EventsNode<TEvent> {
  /** Discriminator — identifies this as an events node. */
  kind: 'event';
  /** The `x-ably-msg-id` of the existing message to update. */
  msgId: string;
  /** Events to apply to the target message. */
  events: TEvent[];
}

/** @deprecated Use {@link EventsNode} instead. */
export type EventNode<TEvent> = EventsNode<TEvent>;

/**
 * Options for `Run.pipe` — per-operation overrides for the assistant message.
 * @template TEvent - The codec event type carried by the stream; used by the `resolveWriteOptions` hook.
 */
export interface PipeOptions<TEvent> {
  /** The msg-id of the immediately preceding message in this branch. */
  parent?: string;
  /** The msg-id of the message this response replaces (for regeneration). */
  forkOf?: string;
  /**
   * Optional per-event hook invoked before each event is encoded. The
   * returned {@link WriteOptions} (if any) override the stream's default
   * headers and `msgId` for that one encode call only; return `undefined`
   * to use the stream defaults.
   *
   * Used to carry a subset of events within the stream to a different
   * message (e.g. `tool-output-available` chunks that belong on a prior
   * assistant message, stamped with `x-ably-amend`). Must not be used
   * for events that participate in the encoder's stream-append pipeline
   * — streaming state (stream tracker, append ordering) is anchored to
   * the stream's default identity and is not affected by per-event
   * overrides.
   * @param event - The event about to be encoded.
   * @returns Per-write overrides for this event, or undefined.
   */
  resolveWriteOptions?: (event: TEvent) => WriteOptions | undefined;
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
export interface RunRuntime<TEvent> {
  /**
   * An external abort signal (typically the HTTP request's `req.signal`) that,
   * when fired, aborts this run. This allows platform-level cancellation —
   * request cancellation, serverless function timeout — to stop LLM generation
   * and stream piping gracefully.
   */
  signal?: AbortSignal;

  /**
   * Called before each Ably message is published in this run.
   * Mutate the Ably message in place to add custom extras.headers.
   */
  onMessage?: (message: Ably.Message) => void;

  /**
   * Called when the run's stream is aborted (by cancel or server).
   * Receives a write function to publish final events before the abort finalises.
   */
  onAbort?: (write: (event: TEvent) => Promise<void>) => void | Promise<void>;

  /**
   * Called when a cancel message arrives matching this run.
   * Return true to allow cancellation (fires abortSignal, stream aborts).
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
 * this run was created with. Mirrors the spec example
 * `run.view.messages.map(n => n.message)`. A thin facade for now — the
 * eventual full conversation view is forthcoming.
 */
export interface RunView<TMessage> {
  /** Messages along the selected branch as the agent should see them. */
  readonly messages: MessageNode<TMessage>[];
}

/** A server-side run with explicit lifecycle methods. */
export interface Run<TEvent, TProjection, TMessage> {
  /** The run's unique identifier. */
  readonly runId: string;

  /** Abort signal scoped to this run. Fires when a cancel event arrives for this runId. */
  readonly abortSignal: AbortSignal;

  /** Read-only view of the conversation messages associated with this run. */
  readonly view: RunView<TMessage>;

  /**
   * The conversation messages this run should feed to the model — the
   * prior-conversation history overlaid with codec-folded state for any
   * continuation tool resolutions, followed by the user-prompt messages
   * looked up on the channel for this invocation.
   *
   * Before {@link start} resolves: equals the invocation's `history`
   * (no view contribution yet). After {@link start}: continuation
   * overlay applied + the run's own view-message contributions appended.
   *
   * Each access returns a fresh array — safe to mutate without affecting
   * internal Run state.
   */
  readonly messages: TMessage[];

  /** Publish run-start event to the channel. Must be called before addMessages or pipe. */
  start(): Promise<void>;

  /**
   * Publish user messages to the channel, scoped to this run.
   * Each node's `msgId`, `parentId`, and `forkOf` are used for message identity
   * and branching. The node's `headers` override session-generated defaults
   * (e.g. for optimistic reconciliation with the client's inserts).
   * @returns The msg-ids of all published messages, in order.
   */
  addMessages(messages: MessageNode<TMessage>[], options?: AddMessageOptions): Promise<AddMessagesResult>;

  /**
   * Pipe a ReadableStream through the encoder to the channel.
   * Returns when the stream completes, is cancelled, or errors.
   * Does NOT call end() — the caller must call end() after pipe returns.
   */
  pipe(stream: ReadableStream<TEvent>, options?: PipeOptions<TEvent>): Promise<StreamResult>;

  /**
   * Publish events targeting existing messages in the tree. Each node
   * specifies a target message (by `msgId`) and the events to apply.
   * Events are encoded and published with the target's `x-ably-msg-id`,
   * so receiving clients apply them to the existing node rather than
   * creating a new one.
   *
   * Used for cross-run updates such as tool result delivery after
   * approval or client-side tool execution.
   */
  addEvents(nodes: EventsNode<TEvent>[]): Promise<void>;

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

  /** Publish run-end event to the channel and clean up. */
  end(reason: RunEndReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent session interface
// ---------------------------------------------------------------------------

/** Server-side session that manages run lifecycles over an Ably channel. */
export interface AgentSession<TEvent, TProjection, TMessage> {
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
   * immediately so that early cancels fire the abort signal.
   * @param invocation - The {@link Invocation} carrying run identity and
   *   conversation messages.
   * @param runtime - Optional runtime hooks and external abort signal
   *   (e.g. the HTTP request's `req.signal`).
   */
  createRun(invocation: Invocation<TMessage>, runtime?: RunRuntime<TEvent>): Run<TEvent, TProjection, TMessage>;

  /** Unsubscribe from cancel messages, abort all active runs, and clean up. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Client session options
// ---------------------------------------------------------------------------

/** Options for creating a client session. */
export interface ClientSessionOptions<TEvent, TProjection, TMessage> {
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
  codec: Codec<TEvent, TProjection, TMessage>;

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

  /**
   * How long `sendMessage()` / `sendEvent()` will wait for the agent's `ai-run-start` event for
   * the run+invocation before rejecting with `RunStartDeadlineExceeded`.
   * Default: 30000 (30 seconds).
   */
  runStartDeadlineMs?: number;

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
   * The msg-id of the message this send replaces (fork).
   * Set for regeneration (forkOf an assistant message) or
   * edit (forkOf a user message).
   */
  forkOf?: string;
  /**
   * The msg-id of the message that precedes this one in the
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
      /** The msg-id of the parent message, if known. Omitted for root runs. */
      parent?: string;
      /** The msg-id being forked/replaced, if this is a regeneration or edit. */
      forkOf?: string;
      /**
       * True when the agent published this `run-start` as a continuation
       * of an already-started run (e.g. a tool-result follow-up invocation
       * under the same runId). Surfaced from the `x-ably-run-continue`
       * wire header. Absent for the first start of a run.
       */
      isContinuation?: boolean;
    }
  | { type: 'ai-run-end'; runId: string; clientId: string; reason: RunEndReason };

// ---------------------------------------------------------------------------
// Active run handle
// ---------------------------------------------------------------------------

/** A handle to an active client-side run, returned by `sendMessage()`, `sendEvent()`, `regenerate()`, and `edit()`. */
export interface ActiveRun<TEvent> {
  /** The decoded event stream for this run. May error if the delivery guarantee is broken (e.g. POST failure, channel continuity loss). */
  stream: ReadableStream<TEvent>;
  /** The run's unique identifier. */
  runId: string;
  /**
   * The invocation's unique identifier. Stamped on the published user
   * message and forwarded in the HTTP POST body so the agent's run
   * lifecycle events (`ai-run-start`, `ai-run-end`) can echo it
   * back. The Tree's winning-invocation map and the run-end gate key on
   * this value.
   */
  invocationId: string;
  /** Cancel this specific run. Publishes a cancel message and closes the local stream. */
  cancel(): Promise<void>;
  /**
   * The msg-ids of optimistically inserted user messages, in order.
   * Present when the send included user messages (edit); empty for
   * regeneration (no user messages to insert optimistically).
   */
  optimisticMsgIds: string[];
  /**
   * The per-prompt ids minted for this send, in order — one entry per
   * user-message event published. Empty when the send carried no
   * user-message events (continuation). The same list is sent in the
   * POST body's `promptIds` field for the agent to look up.
   */
  promptIds: string[];
}

// ---------------------------------------------------------------------------
// Close options
// ---------------------------------------------------------------------------

/** Options for closing a client session. */
export interface CloseOptions {
  /** Cancel in-progress runs before closing. Publishes a cancel message to the channel. */
  cancel?: CancelFilter;
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
  /** The x-ably-msg-id of this node — primary key in the tree. */
  msgId: string;
  /** Parent node's msg-id (x-ably-parent), or undefined for root messages. */
  parentId: string | undefined;
  /** The msg-id this node forks from (x-ably-fork-of), or undefined if first version. */
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
 * Materializes a branching conversation tree from a flat oplog.
 *
 * Owns the complete conversation state — every node from live messages and
 * history. `flattenNodes()` returns the linear message list for the currently
 * selected branches. Events fire for any change across the full tree.
 */
export interface Tree<TMessage> {
  /**
   * Get all messages that are siblings (alternatives) at a given
   * fork point. Returns an array ordered chronologically by serial.
   * The message identified by msgId is always included.
   */
  getSiblings(msgId: string): TMessage[];

  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings(msgId: string): boolean;

  /** Get a node by msgId, or undefined if not found. */
  getNode(msgId: string): MessageNode<TMessage> | undefined;

  /** Get the stored headers for a node by msgId, or undefined if not found. */
  getHeaders(msgId: string): Record<string, string> | undefined;

  // --- Mutation (used by the session, not the UI) ---

  /**
   * Insert or update a message in the tree. Reads parent/forkOf from the
   * provided headers. If the message already exists (by msgId), updates
   * it in place. The optional serial is the Ably message serial used for
   * deterministic sibling ordering.
   */
  upsert(msgId: string, message: TMessage, headers: Record<string, string>, serial?: string): void;

  /** Remove a message from the tree. */
  delete(msgId: string): void;

  // --- Events ---

  /** Active run IDs grouped by clientId (all runs, not just visible). */
  getActiveRunIds(): Map<string, Set<string>>;

  /**
   * Get the winning invocation-id for a run-id, if known.
   *
   * Within a run-id, the invocation whose user-message has the highest Ably
   * channel serial is canonical. Earlier invocations are losers and their
   * downstream events should be filtered. Optimistic (null-serial) inserts
   * never win — the entry only updates once a relayed user-message with a
   * real serial arrives.
   * @param runId - The run-id to query.
   * @returns The winning invocation's id and serial, or undefined if no
   *   user-message with this run-id has been observed yet.
   */
  getWinningInvocation(runId: string): { invocationId: string; serial: string } | undefined;

  /** Subscribe to tree structure changes (insert, update, delete). */
  on(event: 'update', handler: () => void): () => void;

  /** Subscribe to raw Ably messages arriving on the channel. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** Subscribe to run lifecycle events (start and end). */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /**
   * Subscribe to changes in the per-run winning invocation map. Fires when a
   * run's winning invocation-id changes (either first observation or
   * replacement by a higher-serial user-message).
   */
  on(
    event: 'invocation-winner-changed',
    handler: (event: { runId: string; invocationId: string; serial: string }) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// View — windowed projection over the tree
// ---------------------------------------------------------------------------

/**
 * A paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of the selected branch. New live messages
 * appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers
 * are only notified when the visible output changes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TEvent and TProjection are part of the codec generic triple kept symmetric with ClientSession; the View surface itself is message-shape-only
export interface View<TEvent, TProjection, TMessage> {
  /** The visible domain messages along the selected branch. Shorthand for `flattenNodes().map(n => n.message)`. */
  getMessages(): TMessage[];

  /** Visible nodes along the selected branch, filtered by the pagination window. */
  flattenNodes(): MessageNode<TMessage>[];

  /** Whether there are older messages that can be loaded or revealed. */
  hasOlder(): boolean;

  /**
   * Reveal older messages. Loads from channel history if the tree doesn't
   * have enough, then advances the window to show up to `limit` more messages.
   * Emits 'update' when the visible list changes.
   * @param limit - Maximum number of older messages to reveal. Defaults to 100.
   */
  loadOlder(limit?: number): Promise<void>;

  // --- Branch navigation ---

  /**
   * Select a sibling at a fork point by index. Updates this view's
   * branch selection. Index is clamped to `[0, siblings.length - 1]`.
   * Emits 'update' when the visible output changes.
   */
  select(msgId: string, index: number): void;

  /** Get the index of the currently selected sibling at a fork point. */
  getSelectedIndex(msgId: string): number;

  /**
   * Get all messages that are siblings (alternatives) at a given
   * fork point. Returns an array ordered chronologically by serial.
   */
  getSiblings(msgId: string): TMessage[];

  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings(msgId: string): boolean;

  /** Get a node by msgId, or undefined if not found. */
  getNode(msgId: string): MessageNode<TMessage> | undefined;

  // --- Write operations ---

  /**
   * Send one or more user messages and start a new run. Each TMessage is
   * wrapped into a `UserMessageEvent` TEvent via `Codec.userMessageEvent`
   * before being published, so callers can pass TMessage values directly
   * without manually constructing the event shape.
   *
   * The parent is auto-computed from this view's selected branch unless
   * overridden. The HTTP POST is fire-and-forget — the returned stream is
   * available immediately. If the POST fails, the error is surfaced via
   * the session's `on("error")` and the stream is errored.
   */
  sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun<TEvent>>;

  /**
   * Send one or more TEvents on the channel and fire a POST.
   *
   * Two input shapes are accepted:
   *
   * - `TEvent` / `TEvent[]` — the SDK mints a fresh `x-ably-msg-id` per
   *   event for the wire publish.
   * - `Array<{ event, domainMessageId? }>` — per-event publish hint.
   *   `domainMessageId`, when set, is used as the wire `HEADER_MSG_ID`
   *   for that event instead of a freshly-minted UUID. Used by the
   *   chat-transport adapter to publish continuation tool resolutions
   *   onto an existing assistant's tree key: the wire stamps the
   *   assistant's `x-ably-msg-id`, the reducer's direct fold path
   *   runs, and the chunk lands on the assistant's projection entry
   *   without a cross-message redirect.
   *
   * Convention: a send containing at least one `UserMessageEvent` is a
   * fresh send (mints a new `runId`). A send containing only
   * tool-resolution events is a continuation — pair with
   * `options.runId` to extend a suspended run.
   */
  sendEvent(
    events: TEvent | TEvent[] | { event: TEvent; domainMessageId?: string }[],
    options?: SendOptions,
  ): Promise<ActiveRun<TEvent>>;

  /**
   * Regenerate an assistant message. Creates a new run that forks the
   * target message with no new user events. Automatically computes
   * `forkOf`, `parent`, and truncated `history` from this view's branch.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun<TEvent>>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf`, `parent`,
   * and `history` from this view's branch.
   */
  edit(messageId: string, newEvents: TEvent | TEvent[], options?: SendOptions): Promise<ActiveRun<TEvent>>;

  // --- Observation ---

  /** Active run IDs for runs with visible messages, grouped by clientId. */
  getActiveRunIds(): Map<string, Set<string>>;

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
export interface RunEntry<TEvent> {
  /** The ReadableStream consumed by the caller — retained so `rebindStream` can re-expose it across a suspend/resume cycle. */
  stream: ReadableStream<TEvent>;
  /** The ReadableStream controller for this run. */
  controller: ReadableStreamDefaultController<TEvent>;
  /** The run's unique identifier. */
  runId: string;
  /** The invocation-id this stream is bound to. Events from a different invocation under the same runId are dropped. */
  invocationId: string;
}

// ---------------------------------------------------------------------------
// Client session interface
// ---------------------------------------------------------------------------

/** Client-side session that manages conversation state over an Ably channel. */
export interface ClientSession<TEvent, TProjection, TMessage> {
  /** The complete conversation tree — all known nodes, events for any change. */
  readonly tree: Tree<TMessage>;

  /** The default paginated, branch-aware view for rendering — events scoped to visible messages. */
  readonly view: View<TEvent, TProjection, TMessage>;

  /**
   * Subscribe to the channel and (implicitly) attach. Idempotent —
   * subsequent calls return the same promise. `sendMessage()`,
   * `sendEvent()`, `regenerate()`, `edit()`, `update()`, `cancel()`, and
   * `waitForRun()` throw
   * `InvalidArgument` until `connect()` resolves.
   */
  connect(): Promise<void>;

  /**
   * Create an additional view over the same conversation tree.
   * Each view has independent branch selections and pagination state.
   * The caller is responsible for calling `close()` on the returned view
   * when it is no longer needed, or it will be closed when the session closes.
   */
  createView(): View<TEvent, TProjection, TMessage>;

  /** Cancel runs matching the filter. Defaults to `{ own: true }` (all own runs). */
  cancel(filter?: CancelFilter): Promise<void>;

  /**
   * Returns a promise that resolves when all active runs matching the filter
   * have completed. Resolves immediately if no matching runs are active.
   * Defaults to `{ own: true }`.
   */
  waitForRun(filter?: CancelFilter): Promise<void>;

  /**
   * Subscribe to non-fatal session errors. These indicate something went
   * wrong but the session is still operational. Returns an unsubscribe function.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

  /**
   * Tear down the session: unsubscribe from the channel, close active
   * streams, clear all handlers, and prevent further operations.
   *
   * Pass `cancel` to publish a cancel message before closing. Without it,
   * only local state is torn down (the server keeps streaming).
   */
  close(options?: CloseOptions): Promise<void>;
}
