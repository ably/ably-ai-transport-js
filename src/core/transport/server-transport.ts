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
  HEADER_MSG_ID,
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
  MessageWithHeaders,
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
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
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
    this._logger?.trace('DefaultServerTransport.close();');
    this._channel.unsubscribe(EVENT_CANCEL, this._channelListener);
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

  // Spec: AIT-ST8, AIT-ST9
  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getHeaders(msg);

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
    } = turnOpts;

    const controller = new AbortController();
    let started = false;
    let ended = false;

    // Register immediately so early cancels can fire the abort signal.
    const registration: RegisteredTurn = {
      turnId,
      clientId: turnClientId ?? '',
      controller,
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
        return controller.signal;
      },

      // Spec: AIT-ST4
      start: async (): Promise<void> => {
        logger?.trace('Turn.start();', { turnId });

        if (controller.signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to start turn; turn ${turnId} was cancelled before start()`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (started) return;
        started = true;

        try {
          await turnManager.startTurn(turnId, turnClientId, controller);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish turn-start for turn ${turnId}; ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.TurnLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Turn.start(); failed to publish turn-start', { turnId });
          turnOnError?.(errInfo);
          throw errInfo;
        }

        logger?.debug('Turn.start(); turn started', { turnId });
      },

      // Spec: AIT-ST5
      addMessages: async (
        inputs: MessageWithHeaders<TMessage>[],
        opts?: AddMessageOptions,
      ): Promise<AddMessagesResult> => {
        logger?.trace('Turn.addMessages();', { turnId, count: inputs.length });

        if (!started) {
          throw new Ably.ErrorInfo(
            `unable to add messages; start() must be called before addMessages() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        await attachPromise;

        const msgIds: string[] = [];

        for (const input of inputs) {
          const msgId = crypto.randomUUID();

          // Transport headers are the defaults; per-message headers from the
          // client override them. This lets the client's x-ably-msg-id pass
          // through for optimistic reconciliation with client inserts.
          const headers = mergeHeaders(
            buildTransportHeaders({
              role: 'user',
              turnId,
              msgId,
              turnClientId: opts?.clientId,
              // Per-operation options override turn-level defaults
              parent: opts?.parent === undefined ? (turnParent ?? undefined) : (opts.parent ?? undefined),
              forkOf: opts?.forkOf ?? turnForkOf,
            }),
            input.headers,
          );

          const encoder = codec.createEncoder(channel, {
            extras: { headers },
            onMessage,
          });

          await encoder.writeMessages([input.message], opts?.clientId ? { clientId: opts.clientId } : undefined);

          // Capture the effective msg-id after input.headers may have overridden it.
          msgIds.push(headers[HEADER_MSG_ID] ?? msgId);
        }

        logger?.debug('Turn.addMessages(); messages published', { turnId, count: inputs.length });
        return { msgIds };
      },

      // Spec: AIT-ST6
      streamResponse: async (
        stream: ReadableStream<TEvent>,
        streamOpts?: StreamResponseOptions,
      ): Promise<StreamResult> => {
        logger?.trace('Turn.streamResponse();', { turnId });

        if (!started) {
          throw new Ably.ErrorInfo(
            `unable to stream response; start() must be called before streamResponse() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        await attachPromise;

        const signal = turnManager.getSignal(turnId);
        const turnOwnerClientId = turnManager.getClientId(turnId);

        // Per-operation parent overrides the turn-level default.
        const assistantParent =
          streamOpts?.parent === undefined ? (turnParent ?? undefined) : (streamOpts.parent ?? undefined);

        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          turnId,
          msgId: crypto.randomUUID(),
          turnClientId: turnOwnerClientId,
          parent: assistantParent,
          forkOf: streamOpts?.forkOf ?? turnForkOf,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
        });

        const result = await pipeStream(stream, encoder, signal, onAbort, logger);

        logger?.debug('Turn.streamResponse(); stream finished', { turnId, reason: result.reason });
        return result;
      },

      // Spec: AIT-ST7
      end: async (reason: TurnEndReason): Promise<void> => {
        logger?.trace('Turn.end();', { turnId, reason });

        if (!started) {
          throw new Ably.ErrorInfo(
            `unable to end turn; start() must be called before end() (turn ${turnId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (ended) return;
        ended = true;

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
          turnOnError?.(errInfo);
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
