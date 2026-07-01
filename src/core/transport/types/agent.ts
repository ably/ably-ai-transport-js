/** Agent (server-side) session types: options, run runtime, and the AgentRun / AgentSession contracts. */

import type * as Ably from 'ably';
// Also augments RealtimeChannel with `.object` (ably/liveobjects side-effect).
import type * as AblyObjects from 'ably/liveobjects';

import type { Logger } from '../../../logger.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, WriteOptions } from '../../codec/types.js';
import type { Invocation } from '../invocation.js';
import type { BaseRun } from './run.js';
import type { CancelRequest, RunEndReason, StepEndReason } from './shared.js';
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
   * the session's `detach()` / `end()` do not close the client.
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
   * Wire-message limit fetched per channel-history round trip, used by every
   * `run.view` pagination on this session (the sole history-fetch consumer).
   * Independent of `loadOlder`'s reveal `limit`: `loadOlder` reveals from the
   * buffered page and only triggers a fresh fetch once the buffer empties, so
   * this tunes fetch cost, not reveal granularity. Defaults to 100.
   */
  historyPageSize?: number;

  /**
   * Advanced. How long (ms, on the Ably message-timestamp timeline) a
   * structurally complete run's event log is retained after its last activity
   * before the Tree may drop it. The log is what lets a late, out-of-order wire
   * refold into canonical position and a superseding step retry drop a dead
   * attempt's output; once dropped, such a wire degrades to arrival order.
   *
   * Raise it for a durable agent whose step retries back off longer than the
   * default, so a much-later rescheduled `ai-step-start` still finds the dead
   * attempt's log to supersede; lower it in tests for deterministic, fast
   * sweeps. Defaults to 120000 (2 minutes).
   */
  reorderWindowMs?: number;
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

/** Options for {@link Run.createStep}. */
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

  /**
   * The clientId to attribute this step to — the participant whose
   * most-recently-incorporated input shapes it (the innermost of the three
   * concentric client-identity scopes; stamped as `step-client-id`).
   *
   * Omit it for the common case. The SDK then resolves the step's client by
   * inheriting the prior step's value (sticky), or, for the run's first step,
   * defaulting to the triggering input's publisher (`input-client-id`). Supply
   * an explicit value when a steer incorporates a fresh input mid-run so the
   * step attributes to that input's publisher rather than inheriting the prior
   * step's client — the seam a steering signal populates. A run with no steering
   * never sets it and the sticky default suffices.
   */
  stepClientId?: string;
}

/** Parameters for {@link RunStep.end}. */
export interface StepEndParams {
  /**
   * The terminal reason. Omit to derive it from the step's piped output —
   * `failed` if any {@link RunStep.pipe} errored, else `complete` — so the
   * common "compute an outcome, then `run.end(outcome)`" flow needs no
   * `try`/`catch`. Pass an explicit reason to override.
   */
  reason?: StepEndReason;
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
   * A run's lifecycle CAN span several processes under this stable id. `start()`
   * opens the run in one activity (publishing `ai-run-start` ONCE); a fresh
   * process then continues it via {@link AgentSession.adoptRun} + `load()`, which
   * resolves the run's anchors from the channel and adopts it for publishing
   * WITHOUT republishing `ai-run-start`, before calling {@link AgentRun.createStep} /
   * {@link AgentRun.suspend} / {@link AgentRun.end}. The publish methods gate on whether
   * the run is open — set by `start()` OR an adopting `load()` — not on "was
   * `start()` called on this instance", so a durable turn's open / step / end
   * may each be a separate retryable activity. (A fresh-process step retry
   * adopts and re-emits its `ai-step-start` under the same {@link StepOptions.stepId}
   * to supersede the dead attempt; it does NOT re-open the run.)
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
 * A single step attempt within a run, created by {@link AgentRun.createStep}.
 *
 * A **transport step** is a re-attemptable unit of agent execution within a
 * run — it may wrap a whole agent loop (which itself runs many model/tool
 * iterations; a codec such as the Vercel one surfaces those as `step-start`
 * message *parts*, a different and finer notion than this transport step) or
 * one scheduled stage of a durable workflow. Output published via
 * {@link RunStep.pipe} is stamped with this step's id, so a retry (a fresh
 * `ai-step-start` under the same `stepId`, with a later serial) supersedes the
 * prior attempt's output cleanly rather than appending to the conversation.
 * @template TOutput - The codec output type carried by the step's stream.
 */
export interface RunStep<TOutput extends CodecOutputEvent> {
  /** This step's id — stable across retry attempts of the same step. */
  readonly stepId: string;
  /**
   * The run's AbortSignal (the same one as {@link AgentRun.abortSignal}); there is
   * no per-step abort. Fires when a cancel arrives for this run.
   */
  readonly abortSignal: AbortSignal;
  /**
   * Publish `ai-step-start`, opening the step for output. Call once, after
   * {@link OpenableRun.start} on the run and before {@link RunStep.pipe}. Idempotent —
   * a second call is a no-op. Rejects if another step is already active on the
   * run (only one step may be open at a time), or if the run has ended.
   * @throws InvalidArgument if another step is active or the run has ended.
   */
  start(): Promise<void>;
  /**
   * Pipe an output stream through the encoder to the channel, stamping every
   * output with this step's `step-id` and its attempt's `start-serial`.
   * Otherwise identical to {@link AgentRun.pipe}: returns when the stream completes,
   * is cancelled, or errors. A stream error returns `{ reason: 'error' }` (it
   * does NOT throw) and marks the step `failed` when {@link RunStep.end} closes
   * it.
   * @param stream - The output stream to pipe.
   * @param options - Per-stream overrides. A per-output `resolveWriteOptions`
   *   merges over the step's default headers, so a normal override (e.g. one
   *   that only redirects `codecMessageId`) leaves `step-id` intact. The SDK
   *   stamps `start-serial` after the override is applied, so an override cannot
   *   change it; do NOT set `step-id` in an override unless you intend to
   *   re-attribute that output to a different step.
   * @returns The {@link StreamResult} for this pipe.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;
  /**
   * Publish `ai-step-end`, closing the step. Idempotent — a second call is a
   * no-op. Omit `params` to derive the reason from the step's piped output
   * (`failed` if any {@link RunStep.pipe} errored, else `complete`), so the
   * common "compute an outcome, then `run.end(outcome)`" flow needs no
   * `try`/`catch`; pass an explicit `reason` to override.
   *
   * A step terminal is NOT a run terminal: drive the run to {@link AgentRun.suspend}
   * / {@link AgentRun.end} afterwards exactly as for {@link AgentRun.pipe}. {@link AgentRun.end}
   * auto-closes a still-open step, so a forgotten `end()` cannot strand
   * observers — but an explicit `end()` is clearer and lets you set the reason.
   * @param params - Optional {@link StepEndParams}; the reason is derived if omitted.
   */
  end(params?: StepEndParams): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run interface
// ---------------------------------------------------------------------------

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
 * {@link BaseRun} read-model with the agent's lifecycle surface. The COMMON
 * publishable surface shared by {@link OpenableRun} (which adds `start()`) and
 * {@link AdoptedRun} (which adds `load()`) — the opening verb is factory-specific
 * so opening a created run with `load()`, or an adopted run with `start()`, is a
 * compile error. Generic over the codec's output, projection, and message types.
 * `TProjection` is retained for parameter symmetry with
 * {@link AgentSession.createRun}; it does not appear in the run's public surface
 * today but keeps the type slot available for future per-run projection accessors.
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
   * paginating projection of the branch up to this run — the conversation to
   * feed the model. Drain it with `loadOlder()` (the sole history driver) for as
   * much ancestor context as you want, or page back to a database seam.
   *
   * The projection includes an ancestor turn only when its run completed
   * (`status: 'complete'`); an ancestor run that is still active, suspended,
   * cancelled, or errored is omitted along with the user input it replied to, so
   * an unresolved tool call from a broken prior turn can't invalidate the prompt.
   * This run itself is always included, even mid-flight. The omission is computed
   * live on each read, so an ancestor that later completes reappears.
   */
  readonly view: View<TMessage>;

  /**
   * Resolves when this run's triggering input (`invocation.inputEventId`) folds
   * into the Tree — whether by a live arrival or a `run.view.loadOlder()` page
   * the caller drove on a cold start — i.e. the moment `run.view`'s pinned leaf
   * becomes present. Resolves immediately when the invocation carries no
   * `inputEventId` (nothing to locate).
   *
   * There is no built-in deadline: it never rejects on a timeout. It rejects
   * only if the run is cancelled or the session is closed before the trigger
   * folds. Race it against your own timeout if you need one. {@link AgentRun.start}
   * awaits this internally before reading the trigger's wire headers, so you
   * only await it directly to read the trigger (or page extra ancestor context)
   * before deciding how to start. An {@link AdoptedRun.load} awaits it too,
   * before adopting the run for publishing.
   */
  readonly located: Promise<void>;

  /**
   * Pipe a ReadableStream through the encoder to the channel.
   * Returns when the stream completes, is cancelled, or errors.
   * Does NOT call end() — the caller must call end() after pipe returns.
   *
   * Brackets the output in ONE implicit step (so all agent output is published
   * within a step), opened LAZILY at the first output: it publishes
   * `ai-step-start` immediately before the first chunk, stamps every chunk with
   * that step's `step-id` and its attempt's `start-serial`, then publishes
   * `ai-step-end` (`complete`, or `failed` if the stream errored). A pipe that
   * produces NO
   * output — an empty stream, or one that errors or is cancelled before any
   * chunk — brackets ZERO steps (no empty `ai-step-start` / `ai-step-end`).
   *
   * Each `pipe` call opens its OWN fresh implicit step, so two `pipe` calls are
   * two independent steps and two assistant messages — a second `pipe` does NOT
   * supersede the first. Only an explicit, stable `stepId` supersedes, which
   * `pipe` never sets; for a re-attemptable unit whose retries must supersede
   * the prior attempt's output rather than appending it, use {@link AgentRun.createStep}.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;

  /**
   * Create a step — a re-attemptable unit of agent work within this run, the
   * counterpart of a Temporal activity or a Vercel Workflow DevKit function
   * marked `"use step"`. Under such a framework, the framework owns execution
   * durability (it re-runs the unit) and this call owns conversation
   * cleanliness (a re-run supersedes the failed attempt's channel output);
   * see {@link StepOptions.stepId}.
   *
   * Returns a {@link RunStep} handle whose lifecycle mirrors the run: call
   * {@link RunStep.start} to publish `ai-step-start`, {@link RunStep.pipe} to
   * stream output, then {@link RunStep.end} to publish `ai-step-end`. `end()`
   * with no reason derives `failed` if any `pipe()` errored, else `complete`,
   * so the common "compute an outcome, then `run.end(outcome)`" flow needs no
   * `try`/`catch`. If your step logic may throw, close the step on the throw
   * path yourself (`step.end({ reason: 'failed' })`) and drive the run to a
   * terminal; otherwise the run never publishes `ai-run-end` and every
   * observer's UI stays stuck on `streaming`.
   *
   * Creating the handle (id minting) is synchronous and does no I/O — only
   * {@link RunStep.start} publishes. Exactly one step may be active on a run at
   * a time; `start()` rejects if another is still open. A step terminal is NOT
   * a run terminal: call {@link AgentRun.suspend} / {@link AgentRun.end} afterwards as for
   * {@link AgentRun.pipe}. If a step is left open, {@link AgentRun.end} auto-closes it so
   * observers are never stranded.
   *
   * `stepId` resolution (see {@link StepOptions.stepId}): an explicit
   * `options.stepId` always wins; otherwise a per-run index is used, except a
   * call with no `stepId` made after the previous step ended `failed` reuses
   * that step's id (in-process retry coalescing).
   *
   * The run must be open first ({@link OpenableRun.start}, or an adopting
   * {@link AdoptedRun.load}); the returned handle's `start()` throws
   * `InvalidArgument` if the run is not open, or has already ended or suspended.
   * @param options - Optional {@link StepOptions}.
   * @returns A {@link RunStep} handle to drive the step's lifecycle.
   */
  createStep(options?: StepOptions): RunStep<TOutput>;

  /**
   * Publish a run-suspend event to the channel and clean up, pausing the run
   * without ending it. Call this instead of {@link AgentRun.end} when the run is
   * waiting on participant input (e.g. a client-side tool execution or a
   * server-side tool approval): the run stays live and a later invocation can
   * resume it under the same `runId`. Like {@link AgentRun.end}, it is terminal
   * for this run instance — the resuming invocation builds a fresh run. The run
   * must be open ({@link OpenableRun.start} or an adopting {@link AdoptedRun.load}
   * called first); a no-op if the run has already ended or suspended.
   */
  suspend(): Promise<void>;

  /**
   * Publish run-end event to the channel and clean up. Terminal. The run must be
   * open ({@link OpenableRun.start} or an adopting {@link AdoptedRun.load} called
   * first); a no-op if the run has already ended or suspended.
   * @param params - How the run ended; see {@link RunEndParams}.
   */
  end(params: RunEndParams): Promise<void>;
}

/**
 * The identity of an existing run, passed to {@link AgentSession.adoptRun} so a
 * fresh process can resolve that run's write context off the channel and adopt
 * it for publishing. The three fields are plain data threaded across the process
 * boundary by the orchestration that opened the run — the run object itself does
 * not cross processes (its read-model is reconstructible from the channel).
 */
export interface AdoptIdentity {
  /**
   * The existing run's id. Authoritative: unlike {@link OpenableRun.start}'s
   * continuation path, {@link AdoptedRun.load} does NOT re-key the run from the
   * trigger event's `run-id` header (for a delegation trigger that header names
   * the PARENT run, not this one).
   */
  runId: string;
  /**
   * This activity's invocation id — e.g. the step/end activity's id, or a
   * distinct cancel-cleanup id. Stamped on every event this process publishes
   * for the run. Independent of the run's owner identity.
   */
  invocationId: string;
  /**
   * The id of the event whose headers resolve the run's write-time anchors (an
   * `ai-input` for a normal turn). The same trigger every activity of an
   * invocation resolves against — a step carries no input event of its own.
   */
  triggerEventId: string;
}

/**
 * A created run: the OPENING role. {@link OpenableRun.start} publishes the run's
 * opening lifecycle event (`ai-run-start`, or `ai-run-resume` for a continuation
 * whose trigger carries a run-id) and opens the run for publishing. Returned by
 * {@link AgentSession.createRun}. `load()` is not available — a created run is
 * opened by publishing, never adopted.
 */
export interface OpenableRun<TOutput extends CodecOutputEvent, TProjection, TMessage> extends AgentRun<
  TOutput,
  TProjection,
  TMessage
> {
  /**
   * Publish the run's opening lifecycle event to the channel (run-start, or
   * run-resume for a continuation). Awaits {@link AgentRun.located} first — so a
   * cold-start caller pages `run.view` for context, then calls `start()` and
   * locating is handled for them — then reads the trigger's wire headers and
   * publishes, opening the run for publishing. Must be called before any other
   * run method (pipe, step, suspend, end). Idempotent — a second call is a
   * no-op. Propagates `located`'s rejection (cancel / session close).
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the run was cancelled before
   *   `start()` (or `located` rejected on cancel / session close);
   *   `RunLifecycleError` when the opening publish fails.
   */
  start(): Promise<void>;
}

/**
 * An adopted run: the CONTINUE role. {@link AdoptedRun.load} resolves the run's
 * write context off the channel and adopts an already-open run for publishing in
 * THIS process WITHOUT publishing an opening event. Returned by
 * {@link AgentSession.adoptRun} for a step / end / cancel-cleanup activity that
 * an orchestrator runs in a fresh process. `start()` is not available — an
 * adopted run was opened elsewhere; publishing another opening event would
 * corrupt its lifecycle.
 */
export interface AdoptedRun<TOutput extends CodecOutputEvent, TProjection, TMessage> extends AgentRun<
  TOutput,
  TProjection,
  TMessage
> {
  /**
   * Resolve this run's write context from the channel and adopt it for publishing
   * in this process, WITHOUT publishing an opening event. Awaits the run's
   * `ai-run-start` to be observed so its `startSerial` is confirmed on the Tree
   * (bounded by `timeoutMs`, paging channel history as needed); awaits
   * {@link AgentRun.located} so the trigger ({@link AdoptIdentity.triggerEventId})
   * resolves the run's anchors and pins {@link AgentRun.view}; then status-gates:
   * an `active` run is adopted; a `suspended` or terminal run is rejected.
   * Idempotent — a second call is a no-op.
   *
   * Side effects on success: pins {@link AgentRun.view} to the triggering branch;
   * seeds the run's owner into the run manager so output AND the terminal stamp
   * the real `run-client-id`; and MAY fire {@link AgentRun.abortSignal} before
   * returning if a cancel for this run already arrived (the run is registered for
   * cancel routing by its authoritative `runId` at `adoptRun`, so such a cancel
   * fires the signal directly — there is no deferred-cancel buffering, which only
   * applies to a fresh run whose `runId` is unknown at cancel time).
   * @param options - Adopt options.
   * @param options.timeoutMs - How long to wait for the run's `ai-run-start` to
   *   be observed on the channel before rejecting. Defaults to 30000.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the run is suspended
   *   ("resume via `createRun().start()`") or terminal (read-only), or when the
   *   run was cancelled before `load()`; `InputEventNotFound` when the run's
   *   `ai-run-start` is not observed within `timeoutMs` (a workflow-ordering
   *   error; retryable).
   */
  load(options?: { timeoutMs?: number }): Promise<void>;
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
   * events fold into the Tree and surface through its event-id index and
   * `ably-message` event — the two sources each run's input-event watcher uses
   * to catch a trigger published before the agent attached. Idempotent —
   * subsequent calls return the same promise. All run methods (`start`, `load`,
   * `pipe`, `suspend`, `end`) throw `InvalidArgument` until `connect()` has been
   * called (`connect` must be *invoked* first; once it has, they await the
   * in-flight connect promise rather than throwing).
   */
  connect(): Promise<void>;

  /**
   * Create a new run from an invocation — the OPENING role. Returns an
   * {@link OpenableRun} whose `start()` publishes the run's opening event.
   * Returns synchronously, and arms the run's input-event watcher — a passive
   * pre-scan of the Tree plus a listener for the trigger's arrival (it publishes
   * nothing to the channel until start()). The run is registered for cancel
   * routing immediately so that early cancels fire the AbortSignal.
   * @param invocation - The {@link Invocation} carrying run identity and
   *   conversation messages.
   * @param runtime - Optional runtime hooks and external AbortSignal
   *   (e.g. the HTTP request's `req.signal`).
   */
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): OpenableRun<TOutput, TProjection, TMessage>;

  /**
   * Adopt an existing run by its {@link AdoptIdentity} — the CONTINUE role for a
   * step / end / cancel-cleanup activity running in a fresh process. Returns an
   * {@link AdoptedRun} whose `load()` resolves the run's write context off the
   * channel and adopts it WITHOUT publishing an opening event. Returns
   * synchronously, and arms the run's input-event watcher for the trigger (it
   * publishes nothing to the channel until load()). The run is registered for
   * cancel routing immediately so that early cancels fire the AbortSignal.
   * @param identity - The existing run's {@link AdoptIdentity} (runId,
   *   invocationId, triggerEventId).
   * @param runtime - Optional runtime hooks and external AbortSignal. The
   *   `runtime.runId` / `runtime.invocationId` overrides do not apply — identity
   *   comes from `identity`.
   */
  adoptRun(identity: AdoptIdentity, runtime?: RunRuntime<TOutput>): AdoptedRun<TOutput, TProjection, TMessage>;

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
   * Gracefully end the session: for every still-OPEN run this session owns,
   * close its open step (if any) then publish `ai-run-end{cancelled}` — so a
   * forgotten `run.end()` (a fire-and-forget turn) still closes every observer's
   * stream rather than leaving it stuck `streaming` — then do everything
   * {@link detach} does (abort + channel detach). The onion mirrors `run.end()` one layer
   * up: `session.end -> run.end -> step.end`, the step-end preceding the run-end
   * on the wire via `run.end`'s existing auto-close.
   *
   * An open run ends `{cancelled}` — not `complete` (would falsely mark an
   * unfinished turn done), not `suspend` (hangs observers with no resumer;
   * preserve-for-resume is {@link detach}'s job), not `error`. Use this as the
   * normal teardown for a non-durable agent. A durable in-flight activity uses
   * {@link detach} instead, to hand a still-open run off to the next activity
   * WITHOUT terminating it. Resolves once the terminals are published and the
   * detach completes. Idempotent.
   */
  end(): Promise<void>;

  /**
   * Detach-only teardown: unsubscribe from cancel messages, abort all active
   * runs' controllers (firing their `abortSignal`), detach the channel this
   * session attached, and clean up. Publishes NO run terminal — an open run is
   * left as-is on the channel, to be resumed or cleaned up by another process.
   * This is the escape hatch a durable in-flight activity uses to hand a run off
   * mid-sequence; for graceful teardown that closes open runs, use {@link end}.
   *
   * Resolves once the detach completes. The detach is best-effort:
   * a failure (e.g. the channel is already FAILED) is swallowed
   * and does not reject. Idempotent.
   */
  detach(): Promise<void>;
}
