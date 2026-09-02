/**
 * The agent transport: open runs, publish output, and observe the channel —
 * cancel signals route onto the matching run handle's `abortSignal`.
 *
 * {@link createAgentTransport} composes the existing agent write path — the
 * run-manager lifecycle publisher and the {@link createRunStepWriter} step/pipe
 * machinery — with its own receive path: it mints a codec decoder, wraps it in
 * a receive transport, and — once {@link AgentTransport.connect} subscribes and
 * attaches — folds every inbound wire message through it (`deliverEvent`, then
 * `deliverAblyMessage`), so a consumer subscribes to the transport directly.
 * The same listener dispatches `ai-cancel` envelopes onto the registered run
 * (consulting the run's `onCancel` hook, and buffering a fresh-send cancel
 * that races ahead of its `openRun`) and routes a steering message — a
 * client input under an open run's run-id — onto the run's steer tracker,
 * flipping the handle's `hasInput()` and firing its `onSteer` hint. The
 * steering message also surfaces as an ordinary event on the receive stream
 * for the agent to fold into its own context; a steer that lands before its
 * run's `openRun` is buffered and reconciled at registration. Everything
 * else the client publishes surfaces as ordinary events only.
 *
 * `locateInput` scans channel history on a throwaway decoder to find the input
 * event a durable invocation must resume from. `history` pages the channel
 * backwards on the live stream's decoder and returns each older slice as a
 * batch of classified events, so the agent can assemble prior conversation
 * context for an inference call.
 *
 * Sticky `step-client-id` inheritance is carried by the writer's in-process
 * cursor alone, because the transport keeps no conversation state to re-derive
 * it from. The optimistic step-lifecycle seed a run's output verbs produce is
 * emitted on the transport's own receive stream.
 */

import * as Ably from 'ably';

import { EVENT_CANCEL, HEADER_EVENT_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import type { WireCodec } from '../codec/types.js';
import { readCancelTarget } from './cancel-envelope.js';
import { ConnectGuard, reportPage, subscribeAndAttach } from './channel-support.js';
import { createHistoryPager } from './history-pager.js';
import { evictOldestIfFull } from './internal/bounded-map.js';
import { publishLifecycleEvent } from './lifecycle-publish.js';
import { loadHistoryPages } from './load-history-pages.js';
import { createReceiveTransport } from './receive-transport.js';
import { createRunManager } from './run-manager.js';
import { RunSteerTracker } from './run-steer-tracker.js';
import { createRunStepWriter, stepEndReasonFor } from './run-step-writer.js';
import type {
  AdoptRunOptions,
  AgentRunTransport,
  AgentTransport,
  CancelRequest,
  LocatedInput,
  OpenRunHooks,
  OpenRunOptions,
  PipeSource,
  RunEndParams,
  RunStepTransport,
  StepEndParams,
  StepOptions,
  StreamResult,
  TransportEvent,
  TransportHistoryOptions,
  TransportHistoryResult,
} from './types.js';
import { wireMetaFromMessage } from './wire-meta.js';

/** Default wire-message limit per channel-history page for {@link AgentTransport.locateInput} and {@link AgentTransport.history}. */
const DEFAULT_HISTORY_PAGE_SIZE = 100;

/**
 * Maximum number of cancels buffered for runs not yet opened (see
 * {@link AgentTransport.openRun}'s deferred-cancel pull). FIFO-evicts the
 * oldest beyond this.
 */
const DEFERRED_CANCEL_LIMIT = 200;

/**
 * Maximum number of run-ids the pre-open steer buffers hold (steers and
 * responded stamps observed before their run's `openRun`). FIFO-evicts the
 * oldest run's buffer beyond this.
 */
const PRE_OPEN_STEER_LIMIT = 200;

/**
 * The resolved parameters `createRun` builds a run handle from. The public
 * verbs (`openRun`, `adoptRun`) own all identity and input resolution and
 * hand the result here verbatim.
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
  /** The triggering input's publisher clientId, when known. */
  inputClientId?: string;
}

/**
 * A run registered for cancel routing, from `openRun` until it ends. A
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
  /** The triggering input's transport-message-id, from {@link OpenRunOptions.inputTransportMessageId}. */
  inputTransportMessageId?: string;
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
  /** The codec: its encoder serializes output and its decoder classifies the live receive stream, {@link AgentTransport.locateInput}, and {@link AgentTransport.history}. */
  codec: WireCodec<TInput, TOutput>;
  /** The agent's Ably `clientId`, stamped as `run-client-id` on the run's lifecycle and output. The run manager stamps an empty string when omitted. */
  clientId?: string;
  /** Wire-message limit per channel-history page in {@link AgentTransport.locateInput} and {@link AgentTransport.history}. Defaults to 100. */
  historyPageSize?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
}

/**
 * Create an {@link AgentTransport} over a channel and codec, composing the
 * run-manager lifecycle publisher with the run-step-writer output path. A
 * developer drives agent runs and folds the events into state of their own.
 * Construction is synchronous and passive;
 * {@link AgentTransport.connect} subscribes the transport's listener and
 * attaches the channel, after which live events flow, cancels route onto run
 * handles, and the run/history surface opens.
 * @param options - See {@link AgentTransportOptions}.
 * @returns The agent transport.
 */
export const createAgentTransport = <TInput, TOutput>(
  options: AgentTransportOptions<TInput, TOutput>,
): AgentTransport<TInput, TOutput> => {
  const { channel, codec, clientId } = options;
  const historyPageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  const logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
    component: 'AgentTransport',
  });
  // Children get the resolved logger, not `options.logger`: context has to
  // accumulate, and an omitted logger must still resolve to the Silent default.
  const runManager = createRunManager(channel, logger);

  // The one decoder shared by the live fold and the history scan, so a stream
  // spanning the attach boundary is never double-decoded (locateInput's
  // throwaway scans stay separate).
  const decoder = codec.createDecoder();
  const receiver = createReceiveTransport<TInput, TOutput>(decoder, logger);
  const connectGuard = new ConnectGuard();
  let closed = false;

  // ---------------------------------------------------------------------------
  // Cancel routing
  // ---------------------------------------------------------------------------

  /** Open runs by run-id — the cancel-routing registry. */
  const registeredRuns = new Map<string, RegisteredRun>();
  /** Reverse index: triggering input transport-message-id → run-id, for fresh-send cancels keyed by input. */
  const runIdByInputTransportMessageId = new Map<string, string>();
  /** Cancels that arrived before their target run was opened, keyed by input transport-message-id. */
  const deferredCancels = new Map<string, Ably.InboundMessage>();
  /** Steering-message transport-message-ids observed before their run was opened, keyed by run-id. */
  const preOpenSteersByRunId = new Map<string, Set<string>>();

  /**
   * Union a steer's transport-message-id into the bounded pre-open buffer,
   * FIFO-evicting the oldest run's buffer at {@link PRE_OPEN_STEER_LIMIT}.
   * @param runId - The run the steer belongs to.
   * @param transportMessageId - The steer's transport-message-id.
   */
  const bufferPreOpenSteerId = (runId: string, transportMessageId: string): void => {
    const evicted = evictOldestIfFull(preOpenSteersByRunId, runId, PRE_OPEN_STEER_LIMIT);
    if (evicted !== undefined) {
      logger.warn('AgentTransport.bufferPreOpenSteerId(); pre-open steer buffer full, dropping oldest run', {
        evictedRunId: evicted,
        limit: PRE_OPEN_STEER_LIMIT,
      });
    }
    const set = preOpenSteersByRunId.get(runId);
    if (set) set.add(transportMessageId);
    else preOpenSteersByRunId.set(runId, new Set([transportMessageId]));
  };

  /**
   * Fire a cancel against a registered run: consult its `onCancel`
   * authorization hook (if any), then abort the run's controller. Shared by
   * the live dispatch and the deferred-cancel pull so both honour `onCancel`
   * and surface handler errors identically.
   * @param reg - The target run registration.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  const cancelRegistration = async (reg: RegisteredRun, msg: Ably.InboundMessage): Promise<void> => {
    const { runId } = reg;
    logger.debug('AgentTransport.cancelRegistration(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          logger.debug('AgentTransport.cancelRegistration(); cancel rejected by onCancel', { runId });
          return;
        }
      }
      reg.controller.abort();
      logger.debug('AgentTransport.cancelRegistration(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${errorMessage(error)}`,
        ErrorCode.RunCancelHandlerFailed,
        500,
        errorCause(error),
      );
      logger.error('AgentTransport.cancelRegistration(); onCancel threw', { runId, error: errorMessage(error) });
      // Route to the run's onError when it supplied one, otherwise the
      // transport's error stream — one delivery path, never both. A throwing
      // onError escapes to the caller's routing bracket, which reports it as
      // RunCancelRoutingFailed: the dispatch could not complete, so the cancel
      // was neither honoured nor rejected. Routing of later cancels survives
      // either way — each dispatch is bracketed independently.
      if (reg.onError) {
        reg.onError(errInfo);
      } else {
        receiver.emitError(errInfo);
      }
    }
  };

  /**
   * Report a cancel dispatch that could not complete — the cancel was neither
   * honoured nor rejected, so its run keeps running. Shared by the live
   * dispatch backstop and the deferred-cancel pull so both surface the same
   * RunCancelRoutingFailed on the transport's error stream.
   * @param error - The failure that escaped the dispatch.
   * @param logContext - Structured context identifying the cancel.
   */
  const reportCancelRoutingFailure = (error: unknown, logContext: Record<string, string | undefined>): void => {
    const errInfo = new Ably.ErrorInfo(
      `unable to route cancel message; ${errorMessage(error)}`,
      ErrorCode.RunCancelRoutingFailed,
      500,
      errorCause(error),
    );
    logger.error('AgentTransport.reportCancelRoutingFailure(); cancel routing error', {
      ...logContext,
      error: errorMessage(error),
    });
    receiver.emitError(errInfo);
  };

  /**
   * Buffer a cancel that arrived before its target run was opened, keyed by the
   * triggering input's transport-message-id. FIFO-evicts the oldest entry at
   * {@link DEFERRED_CANCEL_LIMIT}. A later cancel for the same input replaces
   * the earlier one — the intent is identical.
   * @param inputTransportMessageId - The triggering input's transport-message-id.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  const bufferDeferredCancel = (inputTransportMessageId: string, msg: Ably.InboundMessage): void => {
    const evicted = evictOldestIfFull(deferredCancels, inputTransportMessageId, DEFERRED_CANCEL_LIMIT);
    if (evicted !== undefined) {
      logger.warn('AgentTransport.bufferDeferredCancel(); deferred-cancel buffer full, dropping oldest', {
        evictedInputTransportMessageId: evicted,
        limit: DEFERRED_CANCEL_LIMIT,
      });
    }
    deferredCancels.set(inputTransportMessageId, msg);
    logger.debug('AgentTransport.bufferDeferredCancel(); buffered early cancel', {
      inputTransportMessageId,
      serial: msg.serial,
    });
  };

  const handleCancelMessage = async (msg: Ably.InboundMessage): Promise<void> => {
    const { runId, inputTransportMessageId } = readCancelTarget(msg);

    // Malformed cancel: drop with warn. A cancel must identify its target by
    // `run-id` (a continuation, whose run-id the client knows) and/or by
    // `input-transport-message-id` (a fresh send, before the agent minted the
    // run-id). Neither present means there is nothing to route to.
    if (!runId && !inputTransportMessageId) {
      logger.warn('AgentTransport.handleCancelMessage(); missing run-id and input-transport-message-id', {
        serial: msg.serial,
      });
      return;
    }

    // Primary path — match by run-id (continuations, whose run-id the client
    // already knows). Resolve the input-transport-message-id to a run-id when the
    // run-id wasn't supplied (a fresh-send cancel whose target run has already
    // opened with that input, so the linkage exists).
    const resolvedRunId =
      runId ?? (inputTransportMessageId ? runIdByInputTransportMessageId.get(inputTransportMessageId) : undefined);
    const reg = resolvedRunId ? registeredRuns.get(resolvedRunId) : undefined;

    if (!reg) {
      // The run isn't known yet. A fresh-send cancel can race ahead of the
      // `openRun` that establishes the input-transport-message-id → run linkage.
      // Buffer it by input-transport-message-id so `openRun` can pull and honour
      // it. A bare run-id cancel for an unknown run is a no-op (the run never
      // existed here, or already ended).
      if (inputTransportMessageId !== undefined) {
        bufferDeferredCancel(inputTransportMessageId, msg);
      }
      return;
    }

    await cancelRegistration(reg, msg);
  };

  // ---------------------------------------------------------------------------
  // Channel listener and lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Route a classified `message` event into steer tracking. A client input
   * under a registered run's run-id goes onto that run's closure (which skips
   * the trigger and already-tracked steers); with no registered run yet, the
   * steer id buffers per run-id for `openRun` to pull — a steer can land
   * between `connect()` and a continuation's `openRun`, after the attach
   * point where `history()` no longer sees it.
   * @param event - The classified event the receive fold produced.
   */
  const observeRunSteer = (event: TransportEvent<TInput, TOutput>): void => {
    if (event.kind !== 'message') return;
    const { meta } = event;
    const eventRunId = meta.runId;
    if (eventRunId === undefined) return;
    if (event.inputs.length === 0 || meta.transportMessageId === undefined) return;

    const reg = registeredRuns.get(eventRunId);
    if (reg) {
      reg.onSteerMessage(meta.transportMessageId);
      return;
    }
    bufferPreOpenSteerId(eventRunId, meta.transportMessageId);
  };

  const onMessage = (message: Ably.InboundMessage): void => {
    if (closed) return;
    // A failed decode drops the message (the receiver emitted `error`); its
    // raw `ably-message` is not emitted, and cancel dispatch does not run for
    // a message the fold never applied.
    const delivery = receiver.deliverEvent(message);
    if (delivery.outcome === 'failed') return;
    if (delivery.outcome === 'classified') observeRunSteer(delivery.event);
    receiver.deliverAblyMessage(message);
    if (message.name === EVENT_CANCEL) {
      // Fire-and-forget async dispatch — onCancel errors are surfaced inside
      // cancelRegistration; this backstop catches anything else (including a
      // run's onError throwing while reporting an onCancel failure).
      handleCancelMessage(message).catch((error: unknown) => {
        reportCancelRoutingFailure(error, { serial: message.serial });
      });
    }
  };

  /**
   * Build the terminal-state error every post-`close()` call rejects with.
   * @param method - The method name being guarded, for the error message.
   * @returns The error.
   */
  const closedError = (method: string): Ably.ErrorInfo =>
    new Ably.ErrorInfo(`unable to ${method}; transport is closed`, ErrorCode.SessionClosed, 400);

  /**
   * Guard a verb: reject once closed, and require a successful `connect()`
   * (the shared guard supplies the retry guidance on a failed one).
   * @param method - The method name being guarded, for the error message.
   */
  const requireOpen = async (method: string): Promise<void> => {
    if (closed) throw closedError(method);
    await connectGuard.requireConnected(method);
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  const connect = (): Promise<void> => {
    if (closed) {
      return Promise.reject(closedError('connect'));
    }
    logger.trace('AgentTransport.connect();');
    return connectGuard.connect(async () =>
      subscribeAndAttach(channel, onMessage, logger, 'AgentTransport', (error) => {
        receiver.emitError(error);
      }),
    );
  };

  const subscribe = (handler: (event: TransportEvent<TInput, TOutput>) => void): (() => void) =>
    receiver.on('event', handler);

  const on = (
    event: 'event' | 'ably-message' | 'error',
    handler:
      | ((e: TransportEvent<TInput, TOutput>) => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((err: Ably.ErrorInfo) => void),
  ): (() => void) => {
    switch (event) {
      case 'event': {
        // CAST: the public overloads pair each event name with its handler
        // type; TypeScript cannot correlate the union members in the
        // implementation signature.
        return receiver.on(event, handler as (e: TransportEvent<TInput, TOutput>) => void);
      }
      case 'ably-message': {
        // CAST: see the 'event' case.
        return receiver.on(event, handler as (msg: Ably.InboundMessage) => void);
      }
      case 'error': {
        // CAST: see the 'event' case.
        return receiver.on(event, handler as (err: Ably.ErrorInfo) => void);
      }
    }
  };

  const close = (): void => {
    if (closed) return;
    logger.info('AgentTransport.close();');
    closed = true;
    channel.unsubscribe(onMessage);
  };

  // ---------------------------------------------------------------------------
  // Run surface
  // ---------------------------------------------------------------------------

  /**
   * The shared open-verb guards: a closed transport throws, and a run opened
   * without connect() could silently miss the cancel and steering signals
   * addressed to it, so the receive path is required first. Synchronous — the
   * open verbs return the handle without awaiting, and the open publish still
   * awaits the connect completing.
   * @param verb - The public method name, for the error message.
   */
  const assertCanOpen = (verb: 'openRun' | 'adoptRun'): void => {
    if (closed) throw closedError(verb);
    if (!connectGuard.attempted) {
      throw new Ably.ErrorInfo(
        `unable to open run; connect() must be called before ${verb}()`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  };

  const openRun = (opts?: OpenRunOptions, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput> => {
    assertCanOpen('openRun');
    const inputMeta = opts?.input?.meta;
    // The opening event: with a located input, its run-id header decides — a
    // continuation re-enters the run the client stamped, a fresh send starts
    // one. Without one, a supplied runId is the continuation signal.
    const continuation = opts?.input === undefined ? opts?.runId !== undefined : inputMeta?.runId !== undefined;
    // Run-id precedence: the input's continuation id, else the caller's pin
    // (a durable agent's stable fresh-run id), else minted.
    const runId = inputMeta?.runId ?? opts?.runId ?? crypto.randomUUID();
    const invocationId = opts?.invocationId ?? crypto.randomUUID();
    logger.trace('AgentTransport.openRun();', { runId, invocationId, continuation });
    return createRun(
      {
        runId,
        invocationId,
        open: continuation ? 'resume' : 'start',
        inputTransportMessageId: opts?.inputTransportMessageId ?? inputMeta?.transportMessageId,
        // The input's publisher clientId, as Ably stamped it on the input's
        // wire message from the publisher's realtime client. Re-stamped on the
        // run's own publishes as `input-client-id`.
        inputClientId: opts?.inputClientId ?? inputMeta?.clientId,
      },
      hooks,
    );
  };

  const adoptRun = (
    runId: string,
    opts?: AdoptRunOptions,
    hooks?: OpenRunHooks<TOutput>,
  ): AgentRunTransport<TOutput> => {
    assertCanOpen('adoptRun');
    if (runId === '') {
      throw new Ably.ErrorInfo('unable to adopt run; runId must be non-empty', ErrorCode.InvalidArgument, 400);
    }
    const invocationId = opts?.invocationId ?? crypto.randomUUID();
    logger.trace('AgentTransport.adoptRun();', { runId, invocationId });
    return createRun({ runId, invocationId, open: 'adopt' }, hooks);
  };

  /**
   * Build a run handle from resolved parameters: register it for cancel and
   * steer routing, fire the opening publish (`'start'` / `'resume'`) or seed
   * the run-manager owner entry without publishing (`'adopt'`), and wire the
   * step writer. All identity and structure resolution belongs to the public
   * verbs; this function consumes the resolved values verbatim.
   * @param params - The resolved run identity, open mode, anchor and structure.
   * @param hooks - The caller's per-run callbacks and external AbortSignal.
   * @returns The run's write handle.
   */
  const createRun = (params: CreateRunParams, hooks?: OpenRunHooks<TOutput>): AgentRunTransport<TOutput> => {
    const { runId, invocationId, inputTransportMessageId, inputClientId } = params;

    // The run's cancel controller: an accepted cancel aborts it, ending
    // in-flight pipes `'cancelled'` and firing the handle's `abortSignal`.
    const controller = new AbortController();
    // The handle's abort signal folds in the caller's external signal, so
    // either an accepted cancel or the caller's own abort ends the run's pipes.
    const signal = hooks?.signal ? AbortSignal.any([controller.signal, hooks.signal]) : controller.signal;
    // The handle's publish gate: 'open' accepts output, 'suspended' blocks it
    // until resume() re-opens, 'ended' is terminal.
    let state: 'open' | 'suspended' | 'ended' = 'open';

    // The run's steer state: the tracker drives hasInput()'s drain contract
    // and the per-attempt stamp delta; hasProducedOutput gates the initial
    // pass; knownSteerIds dedups a redelivered steer; consideredSteerIds
    // accumulates the ids step attempts took for stamping — the steer half of
    // the input-transport-message-ids bracket receipt on suspend/end.
    const steerTracker = new RunSteerTracker();
    let hasProducedOutput = false;
    const knownSteerIds = new Set<string>();
    const consideredSteerIds: string[] = [];

    /**
     * Track one steering message for this run. Skips the run's own triggering
     * input (the initial pass answers it) and a steer already tracked.
     * @param transportMessageId - The steering message's transport-message-id.
     * @returns True iff the steer became pending.
     */
    const trackSteer = (transportMessageId: string): boolean => {
      if (transportMessageId === inputTransportMessageId) return false;
      if (knownSteerIds.has(transportMessageId)) return false;
      knownSteerIds.add(transportMessageId);
      steerTracker.addPending(transportMessageId);
      return true;
    };

    /**
     * The `input-transport-message-ids` bracket receipt for this run's terminal
     * events: the trigger plus every steer a step attempt took for stamping.
     * `undefined` until the run has produced output — a run that published
     * nothing considered nothing, so its bracket claims nothing.
     * @returns The considered input ids, or undefined to omit the header.
     */
    const consideredInputIds = (): string[] | undefined => {
      if (!hasProducedOutput) return undefined;
      return inputTransportMessageId === undefined
        ? [...consideredSteerIds]
        : [inputTransportMessageId, ...consideredSteerIds];
    };

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
        logger.error('AgentTransport.notifySteer(); onSteer threw', { runId, error: errorMessage(error) });
        receiver.emitError(errInfo);
      }
    };

    const registration: RegisteredRun = {
      runId,
      controller,
      onCancel: hooks?.onCancel,
      onError: hooks?.onError,
      inputTransportMessageId,
      onSteerMessage: (transportMessageId) => {
        if (trackSteer(transportMessageId)) notifySteer();
      },
    };
    registeredRuns.set(runId, registration);
    if (inputTransportMessageId !== undefined) {
      runIdByInputTransportMessageId.set(inputTransportMessageId, runId);
    }

    /**
     * Remove this run from the routing maps: the registry, the input reverse
     * index (only while it still points at this run), and any stale deferred
     * cancel for its input. Called when the run ends or its open publish
     * fails. A suspended run stays registered (see {@link RegisteredRun}).
     */
    const deregister = (): void => {
      registeredRuns.delete(runId);
      preOpenSteersByRunId.delete(runId);
      if (inputTransportMessageId !== undefined) {
        if (runIdByInputTransportMessageId.get(inputTransportMessageId) === runId) {
          runIdByInputTransportMessageId.delete(inputTransportMessageId);
        }
        deferredCancels.delete(inputTransportMessageId);
      }
    };

    // Pull the steers that landed before this openRun (between connect() and
    // here, after the attach point). One onSteer hint covers the batch.
    {
      const bufferedSteers = preOpenSteersByRunId.get(runId);
      if (bufferedSteers) {
        preOpenSteersByRunId.delete(runId);
        let seededAny = false;
        for (const id of bufferedSteers) {
          if (trackSteer(id)) seededAny = true;
        }
        if (seededAny) {
          logger.debug('AgentTransport.openRun(); seeded pre-open steers', { runId });
          notifySteer();
        }
      }
    }

    // Honour a cancel that arrived before this openRun established the
    // input-transport-message-id → run linkage. Fire-and-forget: with no onCancel
    // hook the abort happens synchronously (no await precedes it), a hook
    // error is surfaced inside cancelRegistration, and a dispatch failure (a
    // throwing onError) is reported by the routing bracket below.
    if (inputTransportMessageId !== undefined) {
      const buffered = deferredCancels.get(inputTransportMessageId);
      if (buffered !== undefined) {
        deferredCancels.delete(inputTransportMessageId);
        logger.debug('AgentTransport.openRun(); honouring buffered cancel', { runId, inputTransportMessageId });
        cancelRegistration(registration, buffered).catch((error: unknown) => {
          reportCancelRoutingFailure(error, { runId, inputTransportMessageId });
        });
      }
    }

    // Fire the opening publish without awaiting — openRun returns
    // synchronously. It waits for connect() to complete first, so
    // `ai-run-start` cannot beat the subscribe and open a window where a
    // cancel for this run would be missed. The output verbs await this
    // through `requireConnected`, so `ai-run-start` is on the wire before any
    // `ai-output`.
    const openPromise = (async (): Promise<void> => {
      await connectGuard.requireConnected('openRun');
      if (params.open === 'adopt') {
        // Attach-without-publishing: seed the run manager's owner entry so
        // output and terminals stamp the real run-client-id, but put nothing
        // on the wire — the caller publishes only what it means to publish.
        runManager.registerRun(runId, clientId);
        return;
      }
      await publishLifecycleEvent(
        {
          phase: params.open === 'resume' ? 'run-resume' : 'run-start',
          component: 'AgentTransport',
          method: 'openRun',
          runId,
          logger,
        },
        async () =>
          runManager.startRun(runId, clientId, {
            invocationId,
            inputClientId,
            // Anchor the opening event to its trigger. This header is the only
            // thing that lets the client which published the input resolve the
            // run's id off the channel (see `PublishInputResult.runId`).
            inputTransportMessageId: params.inputTransportMessageId,
            continuation: params.open === 'resume',
          }),
      );
    })();
    // Swallow a rejection here so an opened-but-never-piped run cannot surface
    // an unhandled rejection; the failure still propagates to any `pipe` / `end`
    // await site through the same promise. A run whose open failed receives no
    // signals, so drop its registration.
    openPromise.catch((error: unknown) => {
      logger.error('AgentTransport.openRun(); open publish failed', { runId, error: errorMessage(error) });
      deregister();
    });

    // The output verbs await the opening publish so `ai-run-start` precedes the
    // first `ai-output` on the wire.
    const requireConnected = async (): Promise<void> => {
      await openPromise;
    };

    const stepWriter = createRunStepWriter<TInput, TOutput>({
      getRunId: () => runId,
      invocationId,
      codec,
      channel,
      runManager,
      // Emit the writer's optimistic step-start / step-end seed on the
      // transport's own receive stream, so a subscriber sees the bracket
      // before the wire echo and reconciles it by `stepStartSerial`.
      emitStepLifecycle: (event) => {
        receiver.emitEvent({ kind: 'step-lifecycle', event });
      },
      // The caller's per-run hooks, `onError` included: the writer fires it
      // with a wrapped pipe stream failure alongside the `StreamResult.error`
      // return.
      hooks: hooks ?? {},
      signal,
      markOutputProduced: () => {
        hasProducedOutput = true;
      },
      consumeSteerStampIds: () => {
        // The moment a step attempt takes drained steers for stamping is the
        // moment they count as considered — the same transfer point the
        // per-output steer-transport-message-ids stamp uses, so the bracket
        // receipt and the stamps agree.
        const ids = steerTracker.consumeRecentlyProcessed();
        consideredSteerIds.push(...ids);
        return ids;
      },
      logger,
      requireConnected,
      assertPublishable: (verb) => {
        if (state === 'open') return;
        const action = verb === 'pipe' ? 'pipe stream' : verb === 'step' ? 'run step' : 'send output';
        throw new Ably.ErrorInfo(
          state === 'suspended'
            ? `unable to ${action}; run ${runId} is suspended`
            : `unable to ${action}; run ${runId} has already ended`,
          ErrorCode.InvalidArgument,
          400,
        );
      },
      // The anchor comes straight from the openRun options — there is no
      // triggering-input resolution (a durable agent reads it via locateInput and
      // threads it through openRun / per-pipe options itself).
      getAnchors: () => ({
        inputClientId,
        inputTransportMessageId,
      }),
    });

    /**
     * Wrap the writer's {@link WriterStep} as a {@link RunStepTransport}: the
     * transport surface has no `start()`, so the step is started lazily on its
     * first `pipe` / `send`, avoiding an empty `ai-step-start` / `ai-step-end`
     * bracket for a step that publishes nothing.
     * @param stepOpts - Optional per-step options passed to the writer.
     * @returns The transport-facing step handle.
     */
    const createStep = (stepOpts?: StepOptions): RunStepTransport<TOutput> => {
      const step = stepWriter.createStep(stepOpts);
      let started = false;
      const ensureStarted = async (): Promise<void> => {
        if (started) return;
        started = true;
        await step.start();
      };
      return {
        get stepId() {
          return step.stepId;
        },
        pipe: async (source: PipeSource<TOutput>): Promise<StreamResult> => {
          await ensureStarted();
          return step.pipe(source);
        },
        send: async (event: TOutput): Promise<void> => {
          await ensureStarted();
          await step.send(event);
        },
        end: async (params: StepEndParams): Promise<void> => {
          await step.end(params);
        },
      };
    };

    return {
      get runId() {
        return runId;
      },
      get abortSignal() {
        return signal;
      },
      hasInput: (): boolean => {
        // Loop driver: run at least once for the triggering input, then again
        // for each steering message tracked since the previous pass. A cancel
        // (aborted signal) stops the loop. Reading DRAINS pending steers into
        // the set the next step attempt stamps, so there is no observe-only
        // check.
        if (signal.aborted) return false;
        const hadPending = steerTracker.hasPending();
        if (hadPending) steerTracker.drainPending();
        if (!hasProducedOutput) return true;
        return hadPending;
      },
      pipe: stepWriter.pipe,
      createStep,
      suspend: async (): Promise<void> => {
        logger.trace('AgentRunTransport.suspend();', { runId });
        if (state !== 'open') return;
        // A suspend mid-step would strand the open step (no `ai-step-end` before
        // the run pauses); require the caller to end it first. Unlike end,
        // suspend does not auto-close — a resumed run may continue the step.
        if (stepWriter.hasActiveStep()) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; end the active step before suspending (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        state = 'suspended';
        await publishLifecycleEvent(
          { phase: 'run-suspend', component: 'AgentRunTransport', method: 'suspend', runId, logger },
          async () => runManager.suspendRun(runId, invocationId, inputClientId, consideredInputIds()),
        );
      },
      resume: async (): Promise<void> => {
        logger.trace('AgentRunTransport.resume();', { runId });
        if (state === 'ended') {
          throw new Ably.ErrorInfo(
            `unable to resume run; run ${runId} has already ended`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // A pure re-entry signal: republish `ai-run-resume` under the same run-id
        // with no structure headers (continuation). The gate re-opens only once
        // the publish succeeds, so a failed resume leaves the run suspended.
        await publishLifecycleEvent(
          { phase: 'run-resume', component: 'AgentRunTransport', method: 'resume', runId, logger },
          async () => runManager.startRun(runId, clientId, { invocationId, continuation: true }),
        );
        state = 'open';
      },
      end: async (params: RunEndParams): Promise<void> => {
        logger.trace('AgentRunTransport.end();', { runId, reason: params.reason });
        if (state === 'ended') return;
        state = 'ended';
        // The run stops receiving signals the moment it is terminal, even if
        // the terminal publish below is still in flight.
        deregister();
        // Auto-close any still-open step first so its `ai-step-end` precedes this
        // `ai-run-end` on the wire and no observer is stranded. Best-effort — a
        // step-close failure must not block the run terminal.
        try {
          await stepWriter.closeActiveStep(stepEndReasonFor(params.reason));
        } catch (error) {
          // Swallowed so the run terminal still publishes, which makes this log
          // the only record of why the step never closed.
          logger.error('AgentRunTransport.end(); failed to auto-close active step', {
            runId,
            error: errorMessage(error),
          });
        }
        const error = params.reason === 'error' ? params.error : undefined;
        await publishLifecycleEvent(
          { phase: 'run-end', component: 'AgentRunTransport', method: 'end', runId, logger },
          async () => runManager.endRun(runId, params.reason, invocationId, inputClientId, error, consideredInputIds()),
        );
      },
    };
  };

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  /**
   * The shared backward history pager: a lazily opened `untilAttach` cursor,
   * single-flight across `history()` calls, classifying on the live stream's
   * decoder. A decode failure while paging surfaces on the receive stream's
   * `error`, matching the live fold. See {@link createHistoryPager}.
   */
  const historyPager = createHistoryPager({
    channel,
    decoder,
    pageLimit: historyPageSize,
    logger,
    onDecodeError: (err) => {
      receiver.emitError(err);
    },
  });

  const history = async (opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> => {
    logger.trace('AgentTransport.history();');
    await requireOpen('history');
    return historyPager.next(opts);
  };

  const locateInput = async (
    eventId: string,
    opts?: TransportHistoryOptions,
  ): Promise<LocatedInput<TInput> | undefined> => {
    logger.trace('AgentTransport.locateInput();', { eventId });
    await requireOpen('locateInput');
    // A throwaway decoder so the history scan never perturbs the live receive
    // stream's dedup state, keeping the 1:1 decoder-per-stream invariant.
    const scanDecoder = codec.createDecoder();
    // The scan cursor is per-call and thrown away, so binding the caller's
    // signal to it is safe: it aborts the eager first fetch and the retry
    // backoffs, and the loop below turns the abort into a rejection.
    const cursor = await loadHistoryPages(channel, {
      pageLimit: historyPageSize,
      signal: opts?.signal,
      logger,
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
      reportPage(opts?.onPage, 'locateInput', logger);
      if (!page) break;
      scanned += page.length;
      for (const msg of page) {
        if (getTransportHeaders(msg)[HEADER_EVENT_ID] === eventId) {
          const { inputs } = scanDecoder.decode(msg);
          logger.debug('AgentTransport.locateInput(); input located', { eventId, serial: msg.serial });
          return { meta: wireMetaFromMessage(msg), inputs };
        }
      }
    }
    logger.debug('AgentTransport.locateInput(); no matching input in history', { eventId });
    return undefined;
  };

  return { connect, subscribe, on, openRun, adoptRun, locateInput, history, close };
};
