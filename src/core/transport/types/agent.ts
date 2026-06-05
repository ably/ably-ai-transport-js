/** Agent (server-side) session types: options, run runtime, and the Run / AgentSession contracts. */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { CancelRequest, RunEndReason } from './shared.js';
import type { MessageNode } from './tree.js';

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
   * Override the invocation id for this run. When omitted, the agent mints a
   * fresh `crypto.randomUUID()` — the normal path (one per HTTP request).
   * Supply a non-empty fixed value for deterministic ids in tests or
   * in-process drivers; the empty string is not a valid override (it is the
   * "unset" sentinel and does not fall through to minting).
   */
  invocationId?: string;

  /**
   * Override the run id for a FRESH run. When omitted, the agent mints a fresh
   * `crypto.randomUUID()` — the normal path. A continuation IGNORES this: its
   * run id is read from the triggering input event's wire headers, since a
   * continuation re-enters a run that already exists. Supply a non-empty fixed
   * value for deterministic ids in tests or in-process drivers; the empty
   * string is not a valid override (it is the "unset" sentinel and does not
   * fall through to minting).
   */
  runId?: string;

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
   * Publish failures in `start`, `addEvents`, and `end`
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
 * A server-side run with explicit lifecycle methods. Generic over the codec's
 * output, projection, and message types.
 */
export interface Run<TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The run's unique identifier. */
  readonly runId: string;

  /**
   * The invocation's unique identifier, minted by the agent when the run is
   * created (one per HTTP request that invokes the agent). Readable
   * synchronously — the application returns it on the HTTP response so the
   * caller can observe it. The agent stamps it on every event it publishes
   * for this invocation (run lifecycle + outputs).
   */
  readonly invocationId: string;

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

  /**
   * Publish the run's opening lifecycle event to the channel (run-start, or
   * run-resume for a continuation). Must be called before any other run method
   * (pipe, addEvents, suspend, end).
   */
  start(): Promise<void>;

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

  /**
   * Publish a run-suspend event to the channel and clean up, pausing the run
   * without ending it. Call this instead of {@link Run.end} when the run is
   * waiting on participant input (e.g. a client-side tool execution or a
   * server-side tool approval): the run stays live and a later invocation can
   * resume it under the same `runId`. Like {@link Run.end}, it is terminal for
   * this Run instance — the resuming invocation builds a fresh Run. Must be
   * called after {@link Run.start}; a no-op if the run has already ended or
   * suspended.
   */
  suspend(): Promise<void>;

  /** Publish run-end event to the channel and clean up. Terminal. */
  end(reason: RunEndReason): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent session interface
// ---------------------------------------------------------------------------

/** Server-side session that manages run lifecycles over an Ably channel. */
export interface AgentSession<TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /**
   * Subscribe (unfiltered) to the shared channel and (implicitly) attach. The
   * subscribe is deliberately unfiltered so channel-rewind-replayed input
   * events also reach the dispatcher, which routes by name (cancel vs. input
   * event). Idempotent — subsequent calls return the same promise. All run
   * methods (`start`, `addEvents`, `pipe`, `loadProjection`,
   * `loadConversation`, `suspend`, `end`) throw `InvalidArgument` until
   * `connect()` has been *called*; once it has, they await the in-flight
   * connect promise rather than throwing.
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
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): Run<TOutput, TProjection, TMessage>;

  /**
   * Unsubscribe from cancel messages, cancel all active runs, detach the
   * channel this session attached, and clean up.
   *
   * Resolves once the detach completes. The detach is best-effort:
   * a failure (e.g. the channel is already FAILED) is swallowed
   * and does not reject. Idempotent.
   */
  close(): Promise<void>;
}
