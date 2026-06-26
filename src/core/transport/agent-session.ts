/**
 * Core agent (server-side) session, parameterized by codec.
 *
 * Composes RunManager and pipeStream to handle the full server-side run
 * lifecycle. Cancel message routing is handled directly by the session's
 * single channel subscription — no separate cancel manager needed.
 *
 * The session exposes a single factory method — `createRun()` — which returns
 * an AgentRun with explicit lifecycle methods: start(), pipe(), suspend(),
 * and end() (suspend() and end() are both terminal).
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
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { registerAgent } from '../agent.js';
import { resolveChannelModes } from '../channel-options.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { createBaseRun } from './base-run.js';
import { readCancelTarget } from './cancel-envelope.js';
import { foldAndEmit, type WireApplier } from './decode-fold.js';
import { buildTransportHeaders } from './headers.js';
import { createHistoryHydrator, type HistoryHydrator } from './history-hydrator.js';
import { locateInputEvent } from './input-event-locator.js';
import { evictOldestIfFull } from './internal/bounded-map.js';
import { Invocation } from './invocation.js';
import { createLeafBranchSource } from './leaf-branch-source.js';
import { createMaterialisation } from './materialisation.js';
import { pipeStream } from './pipe-stream.js';
import type { RunManager } from './run-manager.js';
import { createRunManager } from './run-manager.js';
import {
  bestEffortDetach,
  continuityLostError,
  handleWireMessage,
  isContinuityLost,
  requireConnected,
  SessionState,
  subscribeAndAttach,
} from './session-support.js';
import type { DefaultTree } from './tree.js';
import type {
  AgentRun,
  AgentSession,
  AgentSessionOptions,
  CancelRequest,
  LoadConversationOptions,
  PipeOptions,
  RunEndParams,
  RunRuntime,
  StreamResult,
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
}

// ---------------------------------------------------------------------------
// Internal state machines
// ---------------------------------------------------------------------------

enum RunState {
  INITIALIZED = 'initialized',
  STARTED = 'started',
  ENDED = 'ended',
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
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
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
   * Drives both the pre-run-start input-event lookup ({@link locateInputEvent})
   * and the AgentView's ancestor hydration off ONE single-flight cursor.
   * Recreated alongside the Tree/applier on continuity loss so the fresh Tree
   * gets a fresh cursor and exhaustion state.
   */
  private _hydrator: HistoryHydrator;
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  private readonly _inputEventLookupTimeoutMs: number;

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
    this._onError = options.onError;
    this._runManager = createRunManager(this._channel, this._logger);
    this._inputEventLookupTimeoutMs = options.inputEventLookupTimeoutMs ?? 30000;
    const { tree, applier } = createMaterialisation(this._codec, this._logger);
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
      (error) => this._onError?.(error),
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
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): AgentRun<TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.createRun();', { inputEventId: invocation.inputEventId });
    return this._createRun(invocation, runtime ?? {});
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
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }
    this._registeredRuns.clear();
    this._runIdByInputCodecMessageId.clear();
    this._deferredCancels.clear();
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
      (reg.onError ?? this._onError)?.(errInfo);
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

    // Abort every active run's controller FIRST so in-flight
    // `loadConversation` / `locateInputEvent` calls observe the abort before
    // the Tree changes underneath them and reject (InvalidArgument from their
    // signal checks; the session-level onError carries ChannelContinuityLost).
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }

    // Then swap the Tree for a fresh empty instance — abandons the old
    // Tree's projections, indices, and ably-message listeners to GC. New
    // runs use the fresh Tree; lingering closures on the old Tree from
    // in-flight (now-aborted) lookups are bounded by the abort propagation.
    const { tree, applier } = createMaterialisation(this._codec, this._logger);
    this._tree = tree;
    this._applier = applier;
    // Rebuild the hydrator against the fresh Tree/applier — this resets its
    // cursor and exhaustion state. Each run's leaf source reads the Tree and
    // hydrator through live `getTree()`/`getHydrator()` accessors, so it observes
    // the swap without being recreated.
    this._hydrator = this._createHydrator();

    // Session-level notification: continuity loss is not scoped to any one
    // run. Per-run onError handlers are reserved for errors from that run's
    // own operations (publish failures, encoder errors).
    this._onError?.(continuityErr);
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
            this._onError?.(errInfo);
          });
        }
      },
      (error) => {
        this._logger?.error('DefaultAgentSession._handleChannelMessage(); subscription error');
        this._onError?.(error);
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

  private _createRun(invocation: Invocation, runtime: RunRuntime<TOutput>): AgentRun<TOutput, TProjection, TMessage> {
    // The run-id is not carried in the invocation body — the agent mints it.
    // Mint a provisional id now (or take the `runtime.runId` override for
    // tests / in-process drivers) — this IS the id for a fresh run. A
    // continuation overrides it in `Run.start()` with the existing run-id read
    // off the triggering input event's message headers (the run it re-enters).
    // Mirrors the invocationId mint below.
    let runId = runtime.runId ?? crypto.randomUUID();
    // Whether the run-id was supplied via the runtime override. Together with
    // `resolvedContinuation` (set in start() when the triggering input carries
    // a wire run-id) this decides whether the id is "adopted" — an adopted id
    // can name a run that already exists in channel history; a freshly-minted
    // UUID cannot, so hydration must not demand its node from history.
    const runIdOverridden = runtime.runId !== undefined;
    // The agent mints the invocation id — one per HTTP request that invokes
    // it. A per-run override (runtime.invocationId) supports deterministic ids
    // in tests and in-process drivers.
    const invocationId = runtime.invocationId ?? crypto.randomUUID();
    const inputEventLookupTimeoutMs = this._inputEventLookupTimeoutMs;
    const { onMessage, onCancelled, onCancel, onError: runOnError, signal: externalSignal } = runtime;

    const controller = new AbortController();
    let state = RunState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) cancels the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so `close()` aborts an in-flight
    // start() and a post-lookup cancel can fire the AbortSignal. Keyed by the
    // provisional run-id; a continuation re-keys to the real id in start()
    // once the triggering input reveals it.
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
    // instances. The per-run leaf source and run.view read through these.
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
    let lookupHeaders: Record<string, string> | undefined;

    // The run's leaf-pinned branch strategy. It projects no branch until
    // `Run.start()` resolves the trigger and calls `leafSource.setPin(...)` (so
    // run.view is empty until the run starts), and reads the live Tree / hydrator
    // above, observing a continuity-loss swap. It also backs `Run.messages` /
    // `Run.loadConversation` — the full, un-paginated reconstruction the agent
    // feeds the model.
    const viewLogger = logger ?? makeLogger({ logLevel: LogLevel.Silent });
    const leafSource = createLeafBranchSource<TInput, TOutput, TProjection, TMessage>({
      getTree,
      getHydrator,
      codec,
      logger: viewLogger,
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
     * The reply run's structural-parent fallback, computed once in
     * `Run.start()` once the input-event lookup resolves the triggering
     * input's codec-message-id, and consumed by every `Run.pipe()` publish.
     * A per-stream `streamOpts.parent` still overrides it. Storing it here
     * keeps it stable across pipes and decouples the assistant's structural
     * parent from the run-start message's own `parent`.
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
    // (`assistantParentFallback`), resolved in start(); `getTree()` is read live
    // so a continuity-loss swap is observed rather than a stale Tree captured.
    const base = createBaseRun<TInput, TOutput, TProjection, TMessage>({
      getRunId: () => runId,
      getInputAnchor: () => assistantParentFallback,
      getTree,
      codec,
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

      // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
      start: async (): Promise<void> => {
        logger?.trace('Run.start();', { runId, inputEventId });

        await requireConnected('start');

        // Spec: AIT-ST4a
        if (signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to start run; run ${runId} was cancelled before start()`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state !== RunState.INITIALIZED) return;
        state = RunState.STARTED;

        // Look up the triggering input event on the channel so the agent
        // can read the user's message and per-run metadata (parent, forkOf,
        // continuation flag) before publishing run-start. Skip when
        // inputEventLookupTimeoutMs === 0 (tests and in-process drivers) or
        // when no inputEventId is set (invocation requires no channel lookup).
        if (inputEventId && inputEventLookupTimeoutMs > 0) {
          try {
            const found = await locateInputEvent({
              tree: getTree(),
              hydrator: getHydrator(),
              invocationId,
              runId,
              expectedEventId: inputEventId,
              timeoutMs: inputEventLookupTimeoutMs,
              signal,
              logger,
            });
            if (found.headers !== undefined) lookupHeaders = found.headers;
            if (found.clientId !== undefined) resolvedInputClientId = found.clientId;
          } catch (error) {
            const errInfo =
              error instanceof Ably.ErrorInfo
                ? error
                : new Ably.ErrorInfo(
                    `unable to look up input event; ${errorMessage(error)}`,
                    ErrorCode.InputEventNotFound,
                    504,
                  );
            // The rejection bubbles up to the developer's HTTP handler,
            // which surfaces the failure as a non-2xx response — that is
            // the signal the client sees. No channel publish: an
            // `ai-run-end` without a preceding `ai-run-start` would break
            // the lifecycle invariant for other channel observers.
            deregisterRun();
            logger?.error('Run.start(); input-event lookup failed', { runId, invocationId });
            throw errInfo;
          }
        }

        // Resolve per-run metadata from the matched input event's
        // headers — they carry `clientId`, `parent`, and `forkOf`.
        // Continuations of a suspended run pick up the suspended assistant's
        // parent in the same headers (the continuation message parents off
        // the assistant). A `run-id` on the triggering input marks a
        // continuation (re-entry via `ai-run-resume`); a fresh input carries
        // none and opens the run with `ai-run-start`.
        const sourceHeaders = lookupHeaders;
        if (sourceHeaders) {
          resolvedClientId = sourceHeaders[HEADER_RUN_CLIENT_ID];
          resolvedParent = sourceHeaders[HEADER_PARENT];
          resolvedForkOf = sourceHeaders[HEADER_FORK_OF];
          resolvedRegenerates = sourceHeaders[HEADER_MSG_REGENERATE];
          resolvedInputCodecMessageId = sourceHeaders[HEADER_CODEC_MESSAGE_ID];

          // The triggering input's run-id (if any) IS this run's identity.
          // Present → a continuation re-entering that run: adopt the id,
          // overriding the provisional one minted at construction, and re-key
          // the registration so cancel routing / deregistration resolve to the
          // real run. Absent → a fresh run: the provisional id stands and the
          // run opens with run-start.
          const wireRunId = sourceHeaders[HEADER_RUN_ID];
          resolvedContinuation = wireRunId !== undefined;
          if (wireRunId !== undefined && wireRunId !== runId) {
            registeredRuns.delete(runId);
            runId = wireRunId;
            registration.runId = runId;
            registeredRuns.set(runId, registration);
          }
        }

        // Compute the reply run's structural-parent fallback: the triggering
        // user message's codec-message-id ONLY if that codec-message-id is
        // backed by a real node in the Tree (i.e. the message decoded into at
        // least one input event); otherwise — for regenerate carriers that
        // are wire-only signals with no input events — fall back to the
        // input message's own `parent` header.
        assistantParentFallback =
          resolvedInputCodecMessageId !== undefined &&
          this._tree.getNodeByCodecMessageId(resolvedInputCodecMessageId) !== undefined
            ? resolvedInputCodecMessageId
            : resolvedParent;

        // Pin run.view to this run's branch now the trigger is resolved — the
        // same anchor / run-id / regenerate-target the conversation getters use.
        // Until this, run.view is empty.
        leafSource.setPin(assistantParentFallback, runId, resolvedRegenerates);

        // The triggering input's codec-message-id is now resolved, so the
        // `input-codec-message-id → run` linkage exists: index it for live
        // cancels and pull any cancel that arrived before the run was known
        // (a fresh-send cancel published before the agent minted this run-id).
        // Honouring it here may abort the controller before run-start; that is
        // fine — the abort propagates through the same signal a normal cancel
        // would use.
        if (resolvedInputCodecMessageId !== undefined) {
          runIdByInputCodecMessageId.set(resolvedInputCodecMessageId, runId);
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

        // Optimistically insert the fresh run's node into the session Tree so
        // reads that follow start() (loadConversation, Run.messages) see the
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
      },

      loadConversation: async (options?: LoadConversationOptions): Promise<TMessage[]> => {
        logger?.trace('Run.loadConversation();', { runId });
        await requireConnected('loadConversation');
        // No cache. Drives Tree hydration via the leaf source's conversation
        // walk and computes a fresh snapshot of the parent-chain messages at
        // return time. After this call, `Run.messages` continues to work
        // as a live Tree read.
        const { messages } = await leafSource.loadConversation(
          runId,
          assistantParentFallback,
          signal,
          options?.maxRuns,
          runIdOverridden || resolvedContinuation,
          resolvedRegenerates,
        );
        return messages;
      },

      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
      pipe: async (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>): Promise<StreamResult> => {
        logger?.trace('Run.pipe();', { runId });

        await requireConnected('pipe');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to pipe stream; start() must be called before pipe() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }

        const runOwnerClientId = runManager.getClientId(runId);

        // The assistant message's parent: an explicit per-stream
        // `streamOpts.parent` from the caller, else the reply run's
        // structural-parent fallback computed once at run-start
        // (`assistantParentFallback` — the triggering user message, or the
        // input message's own parent for regenerate messages that produced no
        // MessageNodes). Owning the default here means agent routes don't have
        // to pass `{ parent: lastUserCodecMessageId }` to keep tree threading
        // correct; edit-then-regenerate sibling resolution relies on the
        // user→assistant chain being explicit.
        const assistantParent = streamOpts?.parent ?? assistantParentFallback;
        const assistantForkOf = streamOpts?.forkOf ?? resolvedForkOf;
        // Echo `msg-regenerate` on the assistant message so that a
        // client receiving the assistant chunk before `ai-run-start`
        // (e.g. via history pagination across a page boundary, or a lost
        // lifecycle publish) can still populate `RunNode.regeneratesCodecMessageId`
        // when creating the Run from headers. Mirrors the symmetric
        // behaviour for `assistantForkOf` on edit runs.
        const assistantRegenerates = resolvedRegenerates;

        const codecMessageId = crypto.randomUUID();
        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          runId,
          codecMessageId,
          runClientId: runOwnerClientId,
          parent: assistantParent,
          forkOf: assistantForkOf,
          invocationId,
          inputClientId: resolvedInputClientId,
          inputCodecMessageId: resolvedInputCodecMessageId,
          regenerates: assistantRegenerates,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: codecMessageId,
        });

        const result = await pipeStream(stream, encoder, signal, onCancelled, streamOpts?.resolveWriteOptions, logger);

        if (result.error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to pipe response for run ${runId}; ${result.error.message}`,
            ErrorCode.StreamError,
            500,
            errorCause(result.error),
          );
          logger?.error('Run.pipe(); stream error', { runId });
          runOnError?.(errInfo);
        }

        // Run cancellation is transport-tier: guarantee the run-end terminal so
        // every observer's stream closes even if the caller's handler omits
        // run.end(). Best-effort — pipe must still return the StreamResult; a
        // later run.end() is a no-op via the ENDED guard. The run is past
        // INITIALIZED here (pipe requires start()), so end()'s guards pass.
        if (result.reason === 'cancelled') {
          try {
            await run.end({ reason: 'cancelled' });
          } catch {
            logger?.error('Run.pipe(); run-end on cancel failed', { runId });
          }
        }

        logger?.debug('Run.pipe(); stream finished', { runId, reason: result.reason });
        return result;
      },

      suspend: async (): Promise<void> => {
        logger?.trace('Run.suspend();', { runId });

        await requireConnected('suspend');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; start() must be called before suspend() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // ENDED is the terminal state for either an end or a suspend on this
        // Run instance; a second terminal call is a no-op.
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

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

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to end run; start() must be called before end() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

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

    return run;
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
