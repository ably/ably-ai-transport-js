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
   * session-level {@link AgentSession.on}('error'), not here. A failure in the
   * `onCancel` handler with no `onError` set falls back to that session emitter
   * so it is never silently dropped; a `pipe` stream failure with no `onError`
   * is always still available on {@link StreamResult.error}.
   */
  onError?: (error: Ably.ErrorInfo) => void;
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
   * paginating projection of the full branch up to this run — the conversation
   * to feed the model. Drain it with `loadOlder()` (the sole history driver) for
   * as much ancestor context as you want, or page back to a database seam.
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
   * before deciding how to start.
   */
  readonly located: Promise<void>;

  /**
   * Publish the run's opening lifecycle event to the channel (run-start, or
   * run-resume for a continuation). Awaits {@link AgentRun.located} first — so a
   * cold-start caller pages `run.view` for context, then calls `start()` and
   * locating is handled for them — then reads the trigger's wire headers and
   * publishes. Must be called before any other run method (pipe, suspend, end).
   * Propagates `located`'s rejection (cancel / session close).
   */
  start(): Promise<void>;

  /**
   * Pipe a ReadableStream through the encoder to the channel.
   * Returns when the stream completes, is cancelled, or errors.
   * Does NOT call end() — the caller must call end() after pipe returns.
   */
  pipe(stream: ReadableStream<TOutput>, options?: PipeOptions<TOutput>): Promise<StreamResult>;

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
   * events fold into the Tree and surface through its event-id index and
   * `ably-message` event — the two sources each run's input-event watcher uses
   * to catch a trigger published before the agent attached. Idempotent —
   * subsequent calls return the same promise. All run methods (`start`, `pipe`,
   * `suspend`, `end`) throw `InvalidArgument` until `connect()` has been *called*;
   * once it has, they await the in-flight connect promise rather than throwing.
   */
  connect(): Promise<void>;

  /**
   * Create a new run from an invocation. Returns synchronously, and arms the
   * run's input-event watcher — a passive pre-scan of the Tree plus a listener
   * for the trigger's arrival (it publishes nothing to the channel until
   * start()). The run is registered for cancel routing immediately so that
   * early cancels fire the AbortSignal.
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
