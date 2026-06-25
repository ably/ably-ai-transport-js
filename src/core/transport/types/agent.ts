/** Agent (server-side) session types: options, run runtime, and the AgentRun / AgentSession contracts. */

import type * as Ably from 'ably';
// Also augments RealtimeChannel with `.object` (ably/liveobjects side-effect).
import type * as AblyObjects from 'ably/liveobjects';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { BaseRun } from './run.js';
import type { CancelRequest, RunEndReason } from './shared.js';
import type { Tree } from './tree.js';
import type { View } from './view.js';

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
   * How long `Run.start()` will wait for the triggering input event
   * (`invocation.inputEventId`) to arrive on the channel — across both the
   * post-attach live subscription and the bounded history scan — before
   * rejecting with `InputEventNotFound`. The rejection bubbles up to the
   * developer's HTTP handler, which should surface it as a non-2xx response
   * so the client's pending send fails.
   * Default: 30000 (30 seconds).
   */
  inputEventLookupTimeoutMs?: number;

  /**
   * Extra Ably channel modes to request on the session's channel, on top of the
   * modes AI Transport always needs. Pass `OBJECT_MODES` (or
   * `['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']`) to use Ably LiveObjects via
   * {@link AgentSession.object}. Omit to attach with the default mode set.
   *
   * The session requests the union of these modes with the modes it always
   * needs, so passing extra modes never drops the SDK's required modes. The
   * connection's token/key capability must permit the requested operations,
   * otherwise the server grants only the permitted subset.
   */
  channelModes?: readonly Ably.ChannelMode[];

  /**
   * Wire-message limit fetched per channel-history round trip, shared by the
   * pre-run-start input-event lookup, ancestor hydration, and every `run.view`
   * pagination on this session. Independent of `loadOlder`'s reveal `limit`:
   * `loadOlder` reveals from the buffered page and only triggers a fresh fetch
   * once the buffer empties, so this tunes fetch cost, not reveal granularity.
   * Defaults to 100.
   */
  historyPageSize?: number;
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

/** Options for {@link Run.step}. */
export interface StepOptions {
  /**
   * A stable identifier for this step, used to coalesce retries: a fresh
   * attempt under an existing `stepId` supersedes the prior attempt's output
   * (latest channel serial wins) instead of appending it to the conversation.
   *
   * Omit it for the common case. The SDK then assigns an id scoped to the
   * current invocation, so steps from different invocations of the same run
   * (e.g. the original turn and a suspend/resume continuation) never collide;
   * and a no-`stepId` call made after this invocation's previous step ended
   * `failed` reuses that step's id, so an in-process `try`/`catch` retry
   * coalesces with no ceremony.
   *
   * Pass an explicit id when the SAME logical step re-attempts in a SEPARATE
   * process — a durable-execution retry — since that fresh process has no
   * in-memory step history to reuse. Use the framework's own stable step
   * identity: a Vercel Workflow DevKit `getStepMetadata().stepId` (stable
   * across retries) or a Temporal activity id, and supply a matching stable
   * {@link RunRuntime.runId} so the retry re-attempts the same run. **Omit it
   * on a cross-process retry and the SDK mints a fresh id, so the retry's
   * output is appended beside the failed attempt's instead of superseding it —
   * a silent double-output.**
   */
  stepId?: string;
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
   *
   * Under durable execution, supply a stable value so a fresh-process retry of
   * a FRESH run re-enters that run instead of minting a new UUID and opening a
   * parallel one. This is independent of {@link StepOptions.stepId}: a run id
   * is the conversation turn's identity, a step id is one re-attemptable unit
   * within the turn. Both want a stable source on retry, but they are distinct
   * ids — do not treat the framework's step id as a run id across turns, and
   * note a continuation needs no override at all (its run id comes from the
   * channel).
   *
   * A run is driven by one in-memory instance: {@link Run.step},
   * {@link Run.suspend}, and {@link Run.end} require {@link Run.start} on that
   * SAME instance (they read the anchors it resolves), so a turn's
   * start/step/end belong in one durable activity — a single run cannot be
   * split across several. A fresh-process retry re-runs `start()` and
   * re-publishes `ai-run-start` under the stable id; receivers absorb the
   * repeat idempotently (it never re-opens a terminal run).
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
   * session-level {@link AgentSession.on}('error'), not here. A failure in the
   * `onCancel` handler with no `onError` set falls back to that session emitter
   * so it is never silently dropped; a `pipe` stream failure with no `onError`
   * is always still available on {@link StreamResult.error}.
   */
  onError?: (error: Ably.ErrorInfo) => void;
}

// ---------------------------------------------------------------------------
// Run step
// ---------------------------------------------------------------------------

/**
 * A single step attempt, passed to the {@link Run.step} closure.
 *
 * A **transport step** is a re-attemptable unit of agent execution within a
 * run — it may wrap a whole agent loop (which itself runs many model/tool
 * iterations; a codec such as the Vercel one surfaces those as `step-start`
 * message *parts*, a different and finer notion than this transport step) or
 * one scheduled stage of a durable workflow. Output published via
 * {@link RunStep.pipe} is stamped with this step's id and attempt id, so a
 * retry (a new attempt under the same `stepId`) supersedes the prior attempt's
 * output cleanly rather than appending to the conversation.
 * @template TOutput - The codec output type carried by the step's stream.
 */
export interface RunStep<TOutput extends CodecOutputEvent> {
  /** This step's id — stable across retry attempts of the same step. */
  readonly stepId: string;
  /** This attempt's id — distinct on every retry of the step. */
  readonly attemptId: string;
  /**
   * The run's AbortSignal (the same one as {@link Run.abortSignal}); there is
   * no per-step abort. Fires when a cancel arrives for this run.
   */
  readonly abortSignal: AbortSignal;
  /**
   * Pipe an output stream through the encoder to the channel, stamping every
   * output with this step's `step-id` and `attempt-id`. Otherwise identical to
   * {@link Run.pipe}: returns when the stream completes, is cancelled, or
   * errors. A stream error returns `{ reason: 'error' }` (it does NOT throw)
   * and marks the step `failed` when {@link Run.step} closes it.
   * @param stream - The output stream to pipe.
   * @param options - Per-stream overrides. A per-output `resolveWriteOptions`
   *   merges over the step's default headers, so a normal override (e.g. one
   *   that only redirects `codecMessageId`) leaves `step-id` / `attempt-id`
   *   intact. Do NOT set `step-id` / `attempt-id` in an override unless you
   *   intend to re-attribute that output to a different attempt — doing so
   *   changes which step the output is gated under.
   * @returns The {@link StreamResult} for this pipe.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;
}

// ---------------------------------------------------------------------------
// Run interface
// ---------------------------------------------------------------------------

/** Options for {@link AgentRun.loadConversation}. */
export interface LoadConversationOptions {
  /**
   * Maximum number of ANCESTOR reply RunNodes to walk back through the
   * chain. Input nodes encountered alongside don't count toward the bound,
   * and neither does the current run's own node (it is the conversation
   * tail, not ancestor context). Default unbounded (walks to the
   * conversation root).
   *
   * Set this to bound the LLM context window — `maxRuns: 5` returns the
   * 5 most-recent prior reply runs and their associated input nodes
   * (each bounded run's triggering input included, so the chain never
   * starts assistant-first), in chronological order.
   */
  maxRuns?: number;
}

/**
 * How a run terminates, passed to {@link AgentRun.end}. Discriminated on `reason`:
 * an `'error'` end may carry a terminal `error`; any other reason carries none.
 */
export type RunEndParams =
  | {
      /** Why the run ended — any terminal reason other than `'error'`. */
      reason: Exclude<RunEndReason, 'error'>;
    }
  | {
      /** The run ended in error. */
      reason: 'error';
      /**
       * Optional terminal error to surface to clients. Omit to end in error
       * without detail.
       */
      error?: Ably.ErrorInfo;
    };

/**
 * A server-side run with explicit lifecycle methods, extending the shared
 * {@link BaseRun} read-model with the agent's lifecycle surface. Generic over
 * the codec's output, projection, and message types. `TProjection` is retained
 * for parameter symmetry with {@link AgentSession.createRun}; it does not
 * appear in the run's public surface today but keeps the type slot available
 * for future per-run projection accessors.
 *
 * `runId`, `status`, `error`, and the whole-turn `messages` come from
 * {@link BaseRun}; the members below are the agent's own.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- see JSDoc
export interface AgentRun<TOutput extends CodecOutputEvent, TProjection, TMessage> extends BaseRun<TMessage> {
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

  /**
   * Read-only, leaf-pinned {@link View} of this run's branch — the parent chain
   * from the run's triggering input back to the conversation root. Pinned at
   * `createRun` to `invocation.inputEventId`; empty until that trigger folds into
   * the Tree (live or via `loadOlder`). The same paginating read base the
   * client's `session.view` exposes, with no navigation or write path.
   *
   * Where {@link BaseRun.messages} is this run's own turn, `view` is a
   * paginating projection of the full branch up to this run; the un-paginated
   * conversation to feed the model comes from {@link AgentRun.loadConversation}.
   */
  readonly view: View<TMessage>;

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
   *
   * For a re-attemptable unit of work whose retries must not pollute the
   * conversation, use {@link Run.step} instead; `pipe` is the stepless path
   * (its output is never superseded by a retry).
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;

  /**
   * Run a step — a re-attemptable unit of agent work within this run, the
   * counterpart of a Temporal activity or a Vercel Workflow DevKit function
   * marked `"use step"`. Under such a framework, the framework owns execution
   * durability (it re-runs the unit) and this call owns conversation
   * cleanliness (a re-run supersedes the failed attempt's channel output);
   * see {@link StepOptions.stepId}.
   *
   * Publishes `ai-step-start`, runs `fn(step)`, then publishes `ai-step-end`
   * with reason:
   * - `failed` — if `fn` threw, OR any `step.pipe()` in `fn` returned
   *   `{ reason: 'error' }` (a stream/model/tool failure);
   * - `complete` — otherwise.
   *
   * Re-throws **only** when `fn` itself threw — so a durable-execution
   * framework's retry policy observes the error (and the run terminal is then
   * the framework's / caller's responsibility). When `fn` returns normally,
   * `step()` returns its value even if a piped stream errored, so the common
   * "compute an outcome, then `run.end(outcome)`" flow needs no `try`/`catch`.
   *
   * If `fn` may throw and you are NOT relying on a framework to drive the run
   * to a terminal, wrap the `step()` call and still publish a terminal on the
   * throw path (e.g. `run.end({ reason: 'error', error })`); otherwise the run
   * never publishes `ai-run-end` and every observer's UI stays stuck on
   * `streaming`.
   *
   * A step terminal is NOT a run terminal: call {@link Run.suspend} /
   * {@link Run.end} afterwards exactly as for {@link Run.pipe}. Must be called
   * after {@link Run.start}; throws `InvalidArgument` if the run has already
   * ended or suspended.
   *
   * `stepId` resolution (see {@link StepOptions.stepId}): an explicit
   * `options.stepId` always wins; otherwise a per-run index is used, except a
   * call with no `stepId` made after the previous step ended `failed` reuses
   * that step's id (in-process retry coalescing). A fresh `attemptId` is minted
   * on every call.
   * @template T - The closure's return type.
   * @param fn - The step body; receives a {@link RunStep}.
   * @param options - Optional {@link StepOptions}.
   * @returns The value returned by `fn`.
   * @throws Whatever `fn` throws (re-thrown after the step is closed `failed`).
   */
  step<T>(fn: (step: RunStep<TOutput>) => Promise<T>, options?: StepOptions): Promise<T>;

  /**
   * Reconstruct the full multi-turn conversation by walking the ancestor
   * run chain over the session's Tree, concatenating each ancestor's
   * projection (oldest turn first) plus the current run's projection.
   *
   * Hydrates the Tree as needed from channel history if the chain from
   * the run's structural-parent anchor isn't already fully present;
   * subsequent reads of {@link AgentRun.view} re-walk the same Tree and
   * reflect any further folds (e.g. live arrivals from concurrent runs).
   * No cache: every call computes a fresh snapshot from the live Tree.
   *
   * Walks to the conversation root by default; bound the walk via the
   * optional {@link LoadConversationOptions.maxRuns} cap. If channel
   * retention has expired older turns, the walk stops at what is available.
   * @param options - Optional walk bounds.
   * @returns The conversation messages in chronological order, ready to pass to an LLM.
   * @throws {Ably.ErrorInfo} `HistoryFetchFailed` — or the underlying Ably
   *   code when the failure carried one — when the history fetch fails after
   *   retries (the conversation is never silently truncated on fetch
   *   failure); `InvalidArgument` when the run's signal aborts.
   */
  loadConversation(options?: LoadConversationOptions): Promise<TMessage[]>;

  /**
   * Publish a run-suspend event to the channel and clean up, pausing the run
   * without ending it. Call this instead of {@link AgentRun.end} when the run is
   * waiting on participant input (e.g. a client-side tool execution or a
   * server-side tool approval): the run stays live and a later invocation can
   * resume it under the same `runId`. Like {@link AgentRun.end}, it is terminal
   * for this run instance — the resuming invocation builds a fresh run. Must be
   * called after {@link AgentRun.start}; a no-op if the run has already ended or
   * suspended.
   */
  suspend(): Promise<void>;

  /**
   * Publish run-end event to the channel and clean up. Terminal.
   * @param params - How the run ended; see {@link RunEndParams}.
   */
  end(params: RunEndParams): Promise<void>;
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
   * The Ably LiveObjects entry point for this session's channel.
   *
   * Exposed as a convenience so the agent can read and mutate shared objects
   * (LiveMap / LiveCounter) on the same channel the session uses, without
   * obtaining the channel separately. This is the same `RealtimeObject`
   * instance the underlying channel exposes; the session applies no additional
   * semantics. Operating on it requires (a) the Realtime client to have been
   * constructed with the `LiveObjects` plugin from `ably/liveobjects` and
   * (b) the object channel modes to have been requested via
   * {@link AgentSessionOptions.channelModes}. When either is absent the
   * underlying SDK throws; the session does not suppress the error.
   */
  readonly object: AblyObjects.RealtimeObject;

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
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): AgentRun<TOutput, TProjection, TMessage>;

  /**
   * Subscribe to non-fatal session-level errors not scoped to any run —
   * channel continuity loss (FAILED/SUSPENDED/DETACHED or re-attach with
   * `resumed: false`), cancel-listener/attach failures, and any run-scoped
   * error whose run supplied no `onError`. Returns an unsubscribe function.
   * Once the session is closed this is a no-op: the handler is not registered
   * and the returned function does nothing.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void;

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
