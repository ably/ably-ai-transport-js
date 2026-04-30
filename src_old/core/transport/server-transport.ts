/**
 * Core server-side transport, parameterized by codec.
 *
 * Composes TurnManager and pipeStream to handle the full server-side turn
 * lifecycle. Cancel message routing is handled directly by the transport's
 * single channel subscription — no separate cancel manager needed.
 *
 * The transport exposes a single factory method — `newTurn()` — which returns
 * a Turn object with explicit lifecycle methods: start(), addMessages(),
 * streamResponse(), and end().
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_TURN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { getHeaders, mergeHeaders } from '../../utils.js';
import { buildTransportHeaders } from './headers.js';
import { pipeStream } from './pipe-stream.js';
import type { TurnManager } from './turn-manager.js';
import { createTurnManager } from './turn-manager.js';
import type {
  AddMessageOptions,
  AddMessagesResult,
  CancelFilter,
  CancelRequest,
  EventsNode,
  MessageNode,
  NewTurnOptions,
  ServerTransport,
  ServerTransportOptions,
  StreamResponseOptions,
  StreamResult,
  Turn,
  TurnEndReason,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal turn record for cancel routing
// ---------------------------------------------------------------------------

interface RegisteredTurn {
  turnId: string;
  clientId: string;
  controller: AbortController;
  /** Composite signal that fires when either the internal controller or the external signal aborts. */
  signal: AbortSignal;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
}

// ---------------------------------------------------------------------------
// Internal state machines
// ---------------------------------------------------------------------------

enum ServerTransportState {
  READY = 'ready',
  CLOSED = 'closed',
}

enum TurnState {
  INITIALIZED = 'initialized',
  STARTED = 'started',
  ENDED = 'ended',
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-ST1
class DefaultServerTransport<TEvent, TMessage> implements ServerTransport<TEvent, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ServerTransportOptions<TEvent, TMessage>['codec'];
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _turnManager: TurnManager;
  private readonly _registeredTurns = new Map<string, RegisteredTurn>();
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  private readonly _attachPromise: Promise<void>;

  private _state = ServerTransportState.READY;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: ServerTransportOptions<TEvent, TMessage>) {
    this._channel = options.channel;
    this._codec = options.codec;
    this._logger = options.logger?.withContext({ component: 'ServerTransport' });
    this._onError = options.onError;
    this._turnManager = createTurnManager(this._channel, this._logger);

    this._channelListener = (msg: Ably.InboundMessage) => {
      this._handleChannelMessage(msg);
    };

    // Spec: AIT-ST2
    // Subscribe before attach (RTL7g) — ensures no messages are missed.
    this._attachPromise = this._channel.subscribe(EVENT_CANCEL, this._channelListener).then(
      /* eslint-disable @typescript-eslint/no-empty-function -- discard subscription handle */
      () => {},
      /* eslint-enable @typescript-eslint/no-empty-function */
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to cancel messages; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.TransportSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger?.error('DefaultServerTransport(); subscribe failed');
        this._onError?.(errInfo);
      },
    );

    // Spec: AIT-ST12, AIT-ST12a
    // Listen for channel state changes that break message continuity. The
    // server only consumes cancel messages from the channel, so losing one
    // is survivable — but the developer needs to know so they can decide
    // whether to abort in-flight work. _hasAttachedOnce is seeded from the
    // channel's current state so pre-attached channels are handled correctly;
    // it distinguishes the initial attach from a genuine discontinuity.
    this._hasAttachedOnce = this._channel.state === 'attached';
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);

    this._logger?.debug('DefaultServerTransport(); transport created');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Spec: AIT-ST3
  newTurn(turnOpts: NewTurnOptions<TEvent>): Turn<TEvent, TMessage> {
    this._logger?.trace('DefaultServerTransport.newTurn();', { turnId: turnOpts.turnId });
    return this._createTurn(turnOpts);
  }

  // Spec: AIT-ST11
  close(): void {
    if (this._state === ServerTransportState.CLOSED) return;
    this._state = ServerTransportState.CLOSED;
    this._logger?.trace('DefaultServerTransport.close();');
    this._channel.unsubscribe(EVENT_CANCEL, this._channelListener);
    this._channel.off(this._onChannelStateChange);
    for (const reg of this._registeredTurns.values()) {
      reg.controller.abort();
    }
    this._registeredTurns.clear();
    this._turnManager.close();
    this._logger?.debug('DefaultServerTransport.close(); transport closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private _resolveFilter(filter: CancelFilter, senderClientId?: string): string[] {
    const turnIds = [...this._registeredTurns.keys()];

    if (filter.all) return turnIds;
    if (filter.own && senderClientId) {
      return turnIds.filter((id) => this._registeredTurns.get(id)?.clientId === senderClientId);
    }
    if (filter.clientId) {
      return turnIds.filter((id) => this._registeredTurns.get(id)?.clientId === filter.clientId);
    }
    if (filter.turnId && this._registeredTurns.has(filter.turnId)) {
      return [filter.turnId];
    }
    return [];
  }

  // Spec: AIT-ST8, AIT-ST8a, AIT-ST8b, AIT-ST8c, AIT-ST8d, AIT-ST9, AIT-ST9a
  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getHeaders(msg);

    // Spec: AIT-ST8a, AIT-ST8b, AIT-ST8c, AIT-ST8d
    const filter: CancelFilter = {};
    if (headers[HEADER_CANCEL_TURN_ID]) {
      filter.turnId = headers[HEADER_CANCEL_TURN_ID];
    } else if (headers[HEADER_CANCEL_OWN] === 'true') {
      filter.own = true;
    } else if (headers[HEADER_CANCEL_CLIENT_ID]) {
      filter.clientId = headers[HEADER_CANCEL_CLIENT_ID];
    } else if (headers[HEADER_CANCEL_ALL] === 'true') {
      filter.all = true;
    }

    const matchedTurnIds = this._resolveFilter(filter, msg.clientId);
    if (matchedTurnIds.length === 0) return;

    this._logger?.debug('DefaultServerTransport._handleCancelMessage(); matched turns', {
      matchedTurnIds,
      filter,
    });

    const owners = new Map<string, string>();
    for (const tid of matchedTurnIds) {
      const reg = this._registeredTurns.get(tid);
      owners.set(tid, reg?.clientId ?? '');
    }
    const request: CancelRequest = { message: msg, filter, matchedTurnIds, turnOwners: owners };

    for (const turnId of matchedTurnIds) {
      const reg = this._registeredTurns.get(turnId);
      if (!reg) continue;

      try {
        if (reg.onCancel) {
          const allowed = await reg.onCancel(request);
          if (!allowed) {
            this._logger?.debug('DefaultServerTransport._handleCancelMessage(); cancel rejected by onCancel', {
              turnId,
            });
            continue;
          }
        }
        reg.controller.abort();
        this._logger?.debug('DefaultServerTransport._handleCancelMessage(); turn aborted', { turnId });
      } catch (error) {
        // A throwing onCancel handler must not prevent other turns from being cancelled.
        const errInfo = new Ably.ErrorInfo(
          `unable to process cancel for turn ${turnId}; onCancel handler threw: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.CancelListenerError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger?.error('DefaultServerTransport._handleCancelMessage(); onCancel threw', { turnId });
        (reg.onError ?? this._onError)?.(errInfo);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Channel state change handler
  // -------------------------------------------------------------------------

  // Spec: AIT-ST12, AIT-ST12a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === ServerTransportState.CLOSED) return;

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

    this._logger?.error('DefaultServerTransport._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const err = new Ably.ErrorInfo(
      `unable to deliver cancel messages; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
      ErrorCode.ChannelContinuityLost,
      500,
      stateChange.reason,
    );

    // Transport-level notification only: continuity loss is not scoped to any
    // turn. Per-turn onError handlers are reserved for errors from that turn's
    // own operations (publish failures, encoder errors). Developers that need
    // per-turn reaction can iterate active turns from the transport handler.
    this._onError?.(err);
  }

  // -------------------------------------------------------------------------
  // Channel subscription handler
  // -------------------------------------------------------------------------

  private _handleChannelMessage(msg: Ably.InboundMessage): void {
    try {
      if (msg.name === EVENT_CANCEL) {
        // Fire-and-forget async handler — errors are caught internally.
        this._handleCancelMessage(msg).catch((error: unknown) => {
          const errInfo = new Ably.ErrorInfo(
            `unable to route cancel message; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.CancelListenerError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          this._logger?.error('DefaultServerTransport._handleChannelMessage(); cancel routing error');
          this._onError?.(errInfo);
        });
      }
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process channel message; ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.TransportSubscriptionError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultServerTransport._handleChannelMessage(); subscription error');
      this._onError?.(errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Turn creation
  // -------------------------------------------------------------------------

  private _createTurn(turnOpts: NewTurnOptions<TEvent>): Turn<TEvent, TMessage> {
    const {
      turnId,
      clientId: turnClientId,
      onMessage,
      onAbort,
      onCancel,
      onError: turnOnError,
      parent: turnParent,
      forkOf: turnForkOf,
      signal: externalSignal,
    } = turnOpts;

    const controller = new AbortController();
    let state = TurnState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) aborts the turn through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so early cancels can fire the abort signal.
    const registration: RegisteredTurn = {
      turnId,
      clientId: turnClientId ?? '',
      controller,
      signal,
      onCancel,
      onError: turnOnError,
    };
    this._registeredTurns.set(turnId, registration);

    // Capture instance members as locals so arrow functions close over them
    // without needing `this` (avoids unicorn/no-this-assignment).
    const logger = this._logger;
    const turnManager = this._turnManager;
    const attachPromise = this._attachPromise;
    const codec = this._codec;
    const channel = this._channel;
    const registeredTurns = this._registeredTurns;

    const turn: Turn<TEvent, TMessage> = {
      get turnId() {
        return turnId;
      },
      get abortSignal() {
        return signal;
      },

      // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
      start: async (): Promise<void> => {
        logger?.trace('Turn.start();', { turnId });

        // Spec: AIT-ST4a
        if (signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to start turn; turn ${turnId} was cancelled before start()`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state !== TurnState.INITIALIZED) return;
        state = TurnState.STARTED;

        try {
          await turnManager.startTurn(turnId, turnClientId, controller, {
            parent: turnParent,
            forkOf: turnForkOf,
          });
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish turn-start for turn ${turnId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TurnLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Turn.start(); failed to publish turn-start', { turnId });
          throw errInfo;
        }

        logger?.debug('Turn.start(); turn started', { turnId });
      },

      // Spec: AIT-ST5, AIT-ST5a, AIT-ST5b, AIT-ST5c
      addMessages: async (nodes: MessageNode<TMessage>[], opts?: AddMessageOptions): Promise<AddMessagesResult> => {
        logger?.trace('Turn.addMessages();', { turnId, count: nodes.length });

        if (state === TurnState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to add messages; start() must be called before addMessages() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        await attachPromise;

        const msgIds: string[] = [];

        try {
          for (const node of nodes) {
            // Build transport headers from the node's typed fields, then merge
            // any extra headers from the node (e.g. domain-specific headers).
            const headers = mergeHeaders(
              buildTransportHeaders({
                role: 'user',
                turnId,
                msgId: node.msgId,
                turnClientId: opts?.clientId,
                parent: node.parentId ?? turnParent,
                forkOf: node.forkOf ?? turnForkOf,
              }),
              node.headers,
            );

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            await encoder.writeMessages([node.message], opts?.clientId ? { clientId: opts.clientId } : undefined);

            msgIds.push(node.msgId);
          }
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish messages for turn ${turnId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TurnLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Turn.addMessages(); publish failed', { turnId });
          throw errInfo;
        }

        logger?.debug('Turn.addMessages(); messages published', { turnId, count: nodes.length });
        return { msgIds };
      },

      // Spec: AIT-ST5c
      addEvents: async (nodes: EventsNode<TEvent>[]): Promise<void> => {
        logger?.trace('Turn.addEvents();', { turnId, count: nodes.length });

        if (state === TurnState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to add events; start() must be called before addEvents() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        await attachPromise;

        const turnOwnerClientId = turnManager.getClientId(turnId);

        try {
          for (const node of nodes) {
            const headers = buildTransportHeaders({
              role: 'assistant',
              turnId,
              msgId: node.msgId,
              turnClientId: turnOwnerClientId,
              amend: node.msgId,
            });

            const encoder = codec.createEncoder(channel, {
              extras: { headers },
              onMessage,
            });

            for (const event of node.events) {
              await encoder.writeEvent(event);
            }

            await encoder.close();
          }
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish events for turn ${turnId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TurnLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Turn.addEvents(); publish failed', { turnId });
          throw errInfo;
        }

        logger?.debug('Turn.addEvents(); events published', { turnId, count: nodes.length });
      },

      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6b4, AIT-ST6c
      streamResponse: async (
        stream: ReadableStream<TEvent>,
        streamOpts?: StreamResponseOptions<TEvent>,
      ): Promise<StreamResult> => {
        logger?.trace('Turn.streamResponse();', { turnId });

        if (state === TurnState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to stream response; start() must be called before streamResponse() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        await attachPromise;

        const turnOwnerClientId = turnManager.getClientId(turnId);

        // Per-operation parent overrides the turn-level default.
        const assistantParent = streamOpts?.parent === undefined ? turnParent : streamOpts.parent;

        const msgId = crypto.randomUUID();
        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          turnId,
          msgId,
          turnClientId: turnOwnerClientId,
          parent: assistantParent,
          forkOf: streamOpts?.forkOf ?? turnForkOf,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: msgId,
        });

        const result = await pipeStream(stream, encoder, signal, onAbort, streamOpts?.resolveWriteOptions, logger);

        if (result.error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to stream response for turn ${turnId}; ${result.error.message}`,
            ErrorCode.StreamError,
            500,
            result.error instanceof Ably.ErrorInfo ? result.error : undefined,
          );
          logger?.error('Turn.streamResponse(); stream error', { turnId });
          turnOnError?.(errInfo);
        }

        logger?.debug('Turn.streamResponse(); stream finished', { turnId, reason: result.reason });
        return result;
      },

      // Spec: AIT-ST7, AIT-ST7a, AIT-ST7b
      end: async (reason: TurnEndReason): Promise<void> => {
        logger?.trace('Turn.end();', { turnId, reason });

        if (state === TurnState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to end turn; start() must be called before end() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state === TurnState.ENDED) return;
        state = TurnState.ENDED;

        try {
          await turnManager.endTurn(turnId, reason);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish turn-end for turn ${turnId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TurnLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Turn.end(); failed to publish turn-end', { turnId });
          throw errInfo;
        } finally {
          registeredTurns.delete(turnId);
        }

        logger?.debug('Turn.end(); turn ended', { turnId, reason });
      },
    };

    return turn;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a server transport bound to the given channel and codec.
 * @param options - Transport configuration.
 * @returns A new {@link ServerTransport} instance.
 */
export const createServerTransport = <TEvent, TMessage>(
  options: ServerTransportOptions<TEvent, TMessage>,
): ServerTransport<TEvent, TMessage> => new DefaultServerTransport(options);
