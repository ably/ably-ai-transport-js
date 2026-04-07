/**
 * Core client-side transport, parameterized by codec.
 *
 * Composes StreamRouter and Tree to handle the full client-side
 * lifecycle. Subscribes to the Ably channel on construction. The same
 * subscription, decoder, and channel are reused across turns.
 *
 * The client never publishes user messages directly. Instead, it sends them
 * to the server via HTTP POST. The server publishes user messages and turn
 * lifecycle events (turn-start, turn-end) on behalf of the client.
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_AMEND,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_TURN_ID,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { DecoderOutput, MessageAccumulator, StreamDecoder } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import type { StreamRouter } from './stream-router.js';
import { createStreamRouter } from './stream-router.js';
import type { DefaultTree } from './tree.js';
import { createTree } from './tree.js';
import type {
  ActiveTurn,
  CancelFilter,
  ClientTransport,
  ClientTransportOptions,
  CloseOptions,
  EventsNode,
  MessageNode,
  SendOptions,
  Tree,
  TurnEndReason,
  TurnLifecycleEvent,
  View,
} from './types.js';
import { createView, type DefaultView } from './view.js';

/**
 * Returned from `on()` when the transport is already closed — the subscription
 * is silently ignored since no further events will fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
const noopUnsubscribe = (): void => {};

// ---------------------------------------------------------------------------
// Event map for the transport's typed EventEmitter
// ---------------------------------------------------------------------------

interface ClientTransportEventsMap {
  error: Ably.ErrorInfo;
}

// ---------------------------------------------------------------------------
// Per-turn observer state — consolidated to avoid parallel-map bookkeeping
// ---------------------------------------------------------------------------

interface TurnObserverState<TEvent, TMessage> {
  headers: Record<string, string>;
  serial: string | undefined;
  accumulator: MessageAccumulator<TEvent, TMessage>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT1
class DefaultClientTransport<TEvent, TMessage> implements ClientTransport<TEvent, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ClientTransportOptions<TEvent, TMessage>['codec'];
  private readonly _clientId: string | undefined;
  private readonly _api: string;
  private readonly _credentials: RequestCredentials | undefined;
  private readonly _headersFn: (() => Record<string, string>) | undefined;
  private readonly _bodyFn: (() => Record<string, unknown>) | undefined;
  private readonly _fetchFn: typeof globalThis.fetch;
  private readonly _logger: Logger;

  // Typed event emitter — only 'error' remains on the transport
  private readonly _emitter: EventEmitter<ClientTransportEventsMap>;

  // Relay detection — tracks msg-ids of optimistic inserts for reconciliation
  private readonly _ownMsgIds = new Set<string>();
  private readonly _ownTurnIds = new Set<string>();

  // Track msgIds per turn for cleanup on turn-end
  private readonly _turnMsgIds = new Map<string, Set<string>>();

  // Per-turn observer state: headers, serial, and accumulator in one map.
  // A single .delete(turnId) cleans up all three.
  private readonly _turnObservers = new Map<string, TurnObserverState<TEvent, TMessage>>();

  // Callbacks to resolve pending waitForTurn promises on close, preventing leaked subscriptions.
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

  // Channel subscription — subscribe() returns a Promise that resolves when the channel attaches
  private readonly _attachPromise: Promise<unknown>;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _closed = false;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: ClientTransportOptions<TEvent, TMessage>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._api = options.api ?? '/api/chat';
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
      component: 'ClientTransport',
    });

    this._emitter = new EventEmitter<ClientTransportEventsMap>(this._logger);
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

    // Seed tree with initial messages — transport assigns its own msgId
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
    // Subscribe before attach (RTL7g)
    this._onMessage = (ablyMessage: Ably.InboundMessage) => {
      this._handleMessage(ablyMessage);
    };
    this._attachPromise = this._channel.subscribe(this._onMessage);

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
  // Message subscription handler
  // ---------------------------------------------------------------------------

  private _handleMessage(ablyMessage: Ably.InboundMessage): void {
    if (this._closed) return;

    try {
      // Spec: AIT-CT16a
      // --- Turn lifecycle events from the server ---
      if (ablyMessage.name === EVENT_TURN_START) {
        const headers = getHeaders(ablyMessage);
        const turnId = headers[HEADER_TURN_ID];
        const turnCid = headers[HEADER_TURN_CLIENT_ID] ?? '';
        if (turnId) {
          this._tree.trackTurn(turnId, turnCid);
          const parentRaw = headers[HEADER_PARENT];
          const forkOf = headers[HEADER_FORK_OF];
          this._tree.emitTurn({
            type: EVENT_TURN_START,
            turnId,
            clientId: turnCid,
            ...(parentRaw !== undefined && { parent: parentRaw }),
            ...(forkOf !== undefined && { forkOf }),
          });
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      if (ablyMessage.name === EVENT_TURN_END) {
        const headers = getHeaders(ablyMessage);
        const turnId = headers[HEADER_TURN_ID];
        const turnCid = headers[HEADER_TURN_CLIENT_ID] ?? '';
        // CAST: server always writes a valid TurnEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_TURN_REASON] ?? 'complete') as TurnEndReason;
        if (turnId) {
          this._router.closeStream(turnId);
          this._turnObservers.delete(turnId);
          this._tree.untrackTurn(turnId);
          // Clean up per-turn relay-detection state
          const msgIds = this._turnMsgIds.get(turnId);
          if (msgIds) {
            for (const mid of msgIds) this._ownMsgIds.delete(mid);
            this._turnMsgIds.delete(turnId);
          }
          this._ownTurnIds.delete(turnId);
          this._tree.emitTurn({ type: EVENT_TURN_END, turnId, clientId: turnCid, reason });
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      // --- Codec-decoded messages ---
      const outputs = this._decoder.decode(ablyMessage);
      const headers = getHeaders(ablyMessage);
      const serial = ablyMessage.serial;

      // Cross-turn events target an existing message from a prior turn,
      // bypassing the current turn's accumulator.
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
      const turnId = headers[HEADER_TURN_ID];
      if (turnId) {
        this._updateTurnObserverHeaders(turnId, headers, serial);
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
          ErrorCode.TransportSubscriptionError,
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
   * Handle a decoded streaming event: route to own-turn stream or accumulate for observer.
   * @param output - The decoded event output from the codec.
   * @param headers - Ably headers from the wire message.
   */
  private _handleEventOutput(output: DecoderOutput<TEvent, TMessage>, headers: Record<string, string>): void {
    if (output.kind !== 'event') return;
    const event = output.event;
    const turnId = headers[HEADER_TURN_ID];
    if (!turnId) return;

    // Observer headers are already updated in _handleMessage (before outputs
    // are iterated) so that header transitions are captured even when the
    // decoder produces no outputs (e.g. aborted stream appends per AIT-CD8).

    // Active own turn — route to the ReadableStream
    if (this._router.route(turnId, event)) {
      this._accumulateAndEmit(turnId, output);
      if (this._codec.isTerminal(event)) this._turnObservers.delete(turnId);
      return;
    }

    // Completed own turn — late arrival, skip
    if (this._ownTurnIds.has(turnId) && !this._turnObservers.has(turnId)) return;

    // Spec: AIT-CT16
    // Observer turn — accumulate and emit
    this._accumulateAndEmit(turnId, output);
    if (this._codec.isTerminal(event)) this._turnObservers.delete(turnId);
  }

  /**
   * Handle a cross-turn event targeting an existing message from a prior turn.
   * Creates a temporary accumulator, seeds it with the existing message,
   * processes the event, and upserts the updated message into the tree.
   * @param targetMsgId - The x-ably-msg-id of the message to update.
   * @param output - The decoded event output to apply.
   */
  private _handleAmendmentEvent(targetMsgId: string, output: DecoderOutput<TEvent, TMessage>): void {
    this._logger.trace('ClientTransport._handleAmendmentEvent();', { targetMsgId });

    const existingNode = this._tree.getNode(targetMsgId);
    if (!existingNode) {
      this._logger.debug('ClientTransport._handleAmendmentEvent(); target not found, dropping', { targetMsgId });
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

  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._closed) return;

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

    this._logger.error('ClientTransport._handleChannelStateChange(); channel continuity lost', {
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

    // As with cancellation (_closeMatchingTurnStreams), do not clear
    // _ownTurnIds or _turnObservers here — late events must still accumulate
    // into the tree. The turn-end handler cleans up observers.
    for (const turnId of this._ownTurnIds) {
      this._router.errorStream(turnId, err);
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
   * Ensure a TurnObserverState exists for turnId, updating headers and serial as new events arrive.
   * @param turnId - The turn to track.
   * @param headers - Headers from the current event.
   * @param serial - Ably serial from the current event.
   */
  private _updateTurnObserverHeaders(
    turnId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): void {
    const existing = this._turnObservers.get(turnId);
    if (existing) {
      if (Object.keys(headers).length > 0) {
        Object.assign(existing.headers, headers);
      }
      // Always advance the serial so the tree node sorts after all
      // earlier messages in the turn (e.g. user-message relays that
      // arrive before the assistant response).
      if (serial !== undefined) {
        existing.serial = serial;
      }
    } else {
      this._turnObservers.set(turnId, {
        headers: { ...headers },
        serial,
        accumulator: this._codec.createAccumulator(),
      });
    }
  }

  /**
   * Process a streaming event through the turn's accumulator and emit the latest message.
   * @param turnId - The turn this event belongs to.
   * @param output - The decoded event output to accumulate.
   */
  private _accumulateAndEmit(turnId: string, output: DecoderOutput<TEvent, TMessage>): void {
    const observer = this._turnObservers.get(turnId);
    if (!observer) return;

    // Sync the accumulator with the tree before processing. If the message
    // was updated externally (via cross-turn events), initMessage syncs the
    // accumulator's state so the update isn't lost when processing
    // late turn events like finish-step/finish.
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
    this._logger.trace('ClientTransport._publishCancel();', { filter });

    const headers: Record<string, string> = {};
    if (filter.turnId) {
      headers[HEADER_CANCEL_TURN_ID] = filter.turnId;
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

  private _closeMatchingTurnStreams(filter: CancelFilter): void {
    // Only close the router streams here — do NOT clear _turnObservers.
    // The observer must remain alive so that late server events (e.g. abort,
    // x-ably-status: aborted) arriving before turn-end are still accumulated
    // into the message store. The turn-end handler cleans up observers.
    for (const turnId of this._getMatchingTurnIds(filter)) {
      this._router.closeStream(turnId);
    }
  }

  private _getMatchingTurnIds(filter: CancelFilter): Set<string> {
    const matched = new Set<string>();
    const activeTurns = this._tree.getActiveTurnIds();

    if (filter.all) {
      for (const turnIds of activeTurns.values()) {
        for (const turnId of turnIds) matched.add(turnId);
      }
    } else if (filter.own) {
      const ownTurns = activeTurns.get(this._clientId ?? '');
      if (ownTurns) {
        for (const turnId of ownTurns) matched.add(turnId);
      }
    } else if (filter.clientId) {
      const clientTurns = activeTurns.get(filter.clientId);
      if (clientTurns) {
        for (const turnId of clientTurns) matched.add(turnId);
      }
    } else if (filter.turnId) {
      // Check if the turnId exists in any client's turns
      for (const turnIds of activeTurns.values()) {
        if (turnIds.has(filter.turnId)) {
          matched.add(filter.turnId);
          break;
        }
      }
    }
    return matched;
  }

  // ---------------------------------------------------------------------------
  // Input message helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): View<TEvent, TMessage> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to create view; transport is closed', ErrorCode.TransportClosed, 400);
    }
    this._logger.trace('DefaultClientTransport.createView();');
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
  ): Promise<ActiveTurn<TEvent>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; transport is closed', ErrorCode.TransportClosed, 400);
    }
    await this._attachPromise;
    // CAST: re-check after await — close() may have been called while waiting for attach.
    // TypeScript's control flow narrows _closed to false after the first check, but the
    // await yields and close() can mutate _closed concurrently.
    if (this._closed as boolean) {
      throw new Ably.ErrorInfo('unable to send; transport is closed', ErrorCode.TransportClosed, 400);
    }

    const state = this._channel.state;
    if (state !== 'attached' && state !== 'attaching') {
      throw new Ably.ErrorInfo(`unable to send; channel is ${state}`, ErrorCode.ChannelNotReady, 400);
    }

    this._logger.trace('ClientTransport._internalSend();');

    const msgs = Array.isArray(input) ? input : [input];
    const turnId = crypto.randomUUID();
    this._ownTurnIds.add(turnId);
    this._tree.trackTurn(turnId, this._clientId ?? '');

    // Optimistic tree updates for cross-turn events — must happen before
    // capturing history so the POST body includes the updated message state.
    if (eventNodes) {
      for (const node of eventNodes) {
        const existingNode = this._tree.getNode(node.msgId);
        if (existingNode) {
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
    }

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
        turnId,
        msgId,
        turnClientId: this._clientId,
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

    this._turnMsgIds.set(turnId, msgIds);

    // Create ReadableStream via router
    const stream = this._router.createStream(turnId);

    // Resolve headers and body
    const resolvedHeaders = this._headersFn?.() ?? {};
    const resolvedBody = this._bodyFn?.() ?? {};

    const postBody: Record<string, unknown> = {
      ...resolvedBody,
      history: preInsertHistory,
      ...sendOptions?.body,
      turnId,
      clientId: this._clientId,
      messages: postMessages,
      ...(sendOptions?.forkOf !== undefined && { forkOf: sendOptions.forkOf }),
      ...(postParent !== undefined && { parent: postParent }),
      ...(eventNodes && eventNodes.length > 0 && { events: eventNodes }),
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
            ErrorCode.TransportSendFailed,
            response.status,
          );
          this._emitter.emit('error', err);
          this._router.errorStream(turnId, err);
        }
      })
      .catch((error: unknown) => {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        const err = new Ably.ErrorInfo(
          `unable to send; HTTP POST to ${this._api} failed: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.TransportSendFailed,
          500,
          cause,
        );
        this._emitter.emit('error', err);
        this._router.errorStream(turnId, err);
      });

    return {
      stream,
      turnId,
      cancel: async () => this.cancel({ turnId }),
      optimisticMsgIds: [...msgIds],
    };
  }

  // Spec: AIT-CT7, AIT-CT7a
  async cancel(filter?: CancelFilter): Promise<void> {
    if (this._closed) return;
    const resolved = filter ?? { own: true };
    this._logger.debug('ClientTransport.cancel();', { filter: resolved });
    await this._publishCancel(resolved);
    this._closeMatchingTurnStreams(resolved);
  }

  // Spec: AIT-CT18
  async waitForTurn(filter?: CancelFilter): Promise<void> {
    if (this._closed) return;
    const resolved = filter ?? { own: true };
    const remaining = this._getMatchingTurnIds(resolved);
    if (remaining.size === 0) return;

    this._logger.debug('ClientTransport.waitForTurn();', { turnIds: [...remaining] });

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = (): void => {
        if (resolved) return;
        resolved = true;
        unsub();
        const idx = this._closeResolvers.indexOf(done);
        if (idx !== -1) this._closeResolvers.splice(idx, 1);
        resolve();
      };

      const unsub = this._tree.on('turn', (event: TurnLifecycleEvent) => {
        if (event.type !== EVENT_TURN_END) return;
        remaining.delete(event.turnId);
        if (remaining.size === 0) done();
      });

      // Resolve on transport close to prevent leaked subscriptions
      this._closeResolvers.push(done);
    });
  }

  // Spec: AIT-CT8, AIT-CT8c, AIT-CT8d
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._closed) return noopUnsubscribe;
    // CAST: the overload signature enforces the correct handler type.
    const cb = handler as (arg: ClientTransportEventsMap[keyof ClientTransportEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // Spec: AIT-CT12, AIT-CT12a, AIT-CT12b, AIT-CT10c
  async close(options?: CloseOptions): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._logger.info('ClientTransport.close();');

    // Best-effort cancel publish before tearing down local state
    if (options?.cancel) {
      try {
        await this._publishCancel(options.cancel);
      } catch {
        // Swallow: cancel is best-effort during teardown
      }
      this._closeMatchingTurnStreams(options.cancel);
    }

    this._channel.unsubscribe(this._onMessage);
    this._channel.off(this._onChannelStateChange);

    // Close any remaining active streams
    for (const turnId of this._ownTurnIds) {
      this._router.closeStream(turnId);
    }

    this._turnObservers.clear();
    this._emitter.off();
    for (const v of this._views) v.close();
    this._views.clear();
    for (const resolve of this._closeResolvers) resolve();
    this._closeResolvers.length = 0;
    this._ownTurnIds.clear();
    this._ownMsgIds.clear();
    this._turnMsgIds.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a client-side transport that manages conversation state over an Ably channel.
 *
 * Subscribes to the channel immediately (before attach per RTL7g). The caller should
 * ensure the channel is attached or will be attached shortly after creation.
 * @param options - Configuration for the client transport.
 * @returns A new {@link ClientTransport} instance.
 */
export const createClientTransport = <TEvent, TMessage>(
  options: ClientTransportOptions<TEvent, TMessage>,
): ClientTransport<TEvent, TMessage> => new DefaultClientTransport(options);
