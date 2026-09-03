/**
 * The agent transport: open runs, publish output, and observe the channel —
 * cancel signals route onto the matching run handle's `abortSignal`.
 *
 * {@link DefaultAgentTransport} owns everything outside a single run: run
 * identity, the cancel-routing registries, the opening publish, and its own
 * receive path — it mints a codec decoder, wraps it in a receive transport,
 * and, once {@link AgentTransport.connect} subscribes and attaches, merges
 * every inbound wire message through it (`deliverEvent`, then
 * `deliverAblyMessage`), so a consumer subscribes to the transport directly.
 * Each run's own write path — the publish gate, the step/pipe machinery and
 * the two terminals — belongs to {@link DefaultAgentRunTransport}.
 * The same listener dispatches `ai-cancel` envelopes onto the registered run
 * (consulting the run's `onCancel` hook, and buffering a cancel that races
 * ahead of its run's `openRun`) and routes a steering message — a
 * client input under an open run's run-id — onto the run's steer tracker,
 * flipping the handle's `hasInput()` and firing its `onSteer` hint. The
 * steering message also surfaces as an ordinary event on the receive stream
 * for the agent to merge into its own context; a steer that lands before its
 * run's `openRun` is buffered and reconciled at registration. Everything
 * else the client publishes surfaces as ordinary events only.
 *
 * `locateInput` scans channel history on a throwaway decoder to find the input
 * event a durable invocation must resume from. `history` pages the channel
 * backwards on the live stream's decoder and returns each older slice as a
 * batch of classified events, so the agent can assemble prior conversation
 * context for an inference call.
 *
 * The transport holds no conversation state, so the sticky `step-client-id`
 * inheritance relies solely on the writer's in-process cursor, and the
 * optimistic step-lifecycle seed a run's output verbs produce is emitted on
 * the transport's own receive stream.
 */

import * as Ably from 'ably';

import { EVENT_CANCEL, HEADER_EVENT_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import type { WireCodec } from '../codec/types.js';
import { DefaultAgentRunTransport } from './agent-run-transport.js';
import { readCancelTarget } from './cancel-envelope.js';
import {
  closedError,
  ConnectGuard,
  continuityLostError,
  ContinuityWatcher,
  reportPage,
  requireOpen,
  subscribeAndAttach,
} from './channel-support.js';
import { DEFAULT_HISTORY_PAGE_SIZE, type HistoryPager } from './history-pager.js';
import { evictOldestIfFull } from './internal/bounded-map.js';
import { createReceivePlumbing } from './internal/receive-plumbing.js';
import { publishLifecycleEvent } from './lifecycle-publish.js';
import { loadHistoryPages } from './load-history-pages.js';
import type { ReceiveTransport } from './receive-transport.js';
import { createRunManager, type RunManager } from './run-manager.js';
import { RunSteerTracker } from './run-steer-tracker.js';
import type {
  AdoptRunOptions,
  AgentRunTransport,
  AgentTransport,
  CancelRequest,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
  TransportReceiver,
} from './types.js';
import { wireMetaFromMessage } from './wire-meta.js';

/**
 * Per-registry cap on the cancel-routing state. All three registries are bound
 * by it independently, each FIFO-evicting its own oldest entry beyond this: the
 * cancels buffered for runs not yet opened (see {@link AgentTransport.openRun}'s
 * deferred-cancel pull), the run-ids already opened, and the run-ids a cancel
 * was honoured for.
 */
const DEFERRED_CANCEL_LIMIT = 200;

/**
 * Maximum number of run-ids the pre-open steer buffers hold (steers and
 * responded stamps observed before their run's `openRun`). FIFO-evicts the
 * oldest run's buffer beyond this.
 */
const PRE_OPEN_STEER_LIMIT = 200;

/**
 * The resolved parameters `_createRun` builds a run handle from. The public
 * verbs (`openRun`, `adoptRun`) own all identity and located-input resolution
 * and hand the result here verbatim.
 */
interface CreateRunParams {
  /** The run's resolved id. */
  runId: string;
  /** The invocation's resolved id. */
  invocationId: string;
  /** The opening action: publish `ai-run-start`, publish `ai-run-resume`, or adopt without publishing. */
  open: 'start' | 'resume' | 'adopt';
  /** The triggering input's transport-message-id, when known. */
  inputTransportMessageId?: string;
  /** The triggering input's publisher, stamped on the opening event as `input-client-id`. */
  inputClientId?: string;
}

/**
 * A run registered for cancel routing, from the open verb until it ends. A
 * suspended run stays registered — a cancel addressed to it should still fire
 * its abort signal, since a later invocation may be about to continue it.
 */
interface RegisteredRun {
  /** The run's id. */
  runId: string;
  /** The run's abort controller; an accepted cancel aborts it. */
  controller: AbortController;
  /** The run's cancel authorization hook, from {@link OpenRunHooks.onCancel}. */
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  /** The run's error hook, from {@link OpenRunHooks.onError}; a cancel-hook failure delivers here instead of the transport's `error` stream. */
  onError?: (error: Ably.ErrorInfo) => void;
  /**
   * Called with a live steering message's transport-message-id — a client input
   * observed under this run's run-id. The run's closure tracks it (skipping
   * the trigger and already-answered steers) and fires its `onSteer` hint.
   */
  onSteerMessage: (transportMessageId: string) => void;
}

/**
 * Options for {@link createAgentTransport}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface AgentTransportOptions<TInput, TOutput> {
  /** The Ably channel to publish run/step lifecycle and output on, and to receive cancel and steering signals from. The transport subscribes its own listener on `connect()`; the channel itself stays caller-owned (never detached). */
  channel: Ably.RealtimeChannel;
  /** The wire tier of the codec: its encoder serializes output and its decoder classifies the live receive stream, {@link AgentTransport.locateInput}, and {@link AgentTransport.history}. */
  codec: WireCodec<TInput, TOutput>;
  /** The agent's Ably `clientId`, stamped as `run-client-id` on the run's lifecycle and output. The run manager stamps an empty string when omitted. */
  clientId?: string;
  /** Wire-message limit per channel-history page in {@link AgentTransport.locateInput} and {@link AgentTransport.history}. Defaults to 100. */
  historyPageSize?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
}

/** Default {@link AgentTransport}. See the file header for the composition. */
class DefaultAgentTransport<TInput, TOutput> implements AgentTransport<TInput, TOutput> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: WireCodec<TInput, TOutput>;
  private readonly _clientId: string | undefined;
  private readonly _historyPageSize: number;
  private readonly _logger: Logger;
  private readonly _runManager: RunManager;
  /** The one decoder shared by the live merge and the history scan, so a stream spanning the attach boundary is never double-decoded ({@link locateInput}'s throwaway scans stay separate). */
  private readonly _decoder: ReturnType<WireCodec<TInput, TOutput>['createDecoder']>;
  private readonly _receiver: ReceiveTransport<TInput, TOutput>;
  private readonly _connectGuard = new ConnectGuard();
  private _closed = false;

  /** Open runs by run-id — the cancel-routing registry. */
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /** Cancels whose target run is not registered yet (a cancel can race its run's `openRun`), for `openRun` to pull. FIFO-evicted at {@link DEFERRED_CANCEL_LIMIT}, alongside the other cancel-routing registries. */
  private readonly _deferredCancelsByRunId = new Map<string, Ably.InboundMessage>();
  /**
   * Run-ids this process has opened. A cancel naming an id in here arrives
   * after that run is already gone, so it is dropped rather than buffered for
   * a run that will never pull it: buffering it would abort the next
   * `adoptRun` of the same id — which is how a durable agent re-enters a run —
   * and no cancel was ever honoured against this one.
   *
   * An id whose opening publish failed is removed again, because that run
   * never ran and its retry still needs the cancel.
   *
   * A run that WAS cancelled is tracked separately in {@link _cancelledRunIds}
   * and behaves the opposite way. FIFO-evicted at
   * {@link DEFERRED_CANCEL_LIMIT}, alongside the other cancel-routing
   * registries.
   */
  private readonly _seenRunIds = new Set<string>();
  /**
   * Run-ids this process honoured a cancel for. A cancel is sticky: a run is
   * cancelled once and stays cancelled, so a later `openRun` or `adoptRun`
   * under the same id aborts as soon as it registers rather than carrying on
   * where the cancelled attempt stopped. Under durable execution that is the
   * whole point — a retry re-enters a run by its stable id, and a retry of a
   * run the user cancelled must not continue it.
   *
   * Only a cancel that was actually honoured lands here; one a run's
   * `onCancel` vetoed did not cancel the run and does not bind its successors.
   * FIFO-evicted at {@link DEFERRED_CANCEL_LIMIT}, alongside the other
   * cancel-routing registries.
   */
  private readonly _cancelledRunIds = new Map<string, Ably.InboundMessage>();
  /** Steering-message transport-message-ids observed before their run was opened, keyed by run-id. */
  private readonly _preOpenSteersByRunId = new Map<string, Set<string>>();

  /** The channel listener — one bound reference so `close()` can unsubscribe it. */
  private readonly _onMessage: (message: Ably.InboundMessage) => void;
  /** The channel-state watcher behind {@link _handleContinuityLost}; removed on `close()`. */
  private readonly _continuity: ContinuityWatcher;
  /** The lazily opened, single-flight history pager behind {@link history}. Decode failures surface on the receive stream's `error`, matching the live merge. */
  private readonly _historyPager: HistoryPager<TInput, TOutput>;
  /** The public `on`, forwarding to the receiver via the shared dispatch. */
  readonly on: TransportReceiver<TInput, TOutput>['on'];

  constructor(options: AgentTransportOptions<TInput, TOutput>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._historyPageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'AgentTransport',
    });
    this._runManager = createRunManager(this._channel, this._logger);
    const receive = createReceivePlumbing<TInput, TOutput>({
      channel: this._channel,
      codec: this._codec,
      pageSize: this._historyPageSize,
      logger: this._logger,
    });
    this._decoder = receive.decoder;
    this._receiver = receive.receiver;
    this.on = receive.on;
    this._historyPager = receive.historyPager;
    this._onMessage = (message) => {
      this._handleMessage(message);
    };
    this._continuity = new ContinuityWatcher(this._channel, (stateChange) => {
      this._handleContinuityLost(stateChange);
    });
  }

  /**
   * React to a channel state change that means messages may have been missed.
   *
   * An agent that keeps driving the model into a channel with a gap is worse
   * than one that stops: a cancel published during the gap never arrives, so
   * the run becomes uncancellable while it burns inference. Every registered
   * run is aborted and the loss goes out on the error stream.
   * @param stateChange - The continuity-breaking state change.
   */
  private _handleContinuityLost(stateChange: Ably.ChannelStateChange): void {
    this._logger.warn('AgentTransport._handleContinuityLost(); channel continuity lost, aborting registered runs', {
      current: stateChange.current,
      resumed: stateChange.resumed,
      runs: this._registeredRuns.size,
    });
    for (const registration of this._registeredRuns.values()) registration.controller.abort();
    this._receiver.emitError(continuityLostError(stateChange, 'deliver events'));
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._closed) {
      return Promise.reject(closedError('connect'));
    }
    this._logger.trace('AgentTransport.connect();');
    return this._connectGuard.connect(async () =>
      subscribeAndAttach(this._channel, this._onMessage, this._logger, 'AgentTransport', (error) => {
        this._receiver.emitError(error);
      }),
    );
  }

  subscribe(handler: (event: TransportEvent<TInput, TOutput>) => void): () => void {
    return this._receiver.on('event', handler);
  }

  close(): void {
    if (this._closed) return;
    this._logger.info('AgentTransport.close();');
    this._closed = true;
    this._continuity.dispose();
    this._channel.unsubscribe(this._onMessage);
  }

  openRun(opts?: OpenRunOptions, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput> {
    this._assertCanOpen('openRun');
    const inputMeta = opts?.input?.meta;
    // The opening event: with a located input, its run-id header decides — a
    // continuation re-enters the run the client stamped, a fresh send starts
    // one. Without an input there is nothing to continue from, so `runId` is a
    // pure pin and the run opens fresh rather than publishing a phantom resume
    // for a run that may not exist.
    const continuation = opts?.input === undefined ? false : inputMeta?.runId !== undefined;
    // Run-id precedence: the input's continuation id, else the caller's pin
    // (a durable agent's stable fresh-run id), else minted.
    const runId = inputMeta?.runId ?? opts?.runId ?? crypto.randomUUID();
    const invocationId = opts?.invocationId ?? crypto.randomUUID();
    this._logger.trace('AgentTransport.openRun();', { runId, invocationId, continuation });
    return this._createRun(
      {
        runId,
        invocationId,
        open: continuation ? 'resume' : 'start',
        inputTransportMessageId: opts?.inputTransportMessageId ?? inputMeta?.transportMessageId,
        // The triggering input's publisher, stamped on the opening event as
        // `input-client-id`. It is how a consumer tells which client's send a
        // run answers, so several clients on one channel can agree that only
        // the sender executes the run's client-side tools.
        inputClientId: inputMeta?.clientId,
      },
      hooks,
    );
  }

  adoptRun(runId: string, opts?: AdoptRunOptions, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput> {
    this._assertCanOpen('adoptRun');
    if (runId === '') {
      throw new Ably.ErrorInfo('unable to adopt run; runId must be non-empty', ErrorCode.InvalidArgument, 400);
    }
    const invocationId = opts?.invocationId ?? crypto.randomUUID();
    this._logger.trace('AgentTransport.adoptRun();', { runId, invocationId });
    return this._createRun({ runId, invocationId, open: 'adopt' }, hooks);
  }

  /**
   * The shared open-verb guards: a closed transport throws, and a run opened
   * without connect() could silently miss the cancel and steering signals
   * addressed to it, so the receive path is required first. Synchronous — the
   * open verbs return the handle without awaiting, and the open publish still
   * awaits the connect completing.
   * @param verb - The public method name, for the error message.
   */
  private _assertCanOpen(verb: 'openRun' | 'adoptRun'): void {
    if (this._closed) throw closedError(verb);
    if (!this._connectGuard.attempted) {
      throw new Ably.ErrorInfo(
        `unable to ${verb === 'adoptRun' ? 'adopt run' : 'open run'}; connect() must be called before ${verb}()`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }

  /**
   * Build a run handle from resolved parameters: register it for cancel and
   * steer routing, reconcile the signals that arrived before it existed, and
   * fire the opening publish (`'start'` / `'resume'`) or seed the run-manager
   * owner entry without publishing (`'adopt'`). All identity and located-input
   * resolution belongs to the public verbs; this method consumes the resolved
   * values verbatim, and the handle it returns owns the run's write path.
   * @param params - The resolved run identity, open mode and input anchors.
   * @param hooks - The caller's per-run callbacks and external AbortSignal.
   * @returns The run's write handle.
   */
  private _createRun(params: CreateRunParams, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput> {
    const { runId, invocationId, inputTransportMessageId } = params;
    // The run's cancel controller: an accepted cancel aborts it, ending
    // in-flight pipes `'cancelled'` and firing the handle's `abortSignal`.
    const controller = new AbortController();
    // The handle's abort signal combines the caller's external signal, so
    // either an accepted cancel or the caller's own abort ends the run's pipes.
    const signal = hooks?.signal ? AbortSignal.any([controller.signal, hooks.signal]) : controller.signal;
    // The tracker owns the trigger-id skip, the redelivery dedup, hasInput()'s
    // drain contract, the per-attempt stamp delta, and the cumulative
    // considered-id receipt.
    const steerTracker = new RunSteerTracker(inputTransportMessageId);

    /**
     * Fire the run's `onSteer` hint, isolating a throwing handler onto the
     * transport's `error` stream so a bad handler can't kill steer tracking.
     */
    const notifySteer = (): void => {
      const onSteer = hooks?.onSteer;
      if (!onSteer) return;
      try {
        onSteer();
      } catch (error) {
        const errInfo = new Ably.ErrorInfo(
          `unable to notify steer for run ${runId}; onSteer handler threw: ${errorMessage(error)}`,
          ErrorCode.RunSteerHandlerFailed,
          500,
          errorCause(error),
        );
        this._logger.error('AgentTransport.notifySteer(); onSteer threw', { runId, error: errorMessage(error) });
        this._receiver.emitError(errInfo);
      }
    };

    const registration: RegisteredRun = {
      runId,
      controller,
      onCancel: hooks?.onCancel,
      onError: hooks?.onError,
      onSteerMessage: (transportMessageId) => {
        if (steerTracker.addPending(transportMessageId)) notifySteer();
      },
    };
    this._register(registration);

    /**
     * Remove this run from the routing maps: the registry, the pre-open steer
     * buffer, and any stale deferred cancel. Called when the run ends or its
     * open publish fails. A suspended run stays registered (see
     * {@link RegisteredRun}).
     */
    const deregister = (): void => {
      this._registeredRuns.delete(runId);
      this._preOpenSteersByRunId.delete(runId);
      this._deferredCancelsByRunId.delete(runId);
    };

    this._seedPreOpenSteers(runId, steerTracker, notifySteer);
    this._honourCancelAtOpen(registration);

    const openPromise = this._publishOpen(params);
    this._handleFailedOpen(openPromise, runId, deregister, hooks?.onError);

    return new DefaultAgentRunTransport<TInput, TOutput>({
      runId,
      invocationId,
      inputTransportMessageId,
      inputClientId: params.inputClientId,
      clientId: this._clientId,
      channel: this._channel,
      codec: this._codec,
      runManager: this._runManager,
      opened: openPromise,
      signal,
      steerTracker,
      hooks: hooks ?? {},
      // Emit the writer's optimistic step-start / step-end seed on the
      // transport's own receive stream, so a subscriber sees the bracket
      // before the wire echo and reconciles it by `stepStartSerial`.
      emitStepLifecycle: (event) => {
        this._receiver.emitEvent({ kind: 'step-lifecycle', event });
      },
      deregister,
      logger: this._logger,
    });
  }

  /**
   * Add a run to the cancel-routing registry and remember its id.
   * @param registration - The run's registry entry.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the run-id is already open.
   */
  private _register(registration: RegisteredRun): void {
    const { runId } = registration;
    if (this._registeredRuns.has(runId)) {
      // One registry entry per run-id: a second handle would overwrite the
      // first, orphaning its abort controller so a cancel reaches only the
      // newer run, and the first `end()` would deregister both.
      throw new Ably.ErrorInfo(
        `unable to open run; run ${runId} is already open on this transport`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    this._registeredRuns.set(runId, registration);
    // Remember the id, bounded by the same limit as the deferred-cancel
    // buffer, so a cancel arriving after this run ends is dropped rather than
    // held for the next adoption of the same id.
    evictOldestIfFull(this._seenRunIds, runId, DEFERRED_CANCEL_LIMIT);
    this._seenRunIds.add(runId);
  }

  /**
   * Pull the steers that landed before this run was registered (between
   * `connect()` and here, after the attach point) into its tracker. One
   * `onSteer` hint covers the batch.
   * @param runId - The run's id.
   * @param steerTracker - The run's steer tracker, to seed.
   * @param notifySteer - The run's isolated `onSteer` hint.
   */
  private _seedPreOpenSteers(runId: string, steerTracker: RunSteerTracker, notifySteer: () => void): void {
    const bufferedSteers = this._preOpenSteersByRunId.get(runId);
    if (!bufferedSteers) return;
    this._preOpenSteersByRunId.delete(runId);
    let seededAny = false;
    for (const id of bufferedSteers) {
      if (steerTracker.addPending(id)) seededAny = true;
    }
    if (!seededAny) return;
    this._logger.debug('AgentTransport._seedPreOpenSteers(); seeded pre-open steers', { runId });
    notifySteer();
  }

  /**
   * Honour a cancel this run is already subject to: one that arrived before
   * its open verb registered the run-id, or one an earlier attempt of the same
   * run already honoured.
   * @param registration - The run's registry entry.
   */
  private _honourCancelAtOpen(registration: RegisteredRun): void {
    const { runId } = registration;
    const buffered = this._deferredCancelsByRunId.get(runId);
    const sticky = this._cancelledRunIds.get(runId);
    const pending = buffered ?? sticky;
    if (pending === undefined) return;
    this._deferredCancelsByRunId.delete(runId);
    this._logger.debug('AgentTransport._honourCancelAtOpen(); honouring cancel', {
      runId,
      source: buffered === undefined ? 'cancelled-run' : 'buffered',
    });
    // Fire-and-forget: the open verb returns the handle synchronously, so
    // there is nothing to await this on. With no onCancel hook the abort
    // happens before the first await; a hook error is surfaced inside
    // _cancelRegistration, and a dispatch failure lands on the error stream
    // through _reportCancelRoutingFailure.
    this._cancelRegistration(registration, pending).catch((error: unknown) => {
      this._reportCancelRoutingFailure(error, { runId });
    });
  }

  /**
   * Fire the opening publish without awaiting it — the open verb returns
   * synchronously. It waits for `connect()` to complete first, so
   * `ai-run-start` cannot beat the subscribe and open a window where a cancel
   * for this run would be missed.
   * @param params - The resolved run identity and open mode.
   * @returns A promise resolving once the run is open on the wire.
   */
  private async _publishOpen(params: CreateRunParams): Promise<void> {
    const { runId, invocationId, inputTransportMessageId } = params;
    await this._connectGuard.requireConnected('openRun');
    if (params.open === 'adopt') {
      // Attach-without-publishing: seed the run manager's owner entry so
      // output and terminals stamp the real run-client-id, but put nothing
      // on the wire — the caller publishes only what it means to publish.
      this._runManager.registerRun(runId, this._clientId);
      return;
    }
    await publishLifecycleEvent(
      {
        phase: params.open === 'resume' ? 'run-resume' : 'run-start',
        component: 'AgentTransport',
        method: 'openRun',
        runId,
        logger: this._logger,
      },
      async () =>
        this._runManager.startRun(runId, this._clientId, {
          invocationId,
          // The triggering input's publisher, so several clients on one
          // channel can agree that only the sender executes the run's
          // client-side tools.
          inputClientId: params.inputClientId,
          // Anchor the opening event to its trigger, so a client that
          // published the input resolves the run-id from the run-start's
          // input-transport-message-id header (PublishInputResult.runId).
          inputTransportMessageId,
          continuation: params.open === 'resume',
        }),
    );
  }

  /**
   * Pre-handle the opening publish's rejection so an opened-but-never-awaited
   * run cannot surface an unhandled rejection. This marks the promise handled
   * without consuming the failure: the handle's `opened` and the `pipe` /
   * `end` await sites all still reject with it. The failure also reaches the
   * run's `onError` hook, which is what a caller that awaits no output verb
   * (e.g. one waiting on the opening event's channel echo) can observe.
   * @param openPromise - The opening publish.
   * @param runId - The run's id.
   * @param deregister - Drops the run from the routing registries.
   * @param onError - The run's error hook, when the caller supplied one.
   */
  private _handleFailedOpen(
    openPromise: Promise<void>,
    runId: string,
    deregister: () => void,
    onError: ((error: Ably.ErrorInfo) => void) | undefined,
  ): void {
    openPromise.catch((error: unknown) => {
      this._logger.error('AgentTransport._handleFailedOpen(); open publish failed', {
        runId,
        error: errorMessage(error),
      });
      // A run whose open failed receives no signals, so drop its registration.
      deregister();
      // This run never reached the wire, so it is not "already ended" — a
      // retry under the same pinned id is expected, and a cancel arriving in
      // between must still buffer for it. Forgetting the id restores that.
      this._seenRunIds.delete(runId);
      if (!onError) return;
      // The open chain already reports a typed failure — publishLifecycleEvent
      // raises RunLifecycleEventPublishFailed, and the connect and argument
      // guards raise their own. Deliver it as it is: re-wrapping would bury
      // the code a caller switches on one `cause` deeper and report a less
      // specific one on top. Only a non-ErrorInfo throw needs a wrapper.
      const errInfo =
        error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo(
              `unable to open run ${runId}; ${errorMessage(error)}`,
              ErrorCode.InternalError,
              500,
              errorCause(error),
            );
      try {
        onError(errInfo);
      } catch (callbackError) {
        // The only record of this: the run's own error hook is what threw, so
        // there is nowhere else to route it.
        this._logger.error('AgentTransport._handleFailedOpen(); onError callback threw', {
          runId,
          error: errorMessage(callbackError),
        });
      }
    });
  }

  async history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> {
    this._logger.trace('AgentTransport.history();');
    await this._requireOpen('history');
    return this._historyPager.next(opts);
  }

  async locateInput(eventId: string, opts?: TransportHistoryOptions): Promise<LocatedInput<TInput> | undefined> {
    this._logger.trace('AgentTransport.locateInput();', { eventId });
    await this._requireOpen('locateInput');
    // A throwaway decoder so the history scan never perturbs the live receive
    // stream's dedup state, keeping the 1:1 decoder-per-stream invariant.
    const scanDecoder = this._codec.createDecoder();
    // The scan cursor is per-call and thrown away, so binding the caller's
    // signal to it is safe: it aborts the eager first fetch and the retry
    // backoffs, and the loop below turns the abort into a rejection.
    const cursor = await loadHistoryPages(this._channel, {
      pageLimit: this._historyPageSize,
      signal: opts?.signal,
      logger: this._logger,
    });
    let scanned = 0;
    // The abort check precedes `hasNext()`: a bound signal makes the cursor
    // report no further pages, so reading it first would end the scan quietly
    // and return `undefined` where the caller is owed a rejection.
    for (;;) {
      if (opts?.signal?.aborted) {
        throw new Ably.ErrorInfo('unable to locate input; signal aborted', ErrorCode.OperationCancelled, 400);
      }
      if (!cursor.hasNext()) break;
      if (opts?.limit !== undefined && scanned >= opts.limit) break;
      const page = await cursor.next();
      reportPage(opts?.onPage, 'locateInput', this._logger);
      if (!page) break;
      scanned += page.length;
      for (const msg of page) {
        if (getTransportHeaders(msg)[HEADER_EVENT_ID] === eventId) {
          const { inputs } = scanDecoder.decode(msg);
          this._logger.debug('AgentTransport.locateInput(); input located', { eventId, serial: msg.serial });
          return { meta: wireMetaFromMessage(msg), inputs };
        }
      }
    }
    this._logger.debug('AgentTransport.locateInput(); no matching input in history', { eventId });
    return undefined;
  }

  /**
   * The channel listener body: merge the wire through the receiver, route
   * steering messages, and dispatch cancel envelopes.
   * @param message - The inbound wire message.
   */
  private _handleMessage(message: Ably.InboundMessage): void {
    if (this._closed) return;
    // A failed decode drops the message (the receiver emitted `error`); its
    // raw `ably-message` is not emitted, and cancel dispatch does not run for
    // a message the merge never took.
    const delivery = this._receiver.deliverEvent(message);
    if (delivery.outcome === 'failed') return;
    if (delivery.outcome === 'classified') this._observeRunSteer(delivery.event);
    this._receiver.deliverAblyMessage(message);
    if (message.name === EVENT_CANCEL) {
      // Fire-and-forget async dispatch — onCancel errors are surfaced inside
      // _cancelRegistration; this backstop catches anything else.
      this._handleCancelMessage(message).catch((error: unknown) => {
        this._reportCancelRoutingFailure(error, { serial: message.serial });
      });
    }
  }

  /**
   * Report a cancel dispatch that could not complete — the cancel was neither
   * honoured nor rejected, so its run keeps running.
   *
   * Distinct from {@link ErrorCode.RunCancelHandlerFailed}, which says a run's
   * `onCancel` threw and the SDK never reached the abort. This one says the
   * dispatch itself failed, so the SDK does not know whether the hook ran. An
   * application that retries or escalates needs to tell those apart.
   * @param error - The failure that escaped the dispatch.
   * @param logContext - Structured context identifying the cancel.
   */
  private _reportCancelRoutingFailure(error: unknown, logContext: Record<string, string | undefined>): void {
    const errInfo = new Ably.ErrorInfo(
      `unable to route cancel message; ${errorMessage(error)}`,
      ErrorCode.RunCancelRoutingFailed,
      500,
      errorCause(error),
    );
    this._logger.error('AgentTransport._reportCancelRoutingFailure(); cancel routing error', {
      ...logContext,
      error: errorMessage(error),
    });
    this._receiver.emitError(errInfo);
  }

  /**
   * Route a classified `message` event into steer tracking. A client input
   * under a registered run's run-id goes onto that run's closure (which skips
   * the trigger and already-tracked steers); with no registered run yet, the
   * steer id buffers per run-id for `openRun` to pull — a steer can land
   * between `connect()` and a continuation's `openRun`, after the attach
   * point where `history()` no longer sees it.
   * @param event - The classified event the receive merge produced.
   */
  private _observeRunSteer(event: TransportEvent<TInput, TOutput>): void {
    if (event.kind !== 'message') return;
    const { meta } = event;
    const eventRunId = meta.runId;
    if (eventRunId === undefined) return;
    if (event.inputs.length === 0 || meta.transportMessageId === undefined) return;

    const reg = this._registeredRuns.get(eventRunId);
    if (reg) {
      reg.onSteerMessage(meta.transportMessageId);
      return;
    }
    this._bufferPreOpenSteerId(eventRunId, meta.transportMessageId);
  }

  /**
   * Union a steer's transport-message-id into the bounded pre-open buffer,
   * FIFO-evicting the oldest run's buffer at {@link PRE_OPEN_STEER_LIMIT}.
   * @param runId - The run the steer belongs to.
   * @param transportMessageId - The steer's transport-message-id.
   */
  private _bufferPreOpenSteerId(runId: string, transportMessageId: string): void {
    const evicted = evictOldestIfFull(this._preOpenSteersByRunId, runId, PRE_OPEN_STEER_LIMIT);
    if (evicted !== undefined) {
      this._logger.warn('AgentTransport._bufferPreOpenSteerId(); pre-open steer buffer full, dropping oldest run', {
        evictedRunId: evicted,
        limit: PRE_OPEN_STEER_LIMIT,
      });
    }
    const set = this._preOpenSteersByRunId.get(runId);
    if (set) set.add(transportMessageId);
    else this._preOpenSteersByRunId.set(runId, new Set([transportMessageId]));
  }

  /**
   * Fire a cancel against a registered run: consult its `onCancel`
   * authorization hook (if any), then abort the run's controller. Shared by
   * the live dispatch and the deferred-cancel pull so both honour `onCancel`
   * and surface handler errors identically.
   * @param reg - The target run registration.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private async _cancelRegistration(reg: RegisteredRun, msg: Ably.InboundMessage): Promise<void> {
    const { runId } = reg;
    this._logger.debug('AgentTransport._cancelRegistration(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          this._logger.debug('AgentTransport._cancelRegistration(); cancel rejected by onCancel', { runId });
          return;
        }
      }
      reg.controller.abort();
      // Sticky from here: a later re-entry of this run id aborts on sight.
      evictOldestIfFull(this._cancelledRunIds, runId, DEFERRED_CANCEL_LIMIT);
      this._cancelledRunIds.set(runId, msg);
      this._logger.debug('AgentTransport._cancelRegistration(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${errorMessage(error)}`,
        ErrorCode.RunCancelHandlerFailed,
        500,
        errorCause(error),
      );
      this._logger.error('AgentTransport._cancelRegistration(); onCancel threw', {
        runId,
        error: errorMessage(error),
      });
      // Route to the run's onError when it supplied one, otherwise the
      // transport's error stream — one delivery path, never both. A throwing
      // onError means the dispatch could not complete: report that on the
      // error stream rather than only logging it, so an application still
      // learns the cancel was neither honoured nor rejected. Contained here,
      // so one bad handler cannot kill routing for other runs.
      if (reg.onError) {
        try {
          reg.onError(errInfo);
        } catch (reportError) {
          this._reportCancelRoutingFailure(reportError, { runId });
        }
      } else {
        this._receiver.emitError(errInfo);
      }
    }
  }

  /**
   * Hold a cancel whose target run is not registered yet, so the `openRun`
   * that establishes it can pull and honour it. FIFO-evicts the oldest entry
   * at {@link DEFERRED_CANCEL_LIMIT}; a later cancel for the same run replaces
   * the earlier one — the intent is identical.
   * @param runId - The run the cancel addresses.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private _bufferDeferredCancel(runId: string, msg: Ably.InboundMessage): void {
    const evicted = evictOldestIfFull(this._deferredCancelsByRunId, runId, DEFERRED_CANCEL_LIMIT);
    if (evicted !== undefined) {
      this._logger.warn('AgentTransport._bufferDeferredCancel(); deferred-cancel buffer full, dropping oldest', {
        evictedRunId: evicted,
        limit: DEFERRED_CANCEL_LIMIT,
      });
    }
    this._deferredCancelsByRunId.set(runId, msg);
    this._logger.debug('AgentTransport._bufferDeferredCancel(); buffered early cancel', {
      runId,
      serial: msg.serial,
    });
  }

  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const { runId } = readCancelTarget(msg);

    // Malformed cancel: drop with warn. A cancel identifies its target by
    // `run-id` only — a client that has not yet learned the run-id awaits
    // PublishInputResult.runId before cancelling.
    if (!runId) {
      this._logger.warn('AgentTransport._handleCancelMessage(); missing run-id', {
        serial: msg.serial,
      });
      return;
    }

    const reg = this._registeredRuns.get(runId);
    if (!reg) {
      // The run isn't registered yet: a cancel can race its run's `openRun` —
      // the client learns the run-id from the ai-run-start echo, which can
      // land before the opening process registers the run (a durable
      // continuation), or a redelivered cancel can precede a re-entry.
      if (this._cancelledRunIds.has(runId)) {
        // Already cancelled here, and the record of that already binds any
        // re-entry. A repeat cancel has nothing left to do.
        this._logger.debug('AgentTransport._handleCancelMessage(); cancel for an already-cancelled run, dropping', {
          runId,
          serial: msg.serial,
        });
        return;
      }
      if (this._seenRunIds.has(runId)) {
        // The run ran here and ended for some other reason. Buffering now
        // would abort the next adoption of the same run-id instead of
        // cancelling anything.
        this._logger.debug('AgentTransport._handleCancelMessage(); cancel for an already-ended run, dropping', {
          runId,
          serial: msg.serial,
        });
        return;
      }
      this._bufferDeferredCancel(runId, msg);
      return;
    }

    await this._cancelRegistration(reg, msg);
  }

  /**
   * Guard a verb, binding this transport's closed flag and connect guard to
   * the shared guard so every verb reads the same at its call site.
   * @param method - The method name being guarded, for the error message.
   */
  private async _requireOpen(method: string): Promise<void> {
    await requireOpen(this._closed, this._connectGuard, method);
  }
}

/**
 * Create a standalone {@link AgentTransport} over a channel and codec.
 * Composes the run-manager lifecycle publisher and the run-step-writer output
 * path, so a developer can drive agent runs while merging the channel's
 * events into their own state. Construction is synchronous and passive;
 * {@link AgentTransport.connect} subscribes the transport's listener and
 * attaches the channel, after which live events flow, cancels route onto run
 * handles, and the run/history surface opens.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - See {@link AgentTransportOptions}.
 * @returns The agent transport.
 */
export const createAgentTransport = <TInput, TOutput>(
  options: AgentTransportOptions<TInput, TOutput>,
): AgentTransport<TInput, TOutput> => new DefaultAgentTransport(options);
