/**
 * Core agent (server-side) session, parameterized by codec.
 *
 * Composes RunManager and pipeStream to handle the full server-side run
 * lifecycle. Cancel message routing is handled directly by the session's
 * single channel subscription — no separate cancel manager needed.
 *
 * The session exposes two run-construction factories with different return
 * types: `createRun()` returns an OpenableRun (its `start()` opens a new run by
 * publishing) and `adoptRun()` returns an AdoptedRun (its `load()` adopts an
 * already-open run for publishing in a fresh process, without publishing an
 * opening event). Both share the common publishable surface — pipe(), step(),
 * suspend(), and end() (suspend() and end() are both terminal) — built by one
 * internal run-object builder parameterised by an opening strategy.
 */

import * as Ably from 'ably';
// Also augments RealtimeChannel with `.object` (ably/liveobjects side-effect).
import type * as AblyObjects from 'ably/liveobjects';

import {
  EVENT_CANCEL,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { registerAgent } from '../agent.js';
import { resolveChannelModes } from '../channel-options.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { createBaseRun } from './base-run.js';
import { readCancelTarget } from './cancel-envelope.js';
import { foldAndEmit, type WireApplier } from './decode-fold.js';
import { createHistoryHydrator, type HistoryHydrator } from './history-hydrator.js';
import { locateInputEvent } from './input-event-locator.js';
import { evictOldestIfFull } from './internal/bounded-map.js';
import { Invocation } from './invocation.js';
import { createLeafBranchSource } from './leaf-branch-source.js';
import { createMaterialisation } from './materialisation.js';
import type { RunManager } from './run-manager.js';
import { createRunManager } from './run-manager.js';
import { createRunStepWriter, stepEndReasonFor } from './run-step-writer.js';
import {
  bestEffortDetach,
  continuityLostError,
  handleWireMessage,
  isContinuityLost,
  noopUnsubscribe,
  requireConnected,
  SessionState,
  subscribeAndAttach,
} from './session-support.js';
import type { DefaultTree } from './tree.js';
import type {
  AdoptedRun,
  AdoptIdentity,
  AgentRun,
  AgentSession,
  AgentSessionOptions,
  CancelRequest,
  OpenableRun,
  RunEndParams,
  RunRuntime,
  RunStatus,
  Tree,
  View,
} from './types.js';
import { createLeafView } from './view.js';

/**
 * Upper bound on buffered deferred cancels. Deferred cancels are bounded so
 * a pathological burst can't grow the map without bound. 200 outstanding
 * fresh-send cancels in flight is ample — a typical agent process sees one
 * per HTTP request.
 */
const DEFERRED_CANCEL_LIMIT = 200;

// ---------------------------------------------------------------------------
// Internal run record for cancel routing
// ---------------------------------------------------------------------------

interface RegisteredRun {
  runId: string;
  /** Invocation-id this run is associated with, minted by the agent at `createRun` (or the `runtime.invocationId` override). */
  invocationId: string;
  controller: AbortController;
  /** Composite signal that fires when either the internal controller or the external signal aborts. */
  signal: AbortSignal;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
  /**
   * Resolve this run's `located` promise. Captured from the `located` executor
   * (which runs synchronously) so the input-event watcher and the no-trigger
   * branch can settle it without a forward-declared local.
   */
  resolveLocated?: () => void;
  /**
   * Reject this run's `located` promise. Called by `close()` so a run parked in
   * `start()` awaiting its trigger fails with `SessionClosed` rather than hanging
   * (the deadline-free counterpart to the client's `started` rejection on close).
   */
  rejectLocated?: (error: Ably.ErrorInfo) => void;
  /**
   * End this run `{cancelled}`, driven by {@link AgentSession.end}'s graceful
   * teardown. Set once the run object is built (it delegates to `run.end`, which
   * auto-closes the open step before the run terminal). Present only while the
   * run is OPEN — the run deregisters (dropping this entry) on its own terminal,
   * so `end()` only ends runs still open. A no-op for a run that never opened
   * (still `INITIALIZED`): `run.end` rejects an unopened run, so the hook guards
   * on the open state.
   */
  endCancelled?: () => Promise<void>;
}

/**
 * How a run is opened, chosen by the construction factory and threaded into the
 * one internal run-object builder. `start` (from `createRun`) publishes the
 * opening event and may re-key the run-id from a continuation's trigger header;
 * `adopt` (from `adoptRun`) waits for the run-start to hydrate, status-gates,
 * seeds the owner, and opens WITHOUT publishing — its identity is authoritative,
 * so the trigger's run-id header never re-keys it.
 */
type OpenStrategy = { open: 'start' } | { open: 'adopt'; identity: AdoptIdentity };

/**
 * Whether a run status is terminal (no further publishing is valid). The
 * publish methods re-read {@link AgentRun.status} at entry and no-op / reject on
 * a terminal — the backstop for a run that went terminal since it was opened
 * (e.g. a concurrent cancel cleanup).
 * @param status - The run's current status.
 * @returns True when the run has reached a terminal status.
 */
const isTerminalStatus = (status: RunStatus): boolean =>
  status === 'complete' || status === 'cancelled' || status === 'error';

// Event map for the session's typed EventEmitter.
interface AgentSessionEventsMap {
  error: Ably.ErrorInfo;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-ST1
class DefaultAgentSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements AgentSession<TOutput, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger | undefined;
  // Typed event emitter — the session emits only 'error'; all data events live on the Tree.
  private readonly _emitter: EventEmitter<AgentSessionEventsMap>;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /**
   * Reverse index from a run's triggering input codec-message-id to its
   * run-id, populated once `Run.start()`'s input-event lookup resolves the
   * triggering input. Lets `_handleCancelMessage` route a cancel keyed by the
   * input codec-message-id (a fresh send whose run-id the client doesn't know)
   * to the registered run. Entries are removed when the run ends / suspends /
   * the session closes, alongside `_registeredRuns`.
   */
  private readonly _runIdByInputCodecMessageId = new Map<string, string>();
  /**
   * Cancels buffered by triggering input codec-message-id when they arrived
   * before the run was known — i.e. before `Run.start()`'s input-event lookup
   * resolved that input to a run. A fresh run has no run-id at the client's
   * send time (the agent mints it at run-start), so an early cancel can only be
   * keyed by the input codec-message-id, and the `inputCodecMessageId → run`
   * linkage doesn't exist until the lookup completes. `Run.start()` consults
   * this buffer as a PULL once it resolves its `resolvedInputCodecMessageId`,
   * honouring any cancel that arrived first. Cleared on `close()`.
   */
  private readonly _deferredCancels = new Map<string, Ably.InboundMessage>();
  /**
   * Session-owned materialisation tree. Every message (live + history) folds
   * through `this._applier.apply(msg)`; conversation state is read by
   * walking parent pointers from the input node.
   *
   * Replaced (not cleared in place) on channel continuity loss so that the
   * fresh tree starts empty. The old tree is abandoned to GC once in-flight
   * lookups have aborted.
   */
  private _tree: DefaultTree<TInput, TOutput, TProjection>;
  /**
   * The Tree's single decode-and-apply engine, binding one inbound decoder
   * instance shared by every fold route (live + history). Streaming across
   * pages folds correctly because the decoder keeps stream-tracker state
   * across messages. Replaced alongside the Tree on continuity loss so the
   * fresh Tree gets a fresh decoder. Outbound encoders (used by `Run.pipe`)
   * manage their own decoders.
   */
  private _applier: WireApplier;
  /**
   * The shared channel-history paging engine, bound to the current Tree/applier.
   * Drives `run.view`'s `loadOlder()` pagination — the single history driver —
   * across the session's runs off ONE single-flight cursor. Recreated alongside
   * the Tree/applier on continuity loss so the fresh Tree gets a fresh cursor and
   * exhaustion state.
   */
  private _hydrator: HistoryHydrator;
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  /** Wire-message page size for history fetches; reapplied when the hydrator is recreated on continuity loss. */
  private readonly _historyPageSize: number | undefined;
  /** Event-log retention window (ms) for the Tree; reapplied when the Tree is recreated on continuity loss. */
  private readonly _reorderWindowMs: number | undefined;

  private _state = SessionState.READY;
  private _connectPromise: Promise<void> | undefined;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>) {
    this._codec = options.codec;
    // Spec: AIT-ST1a, AIT-ST1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const registerOptions = registerAgent(options.client, options.codec);
    const channelOptions: Ably.ChannelOptions = { ...registerOptions };
    // Spec: AIT-ST16 — request object modes etc. when channelModes opts in.
    const modes = resolveChannelModes(options.channelModes);
    if (modes) channelOptions.modes = modes;
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._logger = options.logger?.withContext({ component: 'AgentSession' });
    this._emitter = new EventEmitter<AgentSessionEventsMap>(this._logger ?? makeLogger({ logLevel: LogLevel.Silent }));
    this._runManager = createRunManager(this._channel, this._logger);
    this._historyPageSize = options.historyPageSize;
    this._reorderWindowMs = options.reorderWindowMs;
    const { tree, applier } = createMaterialisation(this._codec, this._logger, this._reorderWindowMs);
    this._tree = tree;
    this._applier = applier;
    this._hydrator = this._createHydrator();

    this._channelListener = (msg: Ably.InboundMessage) => {
      this._handleChannelMessage(msg);
    };

    // Spec: AIT-ST12, AIT-ST12a
    // Listen for channel state changes that break message continuity. The
    // session only consumes cancel messages from the channel, so losing one
    // is survivable — but the developer needs to know so they can decide
    // whether to cancel in-flight work. _hasAttachedOnce is seeded from the
    // channel's current state so pre-attached channels are handled correctly;
    // it distinguishes the initial attach from a genuine discontinuity.
    this._hasAttachedOnce = this._channel.state === 'attached';
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);

    this._logger?.debug('DefaultAgentSession(); session created');
  }

  /**
   * Build a HistoryHydrator over the session's CURRENT Tree + applier. Called at
   * construction and again after a continuity-loss swap so the fresh Tree gets a
   * fresh single-flight cursor and exhaustion state.
   * @returns A fresh hydrator over the current Tree/applier.
   */
  private _createHydrator(): HistoryHydrator {
    return createHistoryHydrator({
      channel: this._channel,
      tree: this._tree,
      applier: this._applier,
      pageSize: this._historyPageSize,
      logger: this._logger,
    });
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  // Spec: AIT-ST14
  get presence(): Ably.RealtimePresence {
    return this._channel.presence;
  }

  // Spec: AIT-ST15
  get object(): AblyObjects.RealtimeObject {
    return this._channel.object;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Spec: AIT-ST2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === SessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger?.trace('DefaultAgentSession.connect();');
    // Subscribe unfiltered (before attach, per RTL7g — subscribe implicitly
    // attaches the channel). Unfiltered so the Tree folds every post-attach
    // message regardless of name (cancel control messages are dispatched
    // separately by the channel listener after the Tree fold).
    this._connectPromise = subscribeAndAttach(
      this._channel,
      this._channelListener,
      this._logger,
      'DefaultAgentSession',
      (error) => {
        this._emitter.emit('error', error);
      },
    );
    return this._connectPromise;
  }

  /**
   * The session-owned materialisation tree. Mirrors `ClientSession.tree`
   * for observability and parity.
   * @returns The session's Tree.
   */
  get tree(): Tree<TOutput, TProjection> {
    return this._tree;
  }

  // Spec: AIT-ST3
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): OpenableRun<TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.createRun();', { inputEventId: invocation.inputEventId });
    return this._createRun(invocation, runtime ?? {}, { open: 'start' });
  }

  adoptRun(identity: AdoptIdentity, runtime?: RunRuntime<TOutput>): AdoptedRun<TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.adoptRun();', {
      runId: identity.runId,
      triggerEventId: identity.triggerEventId,
    });
    // The adopt path takes identity from `identity` (authoritative), not the
    // runtime overrides — its run-id, invocation-id, and trigger come from the
    // orchestration that opened the run. Build an Invocation pinned to the
    // trigger event so the shared run-object body arms the input-event watcher
    // for it.
    const invocation = Invocation.fromJSON({ inputEventId: identity.triggerEventId, sessionName: '' });
    return this._createRun(invocation, runtime ?? {}, { open: 'adopt', identity });
  }

  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._state === SessionState.CLOSED) return noopUnsubscribe;
    this._emitter.on(event, handler);
    return () => {
      this._emitter.off(event, handler);
    };
  }

  async end(): Promise<void> {
    if (this._state === SessionState.CLOSED) return;
    this._logger?.trace('DefaultAgentSession.end();');

    // End every still-open run `{cancelled}` BEFORE detaching, so the terminals
    // (and each run's preceding step-end, via run.end's auto-close) reach the
    // channel while the session is still connected. Snapshot the registrations
    // first: run.end deregisters as it ends, mutating `_registeredRuns` under us.
    // Best-effort per run — one run's publish failure must not strand the others
    // or block the detach.
    const open = [...this._registeredRuns.values()];
    for (const reg of open) {
      try {
        await reg.endCancelled?.();
      } catch (error) {
        this._logger?.error('DefaultAgentSession.end(); failed to end open run', { runId: reg.runId });
        // Surface so a publish failure on teardown is observable, never silent.
        this._emitter.emit(
          'error',
          new Ably.ErrorInfo(
            `unable to end run ${reg.runId} on session end; ${errorMessage(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            errorCause(error),
          ),
        );
      }
      // Fire the run's abort signal so in-process consumers observe the cancel.
      // run.end deregistered this run (so close()'s abort loop won't reach it),
      // and an unopened run's hook no-op'd without ending — abort it here either
      // way, matching close()'s abort-all teardown.
      reg.controller.abort();
    }

    // Then do everything close() does (detach + abort any run that survived the
    // loop, e.g. one created after this snapshot — close() is idempotent here).
    await this.close();

    this._logger?.debug('DefaultAgentSession.end(); session ended');
  }

  // Spec: AIT-ST11
  async close(): Promise<void> {
    if (this._state === SessionState.CLOSED) return;
    this._state = SessionState.CLOSED;
    this._logger?.trace('DefaultAgentSession.close();');
    if (this._connectPromise) {
      this._channel.unsubscribe(this._channelListener);
    }
    this._channel.off(this._onChannelStateChange);
    const closedErr = new Ably.ErrorInfo('unable to locate input event; session closed', ErrorCode.SessionClosed, 400);
    for (const reg of this._registeredRuns.values()) {
      // Reject a run parked in start() awaiting its trigger with SessionClosed
      // (before the abort, so `located` settles on the closed error rather than
      // the cancel error the abort would otherwise raise).
      reg.rejectLocated?.(closedErr);
      reg.controller.abort();
    }
    this._registeredRuns.clear();
    this._runIdByInputCodecMessageId.clear();
    this._deferredCancels.clear();
    this._emitter.off();
    this._runManager.close();

    await bestEffortDetach(this._channel, this._connectPromise, this._logger, 'DefaultAgentSession');

    this._logger?.debug('DefaultAgentSession.close(); session closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const { runId, inputCodecMessageId } = readCancelTarget(msg);

    // Malformed cancel: drop with warn. A cancel must identify its target by
    // `run-id` (a continuation, whose run-id the client knows) and/or by
    // `input-codec-message-id` (a fresh send, before the agent minted the
    // run-id). Neither present means there is nothing to route to.
    if (!runId && !inputCodecMessageId) {
      this._logger?.warn('DefaultAgentSession._handleCancelMessage(); missing run-id and input-codec-message-id', {
        serial: msg.serial,
      });
      return;
    }

    // Primary path — match by run-id (continuations, whose run-id the client
    // already knows). Resolve the input-codec-message-id to a run-id when the
    // run-id wasn't supplied (a fresh-send cancel that arrived after the run's
    // input-event lookup resolved, so the linkage already exists).
    const resolvedRunId =
      runId ?? (inputCodecMessageId ? this._runIdByInputCodecMessageId.get(inputCodecMessageId) : undefined);
    const reg = resolvedRunId ? this._registeredRuns.get(resolvedRunId) : undefined;

    if (!reg) {
      // The run isn't known yet. A fresh-send cancel can race ahead of the
      // run's input-event lookup (which is what establishes the
      // input-codec-message-id → run linkage). Buffer it by
      // input-codec-message-id so `Run.start()` can pull and honour it once it
      // resolves the triggering input. A bare run-id cancel for an unknown run
      // is a no-op (the run never existed here, or already ended).
      if (inputCodecMessageId !== undefined) {
        this._bufferDeferredCancel(inputCodecMessageId, msg);
      }
      return;
    }

    await this._cancelRegistration(reg, msg);
  }

  /**
   * Buffer a cancel that arrived before its target run was known, keyed by the
   * triggering input's codec-message-id. FIFO-evicts the oldest entry at
   * {@link DEFERRED_CANCEL_LIMIT}. A later cancel for the same input replaces the earlier
   * one — the intent is identical.
   * @param inputCodecMessageId - The triggering input's codec-message-id.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private _bufferDeferredCancel(inputCodecMessageId: string, msg: Ably.InboundMessage): void {
    const evicted = evictOldestIfFull(this._deferredCancels, inputCodecMessageId, DEFERRED_CANCEL_LIMIT);
    if (evicted !== undefined) {
      this._logger?.warn('DefaultAgentSession._bufferDeferredCancel(); deferred-cancel buffer full, dropping oldest', {
        evictedInputCodecMessageId: evicted,
        limit: DEFERRED_CANCEL_LIMIT,
      });
    }
    this._deferredCancels.set(inputCodecMessageId, msg);
    this._logger?.debug('DefaultAgentSession._bufferDeferredCancel(); buffered early cancel', {
      inputCodecMessageId,
      serial: msg.serial,
    });
  }

  /**
   * Pull and honour a cancel buffered before this run was known. Called from
   * `Run.start()` once the input-event lookup resolves the run's triggering
   * input codec-message-id — the point at which the
   * `input-codec-message-id → run` linkage first exists. No-op when no cancel
   * was buffered for that input.
   * @param reg - The now-known run registration.
   * @param inputCodecMessageId - The run's resolved triggering input codec-message-id.
   */
  private async _pullDeferredCancel(reg: RegisteredRun, inputCodecMessageId: string): Promise<void> {
    const buffered = this._deferredCancels.get(inputCodecMessageId);
    if (buffered === undefined) return;
    this._deferredCancels.delete(inputCodecMessageId);
    this._logger?.debug('DefaultAgentSession._pullDeferredCancel(); honouring buffered cancel', {
      runId: reg.runId,
      inputCodecMessageId,
    });
    await this._cancelRegistration(reg, buffered);
  }

  /**
   * Fire a cancel against a known run: consult its `onCancel` authorization
   * hook (if any), then abort the run's controller. Shared by the run-id match,
   * the input-codec-message-id match, and the buffered-cancel pull so all three
   * honour `onCancel` and surface handler errors identically.
   * @param reg - The target run registration.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private async _cancelRegistration(reg: RegisteredRun, msg: Ably.InboundMessage): Promise<void> {
    const { runId } = reg;
    this._logger?.debug('DefaultAgentSession._cancelRegistration(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          this._logger?.debug('DefaultAgentSession._cancelRegistration(); cancel rejected by onCancel', {
            runId,
          });
          return;
        }
      }
      reg.controller.abort();
      this._logger?.debug('DefaultAgentSession._cancelRegistration(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${errorMessage(error)}`,
        ErrorCode.CancelListenerError,
        500,
        errorCause(error),
      );
      this._logger?.error('DefaultAgentSession._cancelRegistration(); onCancel threw', { runId });
      // Run-scoped error: prefer the run's own handler; fall back to the
      // session emitter so it is never silently dropped.
      if (reg.onError) reg.onError(errInfo);
      else this._emitter.emit('error', errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Channel state change handler
  // -------------------------------------------------------------------------

  // Spec: AIT-ST12, AIT-ST12a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === SessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity.
    if (current === 'attached' && !this._hasAttachedOnce) {
      this._hasAttachedOnce = true;
      return;
    }

    if (!isContinuityLost(stateChange)) return;

    this._logger?.error('DefaultAgentSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const continuityErr = continuityLostError(stateChange, 'continue');

    // Abort every active run's controller FIRST so an in-flight `located`
    // watcher (and any `run.view.loadOlder()` paging) observes the abort before
    // the Tree changes underneath it and rejects (InvalidArgument from its
    // signal check; the session-level on('error') carries ChannelContinuityLost).
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }

    // Then swap the Tree for a fresh empty instance — abandons the old
    // Tree's projections, indices, and ably-message listeners to GC. New
    // runs use the fresh Tree; lingering closures on the old Tree from
    // in-flight (now-aborted) lookups are bounded by the abort propagation.
    // Reapply the configured retention window so the fresh Tree matches.
    const { tree, applier } = createMaterialisation(this._codec, this._logger, this._reorderWindowMs);
    this._tree = tree;
    this._applier = applier;
    // Rebuild the hydrator against the fresh Tree/applier — this resets its
    // cursor and exhaustion state. Each run's leaf source reads the Tree via the
    // live `getTree()` accessor and its run.view reads the hydrator via
    // `getHydrator()`, so both observe the swap without being recreated.
    this._hydrator = this._createHydrator();

    // Session-level notification: continuity loss is not scoped to any one
    // run. Per-run onError handlers are reserved for errors from that run's
    // own operations (publish failures, encoder errors).
    this._emitter.emit('error', continuityErr);
  }

  // -------------------------------------------------------------------------
  // Wire fold
  // -------------------------------------------------------------------------

  /**
   * Fold a single wire message into the session-owned Tree. Mirrors the
   * ClientSession's live decode loop — same engine, same fold path. The
   * applier decodes the message and applies the result to the Tree (or
   * routes lifecycle messages through `applyRunLifecycle`);
   * `emitAblyMessage` notifies Tree subscribers AND populates the event-id
   * index the input-event lookup ({@link locateInputEvent}) reads.
   *
   * A message that surfaces via more than one path (the live listener and
   * the hydrator's history walk) does not
   * double-fold: the shared decoder's version-guarded trackers drop
   * re-delivered stream content, and the Tree's per-entry `decodedThrough`
   * high-water-mark drops whole-wire replays (including stateless discrete
   * re-decodes) at the correct per-delivery granularity — same-serial live
   * appends each carry their own version and fold exactly once.
   * @param wire - The inbound Ably message to fold.
   */
  private _foldWire(wire: Ably.InboundMessage): void {
    foldAndEmit(this._applier, this._tree, wire);
  }

  // -------------------------------------------------------------------------
  // Channel subscription handler
  // -------------------------------------------------------------------------

  private _handleChannelMessage(msg: Ably.InboundMessage): void {
    handleWireMessage(
      () => {
        // Fold first (re-delivered content is dropped by the shared decoder's
        // version guard and the Tree's replay guard), then dispatch cancel
        // control messages.
        this._foldWire(msg);

        if (msg.name === EVENT_CANCEL) {
          // Fire-and-forget async handler — errors are caught internally.
          this._handleCancelMessage(msg).catch((error: unknown) => {
            const errInfo = new Ably.ErrorInfo(
              `unable to route cancel message; ${errorMessage(error)}`,
              ErrorCode.CancelListenerError,
              500,
              errorCause(error),
            );
            this._logger?.error('DefaultAgentSession._handleChannelMessage(); cancel routing error');
            this._emitter.emit('error', errInfo);
          });
        }
      },
      (error) => {
        this._logger?.error('DefaultAgentSession._handleChannelMessage(); subscription error');
        this._emitter.emit('error', error);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Connection guard
  // -------------------------------------------------------------------------

  private async _requireConnected(method: string): Promise<void> {
    return requireConnected(this._connectPromise, method);
  }

  // -------------------------------------------------------------------------
  // Run creation
  // -------------------------------------------------------------------------

  private _createRun(
    invocation: Invocation,
    runtime: RunRuntime<TOutput>,
    strategy: { open: 'start' },
  ): OpenableRun<TOutput, TProjection, TMessage>;
  private _createRun(
    invocation: Invocation,
    runtime: RunRuntime<TOutput>,
    strategy: { open: 'adopt'; identity: AdoptIdentity },
  ): AdoptedRun<TOutput, TProjection, TMessage>;
  private _createRun(
    invocation: Invocation,
    runtime: RunRuntime<TOutput>,
    strategy: OpenStrategy,
  ): OpenableRun<TOutput, TProjection, TMessage> | AdoptedRun<TOutput, TProjection, TMessage> {
    // Identity. For a CREATED run the agent mints a provisional run-id (or takes
    // the `runtime.runId` override for tests / in-process drivers) — this IS the
    // id for a fresh run, and a continuation re-keys it in the watcher's
    // `resolveTriggerMetadata` from the trigger's `run-id` header. For an ADOPTED
    // run the identity is AUTHORITATIVE: its run-id / invocation-id come from
    // `AdoptIdentity` and the trigger's run-id header NEVER re-keys it.
    let runId = strategy.open === 'adopt' ? strategy.identity.runId : (runtime.runId ?? crypto.randomUUID());
    // The invocation id is the agent's mint (one per HTTP request) for a created
    // run, or the authoritative `AdoptIdentity.invocationId` for an adopted one.
    const invocationId =
      strategy.open === 'adopt' ? strategy.identity.invocationId : (runtime.invocationId ?? crypto.randomUUID());
    const { onCancel, onError: runOnError, signal: externalSignal } = runtime;

    // Whether the run is being adopted (vs. created). Identity is authoritative
    // on the adopt path: the trigger's run-id header never re-keys the run (for a
    // delegation trigger that header names the PARENT run, not this one).
    const adopting = strategy.open === 'adopt';

    const controller = new AbortController();
    // Whether the run has published its terminal (an end or a suspend). The
    // publish guards read it to reject after-terminal calls; `open` owns whether
    // the run is publishable at all.
    let ended = false;
    // Whether the run is open for publishing — set by `start()` (created) or an
    // adopting `load()` (adopted, active). The publish methods (pipe / step /
    // suspend / end) guard on this instead of a process-local "started here"
    // state, so a fresh process that adopted the run can publish.
    let open = false;
    // Synchronous re-entrancy latch for the opening verb (start / load). Set
    // BEFORE the verb's first await so two overlapping calls can't both fall
    // through and double-publish run-start / double-seed the owner — `open` only
    // flips AFTER the publish/adopt completes, leaving a window the latch closes.
    // Never reset on a throw: a failed open does not re-open.
    let opening = false;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) cancels the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so `close()` aborts an in-flight
    // start() and a post-lookup cancel can fire the AbortSignal. Keyed by the
    // provisional run-id; a continuation re-keys to the real id in the
    // input-event watcher (resolveTriggerMetadata) once the triggering input
    // reveals it.
    const registration: RegisteredRun = {
      runId,
      invocationId,
      controller,
      signal,
      onCancel,
      onError: runOnError,
    };
    this._registeredRuns.set(runId, registration);

    // Capture instance members as locals so arrow functions close over them
    // without needing `this` (avoids unicorn/no-this-assignment).
    const logger = this._logger;
    const runManager = this._runManager;
    const codec = this._codec;
    const channel = this._channel;
    const registeredRuns = this._registeredRuns;
    const runIdByInputCodecMessageId = this._runIdByInputCodecMessageId;
    const deferredCancels = this._deferredCancels;
    const requireConnected = this._requireConnected.bind(this);
    // Live accessors (not captured refs): a continuity-loss swap replaces the
    // Tree and hydrator, and reads after the swap must observe the fresh
    // instances. The per-run leaf source reads the Tree; run.view reads both.
    const getTree = (): DefaultTree<TInput, TOutput, TProjection> => this._tree;
    const getHydrator = (): HistoryHydrator => this._hydrator;
    const pullDeferredCancel = this._pullDeferredCancel.bind(this);
    const inputEventId = invocation.inputEventId;

    // Per-run metadata resolved from the input-event lookup result. The matched
    // input event's headers carry the run's `clientId`, `parent`, and
    // `forkOf`, and — for a continuation — the `run-id` it re-enters (a fresh
    // input carries none; the client stamps a run-id only when re-entering a
    // run it already knows). Its Ably-level publisher `clientId` becomes the
    // `inputClientId` re-stamped on the agent's own publishes.
    let resolvedClientId: string | undefined;
    let resolvedInputClientId: string | undefined;
    let resolvedParent: string | undefined;
    let resolvedForkOf: string | undefined;
    let resolvedRegenerates: string | undefined;
    let resolvedInputCodecMessageId: string | undefined;
    let resolvedContinuation = false;

    // The run's leaf-pinned branch strategy. It projects no branch until the
    // triggering input folds in and the watcher (armed below) calls
    // `leafSource.setPin(...)` — which may happen before `start()` when the
    // caller pages `run.view` first. It reads the live Tree above through
    // `getTree`, observing a continuity-loss swap. It also backs `Run.messages`.
    const viewLogger = logger ?? makeLogger({ logLevel: LogLevel.Silent });
    const leafSource = createLeafBranchSource<TInput, TOutput, TProjection, TMessage>({
      getTree,
      codec,
    });
    // run.view — the run's read-only, leaf-pinned, paginating View: the same read
    // base the client's `session.view` exposes, projecting the branch the leaf
    // source resolves.
    const view: View<TMessage> = createLeafView<TInput, TOutput, TProjection, TMessage>({
      tree: getTree(),
      codec,
      hydrator: getHydrator(),
      branchSource: leafSource,
      logger: viewLogger,
    });
    /**
     * The reply run's structural-parent fallback, computed by the input-event
     * watcher (`resolveTriggerMetadata`) when the triggering input folds in, and
     * consumed by every `Run.pipe()` publish. A per-stream `streamOpts.parent`
     * still overrides it. Storing it here keeps it stable across pipes and
     * decouples the assistant's structural parent from the run-start message's
     * own `parent`.
     */
    let assistantParentFallback: string | undefined;
    /**
     * Remove this run from the session's routing maps and close its `run.view`.
     * Drops the `_registeredRuns` entry plus the `input-codec-message-id → run-id`
     * reverse index (and any stale deferred cancel still buffered for that
     * input), and tears down `run.view`'s Tree subscriptions so they don't
     * accumulate across the runs of a long-lived session. Called when the run
     * ends, suspends, or its start fails.
     */
    const deregisterRun = (): void => {
      registeredRuns.delete(runId);
      if (resolvedInputCodecMessageId !== undefined) {
        runIdByInputCodecMessageId.delete(resolvedInputCodecMessageId);
        deferredCancels.delete(resolvedInputCodecMessageId);
      }
      view.close();
    };

    /**
     * Resolve per-run metadata from the matched triggering input event and pin
     * run.view to its branch. Run synchronously by the input-event watcher the
     * instant the trigger folds in (a live arrival or a `run.view.loadOlder()`
     * page) — which may be before `start()` when the caller pages run.view
     * first, so the pinned branch is visible immediately.
     *
     * The matched input event's headers carry the run's `clientId`, `parent`,
     * and `forkOf`, and — for a continuation — the `run-id` it re-enters (a
     * fresh input carries none; the client stamps a run-id only when re-entering
     * a run it already knows). The Ably-level publisher `clientId` becomes the
     * `inputClientId` re-stamped on the agent's own publishes.
     * @param headers - Transport headers of the matched input event.
     * @param publisherClientId - The matched input event's Ably publisher clientId.
     */
    const resolveTriggerMetadata = (
      headers: Record<string, string> | undefined,
      publisherClientId: string | undefined,
    ): void => {
      if (publisherClientId !== undefined) resolvedInputClientId = publisherClientId;
      if (headers) {
        resolvedClientId = headers[HEADER_RUN_CLIENT_ID];
        resolvedParent = headers[HEADER_PARENT];
        resolvedForkOf = headers[HEADER_FORK_OF];
        resolvedRegenerates = headers[HEADER_MSG_REGENERATE];
        resolvedInputCodecMessageId = headers[HEADER_CODEC_MESSAGE_ID];

        // The triggering input's run-id (if any). For a CREATED run it IS this
        // run's identity: present → a continuation re-entering that run, so adopt
        // the id, overriding the provisional one minted at construction, and
        // re-key the registration so cancel routing / deregistration resolve to
        // the real run; absent → a fresh run, the provisional id stands and the
        // run opens with run-start. For an ADOPTED run the run-id is fixed from
        // `AdoptIdentity` and the trigger's run-id header NEVER re-keys it (a
        // delegation trigger carries the PARENT's id).
        const wireRunId = headers[HEADER_RUN_ID];
        resolvedContinuation = wireRunId !== undefined;
        if (!adopting && wireRunId !== undefined && wireRunId !== runId) {
          registeredRuns.delete(runId);
          runId = wireRunId;
          registration.runId = runId;
          registeredRuns.set(runId, registration);
        }
      }

      // Compute the reply run's structural-parent fallback: the triggering user
      // message's codec-message-id ONLY if that codec-message-id is backed by a
      // real node in the Tree (the message decoded into at least one input
      // event); otherwise — for regenerate carriers that are wire-only signals
      // with no input events — fall back to the input message's own `parent`.
      assistantParentFallback =
        resolvedInputCodecMessageId !== undefined &&
        getTree().getNodeByCodecMessageId(resolvedInputCodecMessageId) !== undefined
          ? resolvedInputCodecMessageId
          : resolvedParent;

      // Pin run.view to this run's branch now the trigger is resolved — the same
      // anchor / run-id / regenerate-target the conversation getters use.
      leafSource.setPin(assistantParentFallback, runId, resolvedRegenerates);

      // The `input-codec-message-id → run` linkage now exists: index it so live
      // cancels keyed by the input route to this run. start() additionally pulls
      // any cancel that arrived before the linkage existed.
      if (resolvedInputCodecMessageId !== undefined) {
        runIdByInputCodecMessageId.set(resolvedInputCodecMessageId, runId);
      }
    };

    // Watch for the triggering input event, armed at createRun (not in start())
    // so `run.located` resolves — and run.view pins — the moment the trigger
    // folds in, whether by a live arrival or a caller `run.view.loadOlder()`
    // page on a cold start. An empty inputEventId means there is nothing to
    // locate (e.g. an in-process run with no channel trigger), so `located`
    // resolves immediately. The watcher has no deadline: it rejects only when
    // the run signal aborts (cancel) or `close()` rejects it (SessionClosed).
    // The settlers are captured onto the registration inside the executor (which
    // runs synchronously), mirroring the client's `_pendingRunStarts` latch.
    const located = new Promise<void>((resolve, reject) => {
      registration.resolveLocated = resolve;
      registration.rejectLocated = reject;
    });
    // Whether `located` has settled (resolved or rejected). The adopt path's
    // visibility-wait reads this synchronously to decide whether to keep paging:
    // the trigger is OLDER than the run's run-start, so the run-start can fold on
    // a newer page while the trigger still sits in an un-fetched older one — the
    // wait must page on until BOTH have surfaced, not stop at the run-start.
    let locatedSettled = false;
    // Suppress unhandled-rejection warnings for callers that never await
    // `run.located`; the caller still observes the rejection via `run.located`
    // or `start()` if it awaits either. The same handler records the settle.
    located.then(
      () => {
        locatedSettled = true;
      },
      () => {
        locatedSettled = true;
      },
    );

    if (inputEventId) {
      locateInputEvent({
        tree: getTree(),
        invocationId,
        runId,
        expectedEventId: inputEventId,
        signal,
        onMatched: (found) => {
          resolveTriggerMetadata(found.headers, found.clientId);
        },
        logger,
      })
        .then(() => {
          registration.resolveLocated?.();
        })
        .catch((error: unknown) => {
          registration.rejectLocated?.(
            error instanceof Ably.ErrorInfo
              ? error
              : new Ably.ErrorInfo(
                  `unable to locate input event; ${errorMessage(error)}`,
                  ErrorCode.InvalidArgument,
                  400,
                ),
          );
        });
    } else {
      registration.resolveLocated?.();
    }

    /**
     * Run a run-lifecycle publish (run-start / run-suspend / run-end) and wrap
     * any failure as a `RunLifecycleError`, logging at error and rethrowing.
     * Shared by start(), suspend(), and end() so the three publishes can't
     * drift on the error code, message shape, or cause preservation.
     * @param phase - The lifecycle wire phase, used in the error message.
     * @param method - The Run method name, used in the log prefix.
     * @param publish - The RunManager publish to run.
     */
    const publishLifecycle = async (
      phase: 'run-start' | 'run-suspend' | 'run-end',
      method: 'start' | 'suspend' | 'end',
      publish: () => Promise<void>,
    ): Promise<void> => {
      try {
        await publish();
      } catch (error) {
        const errInfo = new Ably.ErrorInfo(
          `unable to publish ${phase} for run ${runId}; ${errorMessage(error)}`,
          ErrorCode.RunLifecycleError,
          500,
          errorCause(error),
        );
        logger?.error(`Run.${method}(); failed to publish ${phase}`, { runId });
        throw errInfo;
      }
    };

    // The shared run read-model (runId, status, error, whole-turn messages).
    // `getInputAnchor` is the run's structural-parent anchor
    // (`assistantParentFallback`), resolved by the input-event watcher;
    // `getTree()` is read live so a continuity-loss swap is observed rather than
    // a stale Tree captured.
    const base = createBaseRun<TInput, TOutput, TProjection, TMessage>({
      getRunId: () => runId,
      getInputAnchor: () => assistantParentFallback,
      getTree,
      codec,
    });

    /**
     * Throw if the run is not open for publishing, and — for `step` — if it has
     * already ended. The {@link RunStepWriter} gates its publishes on this; the
     * run object owns the open/terminal policy so the writer need not know how a
     * run opens.
     * @param verb - The calling verb, selecting the error message.
     */
    const assertPublishable = (verb: 'pipe' | 'step'): void => {
      const action = verb === 'pipe' ? 'pipe stream' : 'run step';
      if (!open) {
        // Name the public method the developer calls — run.pipe() for a stream,
        // run.createStep() for a step (there is no run.step()).
        const method = verb === 'pipe' ? 'pipe' : 'createStep';
        throw new Ably.ErrorInfo(
          `unable to ${action}; load() or start() must be called before ${method}() (run ${runId})`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      if (verb === 'step' && ended) {
        throw new Ably.ErrorInfo(`unable to run step; run ${runId} has already ended`, ErrorCode.InvalidArgument, 400);
      }
      // Publish-time terminal re-check (TOCTOU / dual-writer backstop): the run
      // can go terminal between open and now (e.g. a concurrent cancel cleanup
      // arm publishing run-end). Reject rather than publish onto an ended run.
      if (isTerminalStatus(base.status)) {
        throw new Ably.ErrorInfo(
          `unable to ${action}; run ${runId} is already ${base.status} (read-only)`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
    };

    // The run's output write-path (pipe + explicit steps), extracted so the
    // session stays focused on the run lifecycle. The seams let it gate on the
    // open state and read the run's late-resolved anchors without knowing how
    // the run opens or resolves. The writer never ends the run — a cancelled
    // pipe closes only its own step bracket; the run terminal is the run
    // object's (run.end, or session.end for an open run at teardown).
    const stepWriter = createRunStepWriter<TInput, TOutput, TProjection, TMessage>({
      getRunId: () => runId,
      invocationId,
      codec,
      channel,
      runManager,
      getTree,
      runtime,
      signal,
      logger,
      requireConnected,
      assertPublishable,
      getAnchors: () => ({
        parentFallback: assistantParentFallback,
        forkOf: resolvedForkOf,
        regenerates: resolvedRegenerates,
        inputClientId: resolvedInputClientId,
        inputCodecMessageId: resolvedInputCodecMessageId,
      }),
    });

    const run: AgentRun<TOutput, TProjection, TMessage> = {
      // Shared read members delegate to `base` (live getters, not snapshots).
      get runId() {
        return base.runId;
      },
      get status() {
        return base.status;
      },
      get error() {
        return base.error;
      },
      get messages() {
        return base.messages;
      },
      get invocationId() {
        return invocationId;
      },
      get abortSignal() {
        return signal;
      },
      get view() {
        return view;
      },
      get located() {
        return located;
      },

      // The output write-path is the RunStepWriter's; the run object delegates.
      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
      pipe: stepWriter.pipe,

      createStep: stepWriter.createStep,

      suspend: async (): Promise<void> => {
        logger?.trace('Run.suspend();', { runId });

        await requireConnected('suspend');

        if (!open) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; load() or start() must be called before suspend() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // `ended` is set for either an end or a suspend on this Run instance; a
        // second terminal call is a no-op.
        if (ended) return;
        // A suspend mid-step would strand the open step (no ai-step-end before
        // the run pauses); require the caller to end it first. Unlike run.end,
        // suspend does NOT auto-close — a suspended run may resume and continue
        // the step, so silently ending it would be wrong.
        if (stepWriter.hasActiveStep()) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; end the active step before suspending (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // Publish-time terminal re-check (TOCTOU / dual-writer backstop): the run
        // went terminal since open (e.g. a concurrent cancel cleanup published
        // run-end). No-op rather than publish a suspend onto an ended run; still
        // settle this instance and clean up.
        if (isTerminalStatus(base.status)) {
          ended = true;
          deregisterRun();
          logger?.debug('Run.suspend(); run already terminal, skipping publish', { runId, status: base.status });
          return;
        }
        ended = true;

        try {
          await publishLifecycle('run-suspend', 'suspend', async () =>
            runManager.suspendRun(runId, invocationId, resolvedInputClientId, resolvedInputCodecMessageId),
          );
        } finally {
          deregisterRun();
        }

        logger?.debug('Run.suspend(); run suspended', { runId });
      },

      // Spec: AIT-ST7, AIT-ST7a, AIT-ST7b
      end: async (params: RunEndParams): Promise<void> => {
        const { reason } = params;
        const error = params.reason === 'error' ? params.error : undefined;
        logger?.trace('Run.end();', { runId, reason });

        await requireConnected('end');

        if (!open) {
          throw new Ably.ErrorInfo(
            `unable to end run; load() or start() must be called before end() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (ended) return;
        // Publish-time terminal re-check (TOCTOU / dual-writer backstop): the run
        // went terminal since open (e.g. a concurrent cancel cleanup published
        // run-end). No-op rather than publish a second terminal; still settle
        // this instance and clean up.
        if (isTerminalStatus(base.status)) {
          ended = true;
          deregisterRun();
          logger?.debug('Run.end(); run already terminal, skipping publish', { runId, status: base.status });
          return;
        }
        ended = true;

        // Auto-close any still-open step first, so its ai-step-end precedes this
        // ai-run-end on the wire and no observer is stranded on an unsettled
        // step (the handle has no lexical finally guaranteeing closure). The run
        // terminal maps to the step terminal: an errored run fails its step,
        // otherwise it completes. Best-effort — a step-close failure must not
        // block the run terminal.
        try {
          await stepWriter.closeActiveStep(stepEndReasonFor(reason));
        } catch {
          logger?.error('Run.end(); failed to auto-close active step', { runId });
        }

        try {
          await publishLifecycle('run-end', 'end', async () =>
            runManager.endRun(runId, reason, invocationId, resolvedInputClientId, resolvedInputCodecMessageId, error),
          );
        } finally {
          deregisterRun();
        }

        logger?.debug('Run.end(); run ended', { runId, reason });
      },
    };

    // The graceful-teardown hook session.end() drives: end this run `{cancelled}`
    // (which auto-closes its open step first) — but only while it is OPEN. An
    // unopened run (still INITIALIZED — created/adopted but never started/loaded)
    // has nothing on the wire to terminate and run.end would reject it, so the
    // hook no-ops; session.end's detach still aborts its controller.
    registration.endCancelled = async (): Promise<void> => {
      if (!open || ended) return;
      await run.end({ reason: 'cancelled' });
    };

    // -----------------------------------------------------------------------
    // The opening verb — factory-specific, attached to the common run.
    // -----------------------------------------------------------------------

    /**
     * Open a created run: wait for the trigger, publish the opening lifecycle
     * event (run-start, or run-resume for a continuation), and open for
     * publishing. Idempotent; a `located` rejection (cancel / session close)
     * throws having published nothing.
     */
    // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
    const start = async (): Promise<void> => {
      logger?.trace('Run.start();', { runId, inputEventId });

      await requireConnected('start');

      // Spec: AIT-ST4a — the cancelled-before-start check precedes the latch so
      // a retry of a run cancelled before start() re-throws rather than no-oping.
      if (signal.aborted) {
        throw new Ably.ErrorInfo(
          `unable to start run; run ${runId} was cancelled before start()`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      // Synchronous re-entrancy latch (no await between here and the located
      // wait below): a second overlapping start() returns without double-publishing.
      if (opening) return;
      opening = true;

      // Wait until the triggering input event folds into the Tree — a live
      // arrival, or a `run.view.loadOlder()` page the caller drove on a cold
      // start. The watcher armed at createRun resolves `located` then, having
      // already resolved this run's per-run metadata (parent, forkOf,
      // continuation flag, run-id) and pinned run.view in its onMatched hook;
      // an empty inputEventId resolved `located` immediately (nothing to
      // locate). There is no deadline — a caller wanting one races
      // `run.located` against its own timeout; `located` rejects only on
      // cancel or session close.
      try {
        await located;
      } catch (error) {
        // `located` rejects only on cancel or session close — both routine
        // run outcomes, so this is a debug-level event, not an error. The
        // rejection bubbles up to the developer's HTTP handler, which surfaces
        // the failure as a non-2xx response — the signal the client sees. No
        // channel publish: an `ai-run-end` without a preceding `ai-run-start`
        // would break the lifecycle invariant for other channel observers.
        deregisterRun();
        logger?.debug('Run.start(); located rejected before run-start', { runId, invocationId });
        throw error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo(`unable to start run; ${errorMessage(error)}`, ErrorCode.InvalidArgument, 400);
      }

      // Per-run metadata and the run.view pin were resolved by the watcher's
      // onMatched when the trigger folded (above). Now pull any cancel that
      // arrived before the `input-codec-message-id → run` linkage existed (a
      // fresh-send cancel published before the agent minted this run-id).
      // Honouring it here may abort the controller before run-start; that is
      // fine — the abort propagates through the same signal a normal cancel
      // would use.
      if (resolvedInputCodecMessageId !== undefined) {
        await pullDeferredCancel(registration, resolvedInputCodecMessageId);
      }

      await publishLifecycle('run-start', 'start', async () =>
        runManager.startRun(runId, resolvedClientId, controller, {
          // Stamp the reply run's STRUCTURAL parent (its input node, M_user) —
          // the same value the output path stamps — not the input message's own
          // parent. Makes `parent` structural on every message so the Tree's two
          // creation paths agree regardless of arrival order. Valid only now
          // that M_user is a separate input node (the two-node flip).
          parent: assistantParentFallback,
          forkOf: resolvedForkOf,
          regenerates: resolvedRegenerates,
          invocationId,
          inputClientId: resolvedInputClientId,
          inputCodecMessageId: resolvedInputCodecMessageId,
          continuation: resolvedContinuation,
        }),
      );

      // Open for publishing only after the opening event is on the wire.
      open = true;

      // Optimistically insert the fresh run's node into the session Tree so
      // reads that follow start() (run.view, Run.messages) see the
      // run immediately rather than depending on the channel echo of the
      // run-start just published. The echo (or a history fold) reconciles
      // through the Tree's run-start handling, promoting startSerial onto
      // this serial-less node. Continuations re-enter an existing run via
      // run-resume, which creates no structure — their node comes from
      // history hydration instead.
      if (!resolvedContinuation) {
        getTree().applyRunLifecycle({
          type: 'start',
          runId,
          clientId: resolvedClientId ?? '',
          serial: undefined,
          invocationId,
          ...(assistantParentFallback !== undefined && { parent: assistantParentFallback }),
          ...(resolvedForkOf !== undefined && { forkOf: resolvedForkOf }),
          ...(resolvedRegenerates !== undefined && { regenerates: resolvedRegenerates }),
        });
      }

      logger?.debug('Run.start(); run started', { runId, inputEventId });
    };

    /**
     * Visibility-wait for an adopted run to become adoptable: page channel
     * history until BOTH the run's `ai-run-start` has folded (so its
     * `startSerial` is confirmed) AND the trigger has folded (so `located`
     * settles — see below), bounded by `timeoutMs`. The opener's optimistic
     * run-node insert is LOCAL to its process, so a fresh adopting process's Tree
     * has neither until it hydrates them off the channel.
     *
     * Why wait for both, not just the run-start: the trigger (`ai-input`) is
     * OLDER than the run's `ai-run-start`, and the input-event watcher is passive
     * (it never pages history itself). Paging backward, the run-start folds on a
     * newer page while the trigger may still sit in an un-fetched older one — so
     * stopping at the run-start would leave `located` forever unresolved and the
     * subsequent `await located` in `load()` would hang (it has no deadline). The
     * predicate therefore also requires `locatedSettled`, driving the fold far
     * enough back to surface the trigger too. An empty `triggerEventId` settles
     * `located` immediately, so this collapses to just the run-start wait.
     *
     * The bound is wired INTO the single history fold via a composed
     * timeout-abort signal — NOT a `Promise.race` wrapper around `foldUntil`. A
     * race would leave the fold paging the channel and holding the single-flight
     * cursor after the timer fired, starving concurrent runs; composing the
     * timeout into the fold's own abort path releases the cursor promptly.
     *
     * On resolution the run-start is confirmed and the trigger located. Otherwise:
     * the run's own signal aborting (cancel) rejects with `InvalidArgument`; the
     * timeout firing, or the channel exhausting without the run-start, rejects
     * with `InputEventNotFound` (retryable — a workflow-ordering error: the
     * run-start has not arrived yet), carrying any history-fetch failure as the
     * cause.
     * @param waitRunId - The run-id whose run-start to wait for.
     * @param timeoutMs - Maximum wait before rejecting.
     */
    const waitForRunStart = async (waitRunId: string, timeoutMs: number): Promise<void> => {
      const startConfirmed = (): boolean => getTree().getRunNode(waitRunId)?.startSerial !== undefined;
      // Adoptable once the run-start has folded AND the trigger has surfaced
      // (`located` settled). Both must be paged in; see the function doc.
      const ready = (): boolean => startConfirmed() && locatedSettled;
      if (ready()) {
        logger?.debug('Run.load(); run-start and trigger already observed', { runId: waitRunId, invocationId });
        return;
      }

      // Compose a timeout-abort into the fold's signal so the bound lives INSIDE
      // the fold (it releases the shared cursor on fire) rather than racing it.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs);
      const boundedSignal = AbortSignal.any([signal, timeoutController.signal]);

      let fetchError: Ably.ErrorInfo | undefined;
      try {
        // Page until the run-start AND the trigger have folded (predicate), the
        // channel is exhausted, or `boundedSignal` aborts (cancel or timeout).
        // Each paged trigger fold reaches the watcher, which resolves `located`
        // and pins run.view.
        await getHydrator().foldUntil(ready, boundedSignal);
      } catch (error) {
        // A history-fetch failure: keep it to thread as the rejection cause if
        // the run-start never arrived (so a broken fetch is not masked behind
        // the not-found code).
        fetchError = error instanceof Ably.ErrorInfo ? error : errorCause(error);
      } finally {
        clearTimeout(timer);
      }

      // The run-start is the load-gate; `located` is awaited separately by
      // load() (and may legitimately still be settling on the microtask queue
      // when the run-start fold satisfies the predicate). Gate on the run-start
      // here so a confirmed run-start with a not-yet-flushed `located` is not
      // mistaken for a timeout.
      if (startConfirmed()) {
        logger?.debug('Run.load(); run-start observed', { runId: waitRunId, invocationId });
        return;
      }

      // The run's OWN signal aborted (a genuine cancel, not the timeout): a
      // cancelled load, not a workflow-ordering miss.
      if (signal.aborted) {
        throw new Ably.ErrorInfo(`unable to load run; run ${waitRunId} was cancelled`, ErrorCode.InvalidArgument, 400);
      }
      // The timeout fired, or the channel exhausted without the run-start: a
      // retryable workflow-ordering error.
      throw new Ably.ErrorInfo(
        `unable to load run; run-start for run ${waitRunId} not observed within ${String(timeoutMs)}ms`,
        ErrorCode.InputEventNotFound,
        504,
        fetchError,
      );
    };

    /**
     * Adopt an already-open run for publishing in this process WITHOUT
     * publishing an opening event. See {@link AdoptedRun.load} for the contract
     * and side effects. Waits for the run's start to hydrate, awaits the trigger
     * (`located`), status-gates, seeds the owner, and opens without publishing.
     * Idempotent.
     * @param options - Adopt options ({@link AdoptedRun.load}).
     * @param options.timeoutMs - Visibility-wait bound for the run-start; default 30000.
     */
    const load = async (options?: { timeoutMs?: number }): Promise<void> => {
      logger?.trace('Run.load();', { runId, inputEventId });

      await requireConnected('load');

      // The cancelled-before-load check precedes the latch so a retry of a run
      // cancelled before load() re-throws rather than no-oping.
      if (signal.aborted) {
        throw new Ably.ErrorInfo(
          `unable to load run; run ${runId} was cancelled before load()`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      // Synchronous re-entrancy latch (no await between here and the wait below):
      // a second overlapping load() returns without a double owner-seed or a
      // double visibility-wait.
      if (opening) return;
      opening = true;

      const timeoutMs = options?.timeoutMs ?? 30000;

      // (1) Visibility-wait: drive the hydrator until the run's `ai-run-start` is
      // hydrated (so its `startSerial` is confirmed) AND the trigger has folded
      // (so `located` resolves). The opener's optimistic run-node insert is LOCAL
      // to its own process, so a fresh process's Tree is empty until it hydrates
      // them off the channel; this closes that race and pages far enough back to
      // surface the trigger (which is older than the run-start). On timeout /
      // abort, deregister before re-throwing — symmetric with the status-gate
      // rejections below.
      try {
        await waitForRunStart(runId, timeoutMs);
      } catch (error) {
        deregisterRun();
        throw error;
      }

      // (2) Await the trigger so the watcher's onMatched has resolved this run's
      // anchors (parent, forkOf, input-client-id) and pinned run.view. The
      // visibility-wait above already paged until the trigger folded (or an empty
      // triggerEventId resolved `located` immediately), so this normally resolves
      // at once; awaiting it surfaces a `located` rejection (cancel / session
      // close), which deregisters and re-throws.
      try {
        await located;
      } catch (error) {
        deregisterRun();
        logger?.debug('Run.load(); located rejected before adopt', { runId, invocationId });
        throw error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo(`unable to load run; ${errorMessage(error)}`, ErrorCode.InvalidArgument, 400);
      }

      // (3) Status-gate the adopt, now `startSerial` is confirmed (so `base.status`
      // reads the hydrated state, not the unhydrated `'active'` default). A
      // suspended or terminal run must not be adopted: suspended needs a resume (a
      // publishing re-entry), terminal is read-only. Only an active run is adoptable.
      const status = base.status;
      if (status === 'suspended') {
        deregisterRun();
        throw new Ably.ErrorInfo(
          `unable to load run; run ${runId} is suspended, resume via createRun().start()`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      if (isTerminalStatus(status)) {
        deregisterRun();
        throw new Ably.ErrorInfo(
          `unable to load run; run ${runId} is terminal (read-only)`,
          ErrorCode.InvalidArgument,
          400,
        );
      }

      // (4) Seed the owner into the run manager from the run-start's
      // `run-client-id` (the trigger event's may be empty — read the RunNode).
      // This feeds BOTH the per-output `run-client-id` and the terminal stamp.
      // (5) Open for publishing — WITHOUT publishing an opening event.
      const ownerClientId = getTree().getRunNode(runId)?.clientId;
      runManager.registerRun(runId, ownerClientId, controller);
      open = true;

      logger?.debug('Run.load(); run adopted', { runId, inputEventId });
    };

    // Attach the opening verb by mutation (Object.assign), NOT a spread: `run`'s
    // members are live getters (status / messages / view delegate to `base`), and
    // spreading would snapshot them to their construction-time (empty) values.
    if (strategy.open === 'adopt') {
      const adoptedRun: AdoptedRun<TOutput, TProjection, TMessage> = Object.assign(run, { load });
      return adoptedRun;
    }
    const openableRun: OpenableRun<TOutput, TProjection, TMessage> = Object.assign(run, { start });
    return openableRun;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent (server-side) session bound to the given Realtime client
 * and channel name. The caller owns the client's lifecycle; the session
 * owns its channel.
 * @param options - Session configuration.
 * @returns A new {@link AgentSession} instance.
 */
export const createAgentSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>,
): AgentSession<TOutput, TProjection, TMessage> => new DefaultAgentSession(options);
