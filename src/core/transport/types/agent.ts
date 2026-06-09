/** Agent (server-side) session types: options, run runtime, and the Run / AgentSession contracts. */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { CancelRequest, RunEndReason } from './shared.js';
import type { MessageNode, Tree } from './tree.js';

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
   * the run's `invocationId` to arrive on the channel — across both the
   * post-attach live subscription and the bounded history scan — before
   * rejecting with `InputEventNotFound`. The rejection bubbles up to the
   * developer's HTTP handler, which should surface it as a non-2xx response
   * so the client's pending send fails.
   * Default: 30000 (30 seconds).
   */
  inputEventLookupTimeoutMs?: number;

  /**
   * How far back in time `Run.start()` scans channel history for the
   * triggering input event. Implements the lookback bound for the
   * input-event scan — anything older than `Date.now() - inputEventLookbackMs`
   * is treated as outside the lookup window.
   *
   * History is fetched with `untilAttach: true` so the scan composes
   * with the live subscription by serial boundary — together they cover
   * every message within `inputEventLookbackMs` of attach.
   *
   * Increase this for long-suspended runs whose continuation may arrive
   * many minutes after the original publish. Decrease it for stricter
   * recency.
   *
   * Default: 120000 (2 minutes).
   */
  inputEventLookbackMs?: number;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

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
   * Publish failures in `start` and `end`
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
   * Maximum number of reply RunNodes to walk back through the ancestor
   * chain. Input nodes encountered alongside don't count toward the
   * bound. Default unbounded (walks to the conversation root).
   *
   * Set this to bound the LLM context window — `maxRuns: 5` returns the
   * 5 most-recent reply runs and their associated input nodes, in
   * chronological order.
   */
  maxRuns?: number;
}

/**
 * A server-side run with explicit lifecycle methods. Generic over the codec's
 * output, projection, and message types. `TProjection` is retained for
 * parameter symmetry with {@link AgentSession.createRun}; it does not
 * appear in the Run's public surface today but keeps the type slot
 * available for future per-Run projection accessors.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- see JSDoc
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
   * (pipe, suspend, end).
   */
  start(): Promise<void>;

  /**
   * Pipe a ReadableStream through the encoder to the channel.
   * Returns when the stream completes, is cancelled, or errors.
   * Does NOT call end() — the caller must call end() after pipe returns.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;

  /**
   * Reconstruct the full multi-turn conversation by walking the ancestor
   * run chain and concatenating each run's messages, oldest turn first.
   *
   * Uses the session's history cache (extended backwards as needed) to
   * build projections for all ancestor runs plus the current run; the
   * session also merges any live Ably messages published after the channel
   * attached into the result. After this call:
   * - {@link Run.messages} returns the complete conversation (all ancestor
   *   turns followed by the current run's messages), making it ready to
   *   pass directly to the LLM.
   * - The current run's projection is cached for {@link Run.pipe}.
   * - The result is cached on this Run; a second call returns the cached
   *   value without re-fetching.
   *
   * Walks to the conversation root by default; bound the walk via channel
   * retention or the operator-set page tuning.
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
   * The Ably presence object for this session's channel.
   *
   * Exposed as a convenience so the agent can track and publish presence
   * (`enter`/`leave`/`update`/`get`/`subscribe`) — for example, to detect
   * whether the requesting user is still connected — without obtaining the
   * channel separately. This is the same `Ably.RealtimePresence` instance the
   * underlying channel exposes; the session applies no additional semantics.
   * Presence operations implicitly attach the channel and do not require
   * {@link connect} to have been called first.
   */
  readonly presence: Ably.RealtimePresence;

  /**
   * The session's materialisation tree. Every Ably message received on the channel
   * (live + history) folds into this tree; consumers can introspect hydrated
   * conversation state via {@link Tree.getNodeByCodecMessageId} /
   * {@link Tree.getRunNode} etc. Mirrors `ClientSession.tree` so both
   * sessions share one materialisation engine.
   */
  readonly tree: Tree<TOutput, TProjection>;

  /**
   * Subscribe (unfiltered) to the shared channel and (implicitly) attach. The
   * subscribe is deliberately unfiltered so channel-history-replayed input
   * events reach the materialisation engine, which the input-event lookup
   * queries via the Tree. Idempotent — subsequent calls return the same
   * promise. All run methods (`start`, `pipe`, `loadConversation`,
   * `suspend`, `end`) throw `InvalidArgument` until
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
