/**
 * Core client-side session, parameterized by codec.
 *
 * Composes StreamRouter and Tree to handle the full client-side lifecycle.
 * `connect()` subscribes to the Ably channel (which implicitly attaches it).
 * The same subscription, decoder, and channel are reused across runs.
 *
 * The client never publishes user messages directly. Instead, it sends them
 * to the agent via HTTP POST. The agent publishes user messages and run
 * lifecycle events (run-start, run-end) on behalf of the client.
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_AMEND,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { DecoderOutput, MessageAccumulator, StreamDecoder } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import type { StreamRouter } from './stream-router.js';
import { createStreamRouter } from './stream-router.js';
import type { DefaultTree } from './tree.js';
import { createTree } from './tree.js';
import type {
  ActiveRun,
  CancelFilter,
  ClientSession,
  ClientSessionOptions,
  CloseOptions,
  EventsNode,
  MessageNode,
  RunEndReason,
  RunLifecycleEvent,
  SendOptions,
  Tree,
  View,
} from './types.js';
import { createView, type DefaultView } from './view.js';

/**
 * Returned from `on()` when the session is already closed — the subscription
 * is silently ignored since no further events will fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
const noopUnsubscribe = (): void => {};

// ---------------------------------------------------------------------------
// Internal state machine
// ---------------------------------------------------------------------------

enum ClientSessionState {
  READY = 'ready',
  CLOSED = 'closed',
}

// ---------------------------------------------------------------------------
// Event map for the session's typed EventEmitter
// ---------------------------------------------------------------------------

interface ClientSessionEventsMap {
  error: Ably.ErrorInfo;
}

// ---------------------------------------------------------------------------
// Per-run observer state — consolidated to avoid parallel-map bookkeeping
// ---------------------------------------------------------------------------

interface RunObserverState<TEvent, TMessage> {
  headers: Record<string, string>;
  serial: string | undefined;
  accumulator: MessageAccumulator<TEvent, TMessage>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT1
class DefaultClientSession<TEvent, TMessage> implements ClientSession<TEvent, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ClientSessionOptions<TEvent, TMessage>['codec'];
  private readonly _clientId: string | undefined;
  private readonly _api: string;
  private readonly _credentials: RequestCredentials | undefined;
  private readonly _headersFn: (() => Record<string, string>) | undefined;
  private readonly _bodyFn: (() => Record<string, unknown>) | undefined;
  private readonly _fetchFn: typeof globalThis.fetch;
  private readonly _logger: Logger;

  // Typed event emitter — only 'error' remains on the session
  private readonly _emitter: EventEmitter<ClientSessionEventsMap>;

  // Relay detection — tracks msg-ids of optimistic inserts for reconciliation
  private readonly _ownMsgIds = new Set<string>();
  private readonly _ownRunIds = new Set<string>();

  // Track msgIds per run for cleanup on run-end
  private readonly _runMsgIds = new Map<string, Set<string>>();

  // Per-run observer state: headers, serial, and accumulator in one map.
  // A single .delete(runId) cleans up all three.
  private readonly _runObservers = new Map<string, RunObserverState<TEvent, TMessage>>();

  // Callbacks to resolve pending waitForRun promises on close, preventing leaked subscriptions.
  private readonly _closeResolvers: (() => void)[] = [];

  // Sub-components
  private readonly _tree: DefaultTree<TMessage>;
  private readonly _view: DefaultView<TEvent, TMessage>;
  private readonly _views = new Set<DefaultView<TEvent, TMessage>>();
  private readonly _router: StreamRouter<TEvent>;
  private readonly _decoder: StreamDecoder<TEvent, TMessage>;

  // Spec: AIT-CT10, AIT-CT10a
  readonly tree: Tree<TMessage>;
  readonly view: View<TEvent, TMessage>;

  // Channel subscription is established lazily on connect()
  private _connectPromise: Promise<void> | undefined;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _state = ClientSessionState.READY;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  // Events staged locally via stageEvents(). Flushed into the eventNodes
  // parameter of _internalSend on the next send operation.
  private _pendingLocalEvents: EventsNode<TEvent>[] = [];

  constructor(options: ClientSessionOptions<TEvent, TMessage>) {
    // Spec: AIT-CT1a, AIT-CT1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const channelOptions = registerAgent(options.client);
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._api = options.api;
    this._credentials = options.credentials;
    // CAST: TS can't narrow options.headers/body inside a closure because the outer
    // object is mutable. The truthiness check on the preceding line guarantees non-nullish.
    this._headersFn =
      typeof options.headers === 'function'
        ? options.headers
        : options.headers
          ? () => options.headers as Record<string, string>
          : undefined;
    this._bodyFn =
      typeof options.body === 'function'
        ? options.body
        : options.body
          ? () => options.body as Record<string, unknown>
          : undefined;
    this._fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientSession',
    });

    this._emitter = new EventEmitter<ClientSessionEventsMap>(this._logger);
    this._hasAttachedOnce = this._channel.state === 'attached';

    // Compose sub-components
    this._tree = createTree<TMessage>(this._logger);
    this._view = createView<TEvent, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(this._view),
    });
    this._router = createStreamRouter<TEvent>(this._codec.isTerminal.bind(this._codec), this._logger);
    this._decoder = this._codec.createDecoder();

    this._views.add(this._view);

    // Public accessors (typed as narrow interfaces)
    this.tree = this._tree;
    this.view = this._view;

    // Seed tree with initial messages — session assigns its own msgId
    if (options.messages) {
      let prevMsgId: string | undefined;
      for (const msg of options.messages) {
        const msgId = crypto.randomUUID();
        const seedHeaders: Record<string, string> = { [HEADER_MSG_ID]: msgId };
        if (prevMsgId) seedHeaders[HEADER_PARENT] = prevMsgId;
        this._tree.upsert(msgId, msg, seedHeaders);
        prevMsgId = msgId;
      }
    }

    // Spec: AIT-CT2
    // Listener function reference — bound now so it can be unsubscribed on close.
    this._onMessage = (ablyMessage: Ably.InboundMessage) => {
      this._handleMessage(ablyMessage);
    };

    // Listen for channel state changes that break message continuity.
    // _hasAttachedOnce is seeded from the channel's current state so that
    // pre-attached channels are handled correctly. It distinguishes the
    // initial attach (expected) from a genuine discontinuity.
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);
  }

  // ---------------------------------------------------------------------------
  // Public connection API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger.trace('DefaultClientSession.connect();');
    // Subscribe before attach (RTL7g) — subscribe implicitly attaches the channel.
    this._connectPromise = this._channel.subscribe(this._onMessage).then(
      () => {
        this._logger.debug('DefaultClientSession.connect(); subscribed and attached');
      },
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to channel; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger.error('DefaultClientSession.connect(); subscribe failed');
        this._emitter.emit('error', errInfo);
        throw errInfo;
      },
    );
    return this._connectPromise;
  }

  private async _requireConnected(method: string): Promise<void> {
    if (!this._connectPromise) {
      throw new Ably.ErrorInfo(
        `unable to ${method}; connect() must be called before ${method}()`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    return this._connectPromise;
  }

  // ---------------------------------------------------------------------------
  // Message subscription handler
  // ---------------------------------------------------------------------------

  private _handleMessage(ablyMessage: Ably.InboundMessage): void {
    if (this._state === ClientSessionState.CLOSED) return;

    try {
      // Spec: AIT-CT16a
      // --- Run lifecycle events from the agent ---
      if (ablyMessage.name === EVENT_RUN_START) {
        const headers = getHeaders(ablyMessage);
        const runId = headers[HEADER_RUN_ID];
        const runCid = headers[HEADER_RUN_CLIENT_ID] ?? '';
        if (runId) {
          this._tree.trackRun(runId, runCid);
          const parentRaw = headers[HEADER_PARENT];
          const forkOf = headers[HEADER_FORK_OF];
          this._tree.emitRun({
            type: EVENT_RUN_START,
            runId,
            clientId: runCid,
            ...(parentRaw !== undefined && { parent: parentRaw }),
            ...(forkOf !== undefined && { forkOf }),
          });
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      if (ablyMessage.name === EVENT_RUN_END) {
        const headers = getHeaders(ablyMessage);
        const runId = headers[HEADER_RUN_ID];
        const runCid = headers[HEADER_RUN_CLIENT_ID] ?? '';
        // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;
        if (runId) {
          this._router.closeStream(runId);
          this._runObservers.delete(runId);
          this._tree.untrackRun(runId);
          // Clean up per-run relay-detection state
          const msgIds = this._runMsgIds.get(runId);
          if (msgIds) {
            for (const mid of msgIds) this._ownMsgIds.delete(mid);
            this._runMsgIds.delete(runId);
          }
          this._ownRunIds.delete(runId);
          this._tree.emitRun({ type: EVENT_RUN_END, runId, clientId: runCid, reason });
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      // --- Codec-decoded messages ---
      const outputs = this._decoder.decode(ablyMessage);
      const headers = getHeaders(ablyMessage);
      const serial = ablyMessage.serial;

      // Cross-run events target an existing message from a prior run,
      // bypassing the current run's accumulator.
      const amendTarget = headers[HEADER_AMEND];
      if (amendTarget) {
        for (const output of outputs) {
          if (output.kind === 'event') {
            this._handleAmendmentEvent(amendTarget, output);
          }
        }
        return;
      }

      // Always update observer headers, even when the decoder produces no outputs.
      // This ensures header transitions (e.g. x-ably-status: streaming → aborted)
      // are captured for events that the decoder suppresses (AIT-CD8: aborted
      // stream appends emit no events but still carry the updated status header).
      const runId = headers[HEADER_RUN_ID];
      if (runId) {
        this._updateRunObserverHeaders(runId, headers, serial);
      }

      for (const output of outputs) {
        if (output.kind === 'message') {
          this._handleMessageOutput(output.message, headers, serial, ablyMessage.action);
        } else {
          this._handleEventOutput(output, headers);
        }
      }

      // Emit ably-message AFTER decode/upsert so that View subscribers can
      // find the node in _lastVisibleIds (which is refreshed by tree 'update'
      // events triggered during upsert).
      this._tree.emitAblyMessage(ablyMessage);
    } catch (error) {
      const cause = error instanceof Ably.ErrorInfo ? error : undefined;
      this._emitter.emit(
        'error',
        new Ably.ErrorInfo(
          `unable to process channel message; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          cause,
        ),
      );
    }
  }

  /**
   * Handle a decoded domain message (user message create or relayed own message).
   * @param message - The decoded domain message.
   * @param headers - Ably headers from the wire message.
   * @param serial - Ably serial for tree ordering.
   * @param action - Ably message action (e.g. 'message.create').
   */
  private _handleMessageOutput(
    message: TMessage,
    headers: Record<string, string>,
    serial: string | undefined,
    action: string | undefined,
  ): void {
    // Spec: AIT-CT15
    const msgId = headers[HEADER_MSG_ID];
    if (msgId && this._ownMsgIds.has(msgId)) {
      // Relayed own message — reconcile optimistic entry with server-assigned fields
      this._upsertAndNotify(message, headers, serial);
      return;
    }

    if (action === 'message.create') {
      this._upsertAndNotify(message, headers, serial);
    }
  }

  /**
   * Handle a decoded streaming event: route to own-run stream or accumulate for observer.
   * @param output - The decoded event output from the codec.
   * @param headers - Ably headers from the wire message.
   */
  private _handleEventOutput(output: DecoderOutput<TEvent, TMessage>, headers: Record<string, string>): void {
    if (output.kind !== 'event') return;
    const event = output.event;
    const runId = headers[HEADER_RUN_ID];
    if (!runId) return;

    // Observer headers are already updated in _handleMessage (before outputs
    // are iterated) so that header transitions are captured even when the
    // decoder produces no outputs (e.g. aborted stream appends per AIT-CD8).

    // Active own run — route to the ReadableStream
    if (this._router.route(runId, event)) {
      this._accumulateAndEmit(runId, output);
      if (this._codec.isTerminal(event)) this._runObservers.delete(runId);
      return;
    }

    // Completed own run — late arrival, skip
    if (this._ownRunIds.has(runId) && !this._runObservers.has(runId)) return;

    // Spec: AIT-CT16
    // Observer run — accumulate and emit
    this._accumulateAndEmit(runId, output);
    if (this._codec.isTerminal(event)) this._runObservers.delete(runId);
  }

  /**
   * Handle a cross-run event targeting an existing message from a prior run.
   * Creates a temporary accumulator, seeds it with the existing message,
   * processes the event, and upserts the updated message into the tree.
   * @param targetMsgId - The x-ably-msg-id of the message to update.
   * @param output - The decoded event output to apply.
   */
  private _handleAmendmentEvent(targetMsgId: string, output: DecoderOutput<TEvent, TMessage>): void {
    this._logger.trace('ClientSession._handleAmendmentEvent();', { targetMsgId });

    const existingNode = this._tree.getNode(targetMsgId);
    if (!existingNode) {
      this._logger.debug('ClientSession._handleAmendmentEvent(); target not found, dropping', { targetMsgId });
      return;
    }

    const accumulator = this._codec.createAccumulator();
    accumulator.initMessage(targetMsgId, existingNode.message);
    accumulator.processOutputs([output]);

    const updatedMsg = accumulator.messages.at(-1);
    if (updatedMsg) {
      this._tree.upsert(targetMsgId, updatedMsg, existingNode.headers, existingNode.serial);
    }
  }

  // ---------------------------------------------------------------------------
  // Channel state change handler
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT19, AIT-CT19a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === ClientSessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity
    if (current === 'attached' && !this._hasAttachedOnce) {
      this._hasAttachedOnce = true;
      return;
    }

    // Continuity-breaking states:
    // - FAILED, SUSPENDED, DETACHED: no more messages expected (or gap)
    // - ATTACHED with resumed: false (UPDATE): messages were lost
    const continuityLost =
      current === 'failed' || current === 'suspended' || current === 'detached' || (current === 'attached' && !resumed);

    if (!continuityLost) return;

    this._logger.error('ClientSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const err = new Ably.ErrorInfo(
      `unable to deliver events; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
      ErrorCode.ChannelContinuityLost,
      500,
      stateChange.reason,
    );

    // As with cancellation (_closeMatchingRunStreams), do not clear
    // _ownRunIds or _runObservers here — late events must still accumulate
    // into the tree. The run-end handler cleans up observers.
    for (const runId of this._ownRunIds) {
      this._router.errorStream(runId, err);
    }

    this._emitter.emit('error', err);
  }

  // ---------------------------------------------------------------------------
  // Tree mutation + notification helpers
  // ---------------------------------------------------------------------------

  /**
   * Upsert a message into the tree and notify subscribers.
   * @param message - The domain message to insert or update.
   * @param headers - Ably headers for the message.
   * @param serial - Ably serial for tree ordering.
   */
  private _upsertAndNotify(message: TMessage, headers: Record<string, string>, serial?: string): void {
    const msgId = headers[HEADER_MSG_ID];
    if (!msgId) return;
    this._tree.upsert(msgId, message, headers, serial);
  }

  // ---------------------------------------------------------------------------
  // Observer accumulation
  // ---------------------------------------------------------------------------

  /**
   * Ensure a RunObserverState exists for runId, updating headers and serial as new events arrive.
   * @param runId - The run to track.
   * @param headers - Headers from the current event.
   * @param serial - Ably serial from the current event.
   */
  private _updateRunObserverHeaders(runId: string, headers: Record<string, string>, serial: string | undefined): void {
    const existing = this._runObservers.get(runId);
    if (existing) {
      if (Object.keys(headers).length > 0) {
        Object.assign(existing.headers, headers);
      }
      // Always advance the serial so the tree node sorts after all
      // earlier messages in the run (e.g. user-message relays that
      // arrive before the assistant response).
      if (serial !== undefined) {
        existing.serial = serial;
      }
    } else {
      this._runObservers.set(runId, {
        headers: { ...headers },
        serial,
        accumulator: this._codec.createAccumulator(),
      });
    }
  }

  /**
   * Process a streaming event through the run's accumulator and emit the latest message.
   * @param runId - The run this event belongs to.
   * @param output - The decoded event output to accumulate.
   */
  private _accumulateAndEmit(runId: string, output: DecoderOutput<TEvent, TMessage>): void {
    const observer = this._runObservers.get(runId);
    if (!observer) return;

    // Sync the accumulator with the tree before processing. If the message
    // was updated externally (via cross-run events), initMessage syncs the
    // accumulator's state so the update isn't lost when processing
    // late run events like finish-step/finish.
    const msgId = observer.headers[HEADER_MSG_ID];
    if (msgId) {
      const treeNode = this._tree.getNode(msgId);
      if (treeNode) {
        observer.accumulator.initMessage(msgId, treeNode.message);
      }
    }

    observer.accumulator.processOutputs([output]);

    const messages = observer.accumulator.messages;
    if (messages.length === 0) return;

    let message: TMessage | undefined;
    try {
      message = structuredClone(messages.at(-1));
    } catch {
      // CAST: structuredClone can fail if the message contains non-cloneable
      // values (e.g. functions). Fall back to the reference — the tree upsert
      // below copies headers independently, so shared message state is the
      // only risk. Accumulator messages are replaced on each event, so
      // mutation between events is not a practical concern.
      message = messages.at(-1);
    }

    if (message) {
      const msgId = observer.headers[HEADER_MSG_ID];
      if (msgId) {
        this._tree.upsert(msgId, message, { ...observer.headers }, observer.serial);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel helpers
  // ---------------------------------------------------------------------------

  private async _publishCancel(filter: CancelFilter): Promise<void> {
    this._logger.trace('ClientSession._publishCancel();', { filter });

    const headers: Record<string, string> = {};
    if (filter.runId) {
      headers[HEADER_CANCEL_RUN_ID] = filter.runId;
    } else if (filter.own) {
      headers[HEADER_CANCEL_OWN] = 'true';
    } else if (filter.clientId) {
      headers[HEADER_CANCEL_CLIENT_ID] = filter.clientId;
    } else if (filter.all) {
      headers[HEADER_CANCEL_ALL] = 'true';
    }

    await this._channel.publish({
      name: EVENT_CANCEL,
      extras: { headers },
    });
  }

  private _closeMatchingRunStreams(filter: CancelFilter): void {
    // Only close the router streams here — do NOT clear _runObservers.
    // The observer must remain alive so that late agent events (e.g. abort,
    // x-ably-status: aborted) arriving before run-end are still accumulated
    // into the message store. The run-end handler cleans up observers.
    for (const runId of this._getMatchingRunIds(filter)) {
      this._router.closeStream(runId);
    }
  }

  private _getMatchingRunIds(filter: CancelFilter): Set<string> {
    const matched = new Set<string>();
    const activeRuns = this._tree.getActiveRunIds();

    if (filter.all) {
      for (const runIds of activeRuns.values()) {
        for (const runId of runIds) matched.add(runId);
      }
    } else if (filter.own) {
      const ownRuns = activeRuns.get(this._clientId ?? '');
      if (ownRuns) {
        for (const runId of ownRuns) matched.add(runId);
      }
    } else if (filter.clientId) {
      const clientRuns = activeRuns.get(filter.clientId);
      if (clientRuns) {
        for (const runId of clientRuns) matched.add(runId);
      }
    } else if (filter.runId) {
      // Check if the runId exists in any client's runs
      for (const runIds of activeRuns.values()) {
        if (runIds.has(filter.runId)) {
          matched.add(filter.runId);
          break;
        }
      }
    }
    return matched;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): View<TEvent, TMessage> {
    if (this._state === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to create view; session is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('DefaultClientSession.createView();');
    const view = createView<TEvent, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(view),
    });
    this._views.add(view);
    return view;
  }

  // Spec: AIT-CT3, AIT-CT4
  private async _internalSend(
    input: TMessage | TMessage[],
    sendOptions: SendOptions | undefined,
    history: MessageNode<TMessage>[],
    eventNodes?: EventsNode<TEvent>[],
  ): Promise<ActiveRun<TEvent>> {
    if (this._state === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }
    await this._requireConnected('send');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    // TypeScript's control flow narrows _state after the first check, but the
    // await yields and close() can mutate _state concurrently.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }

    // Spec: AIT-CT20
    const state = this._channel.state;
    if (state !== 'attached' && state !== 'attaching') {
      throw new Ably.ErrorInfo(`unable to send; channel is ${state}`, ErrorCode.ChannelNotReady, 400);
    }

    this._logger.trace('ClientSession._internalSend();');

    const msgs = Array.isArray(input) ? input : [input];
    const runId = crypto.randomUUID();
    this._ownRunIds.add(runId);
    this._tree.trackRun(runId, this._clientId ?? '');

    // Flush any events staged via stageEvents() since the last send. They
    // have already been applied to the tree, so merge them into the POST
    // body without re-applying. External eventNodes (e.g. from view.update)
    // have NOT been applied yet and need the optimistic tree update below.
    const flushedStaged = this._pendingLocalEvents;
    this._pendingLocalEvents = [];

    // Optimistic tree updates for external cross-run events — must happen
    // before capturing history so the POST body includes the updated
    // message state.
    if (eventNodes && eventNodes.length > 0) {
      this._applyEventsToTree(eventNodes);
    }

    const allEventNodes: EventsNode<TEvent>[] = [...flushedStaged, ...(eventNodes ?? [])];

    const msgIds = new Set<string>();
    const postMessages: MessageNode<TMessage>[] = [];

    // The View pre-computed the visible branch before calling this delegate,
    // so preInsertHistory reflects the state before any optimistic inserts.
    const preInsertHistory = history;

    // Spec: AIT-CT3d
    // Auto-compute parent from the current thread if not explicitly provided
    let autoParent: string | undefined;
    if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
      const lastNode = preInsertHistory.at(-1);
      if (lastNode) {
        autoParent = lastNode.msgId;
      }
    }

    // Capture the first parent for the POST body before the loop advances it.
    const postParent = sendOptions?.parent === undefined ? autoParent : sendOptions.parent;

    for (const message of msgs) {
      const msgId = crypto.randomUUID();
      this._ownMsgIds.add(msgId);
      msgIds.add(msgId);

      const resolvedParent = sendOptions?.parent === undefined ? autoParent : sendOptions.parent;

      const optimisticHeaders = buildTransportHeaders({
        role: 'user',
        runId,
        msgId,
        runClientId: this._clientId,
        parent: resolvedParent,
        forkOf: sendOptions?.forkOf,
      });
      // Spec: AIT-CT3c
      // Optimistically insert each user message into the tree
      this._upsertAndNotify(message, optimisticHeaders);

      // Build MessageNode for the POST body
      postMessages.push({
        kind: 'message',
        message,
        msgId,
        parentId: resolvedParent,
        forkOf: sendOptions?.forkOf,
        headers: optimisticHeaders,
        serial: undefined,
      });

      // Spec: AIT-CT3e
      // Chain: each subsequent message in the batch parents off the previous
      // one, forming a linear conversation thread rather than siblings.
      if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
        autoParent = msgId;
      }
    }

    this._runMsgIds.set(runId, msgIds);

    // Create ReadableStream via router
    const stream = this._router.createStream(runId);

    // Resolve headers and body
    const resolvedHeaders = this._headersFn?.() ?? {};
    const resolvedBody = this._bodyFn?.() ?? {};

    const postBody: Record<string, unknown> = {
      ...resolvedBody,
      history: preInsertHistory,
      ...sendOptions?.body,
      runId,
      clientId: this._clientId,
      messages: postMessages,
      ...(sendOptions?.forkOf !== undefined && { forkOf: sendOptions.forkOf }),
      ...(postParent !== undefined && { parent: postParent }),
      ...(allEventNodes.length > 0 && { events: allEventNodes }),
    };

    const postHeaders: Record<string, string> = {
      ...resolvedHeaders,
      ...sendOptions?.headers,
    };

    // Spec: AIT-CT3a, AIT-CT3b
    // Fire-and-forget: POST must not block the stream return to the caller.
    // .catch() is intentional — async/await would delay stream availability.
    this._fetchFn(this._api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...postHeaders,
      },
      body: JSON.stringify(postBody),
      ...(this._credentials ? { credentials: this._credentials } : {}),
    })
      .then((response) => {
        if (!response.ok) {
          const err = new Ably.ErrorInfo(
            `unable to send; HTTP POST to ${this._api} returned ${String(response.status)} ${response.statusText}`,
            ErrorCode.SessionSendFailed,
            response.status,
          );
          this._emitter.emit('error', err);
          this._router.errorStream(runId, err);
        }
      })
      .catch((error: unknown) => {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        const err = new Ably.ErrorInfo(
          `unable to send; HTTP POST to ${this._api} failed: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSendFailed,
          500,
          cause,
        );
        this._emitter.emit('error', err);
        this._router.errorStream(runId, err);
      });

    return {
      stream,
      runId,
      cancel: async () => this.cancel({ runId }),
      optimisticMsgIds: [...msgIds],
    };
  }

  // Spec: AIT-CT7, AIT-CT7a
  async cancel(filter?: CancelFilter): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    await this._requireConnected('cancel');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) return;
    const resolved = filter ?? { own: true };
    this._logger.debug('ClientSession.cancel();', { filter: resolved });
    await this._publishCancel(resolved);
    this._closeMatchingRunStreams(resolved);
  }

  stageEvents(msgId: string, events: TEvent[]): void {
    this._logger.trace('ClientSession.stageEvents();', { msgId, eventCount: events.length });
    if (this._state === ClientSessionState.CLOSED) {
      this._logger.warn('ClientSession.stageEvents(); session is closed', { msgId });
      return;
    }
    if (!this._tree.getNode(msgId)) {
      this._logger.warn('ClientSession.stageEvents(); msgId not found in tree', { msgId });
      return;
    }
    if (events.length === 0) return;
    const node: EventsNode<TEvent> = { kind: 'event', msgId, events };
    // Apply immediately so any subsequent useMessageSync / tree observer
    // sees the merged state — no window where the staged event can be
    // clobbered by an interleaved observer run update.
    this._applyEventsToTree([node]);
    this._pendingLocalEvents.push(node);
  }

  stageMessage(msgId: string, message: TMessage): void {
    this._logger.trace('ClientSession.stageMessage();', { msgId });
    if (this._state === ClientSessionState.CLOSED) {
      this._logger.warn('ClientSession.stageMessage(); session is closed', { msgId });
      return;
    }
    const existing = this._tree.getNode(msgId);
    if (!existing) {
      this._logger.warn('ClientSession.stageMessage(); msgId not found in tree', { msgId });
      return;
    }
    // Preserve structural metadata; only the message body changes.
    this._tree.upsert(msgId, message, existing.headers, existing.serial);
  }

  // Apply events to the tree using the codec's accumulator. Shared by
  // stageEvents (local staging) and _internalSend (external eventNodes
  // arriving via view.update).
  private _applyEventsToTree(eventNodes: EventsNode<TEvent>[]): void {
    for (const node of eventNodes) {
      const existingNode = this._tree.getNode(node.msgId);
      if (!existingNode) continue;
      const outputs = node.events.map((event) => ({
        kind: 'event' as const,
        event,
        messageId: node.msgId,
      }));
      const accumulator = this._codec.createAccumulator();
      accumulator.initMessage(node.msgId, existingNode.message);
      accumulator.processOutputs(outputs);
      const updatedMsg = accumulator.messages.at(-1);
      if (updatedMsg) {
        this._tree.upsert(node.msgId, updatedMsg, existingNode.headers, existingNode.serial);
      }
    }
  }

  // Spec: AIT-CT18
  async waitForRun(filter?: CancelFilter): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    await this._requireConnected('waitForRun');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) return;
    const resolved = filter ?? { own: true };
    const remaining = this._getMatchingRunIds(resolved);
    if (remaining.size === 0) return;

    this._logger.debug('ClientSession.waitForRun();', { runIds: [...remaining] });

    return new Promise<void>((resolve) => {
      let resolvedFlag = false;
      const done = (): void => {
        if (resolvedFlag) return;
        resolvedFlag = true;
        unsub();
        const idx = this._closeResolvers.indexOf(done);
        if (idx !== -1) this._closeResolvers.splice(idx, 1);
        resolve();
      };

      const unsub = this._tree.on('run', (event: RunLifecycleEvent) => {
        if (event.type !== EVENT_RUN_END) return;
        remaining.delete(event.runId);
        if (remaining.size === 0) done();
      });

      // Resolve on session close to prevent leaked subscriptions
      this._closeResolvers.push(done);
    });
  }

  // Spec: AIT-CT8, AIT-CT8c, AIT-CT8d
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._state === ClientSessionState.CLOSED) return noopUnsubscribe;
    // CAST: the overload signature enforces the correct handler type.
    const cb = handler as (arg: ClientSessionEventsMap[keyof ClientSessionEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // Spec: AIT-CT12, AIT-CT12a, AIT-CT12b, AIT-CT10c
  async close(options?: CloseOptions): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    this._state = ClientSessionState.CLOSED;
    this._logger.info('ClientSession.close();');

    // Best-effort cancel publish before tearing down local state — only
    // possible if connect() was called (otherwise we have no subscription
    // and the channel may not be attached).
    if (options?.cancel && this._connectPromise) {
      try {
        await this._publishCancel(options.cancel);
      } catch {
        // Swallow: cancel is best-effort during teardown
      }
      this._closeMatchingRunStreams(options.cancel);
    }

    if (this._connectPromise) {
      this._channel.unsubscribe(this._onMessage);
    }
    this._channel.off(this._onChannelStateChange);

    // Close any remaining active streams
    for (const runId of this._ownRunIds) {
      this._router.closeStream(runId);
    }

    this._runObservers.clear();
    this._emitter.off();
    for (const v of this._views) v.close();
    this._views.clear();
    for (const resolve of this._closeResolvers) resolve();
    this._closeResolvers.length = 0;
    this._ownRunIds.clear();
    this._ownMsgIds.clear();
    this._runMsgIds.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a client-side session that manages conversation state over an Ably channel.
 *
 * The caller owns the client's lifecycle; the session owns its channel.
 * The session is created in a not-yet-connected state — callers must
 * `await session.connect()` before `send`, `regenerate`, `edit`, `update`,
 * `cancel`, or `waitForRun`.
 * @param options - Configuration for the client session.
 * @returns A new {@link ClientSession} instance.
 */
export const createClientSession = <TEvent, TMessage>(
  options: ClientSessionOptions<TEvent, TMessage>,
): ClientSession<TEvent, TMessage> => new DefaultClientSession(options);
