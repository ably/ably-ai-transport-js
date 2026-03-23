/**
 * Server-side turn state management and lifecycle event publishing.
 *
 * Owns the authoritative turn lifecycle. Tracks active turns with their
 * AbortControllers and clientIds. Publishes turn-start and turn-end events
 * on the Ably channel so all clients can react to turn state changes.
 */

import type * as Ably from 'ably';

import {
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../constants.js';
import type { Logger } from '../../logger.js';
import type { TurnEndReason } from './types.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages active turns and publishes turn lifecycle events on the channel. */
export interface TurnManager {
  /** Register a new turn. Publishes turn-start on the channel. Returns AbortSignal. */
  startTurn(turnId: string, clientId?: string, controller?: AbortController): Promise<AbortSignal>;
  /** End a turn. Publishes turn-end on the channel. Cleans up internal state. */
  endTurn(turnId: string, reason: TurnEndReason): Promise<void>;
  /** Get the AbortSignal for a turn. */
  getSignal(turnId: string): AbortSignal | undefined;
  /** Get the clientId that owns a turn. */
  getClientId(turnId: string): string | undefined;
  /** Abort the signal for a turn. */
  abort(turnId: string): void;
  /** Get all active turn IDs. */
  getActiveTurnIds(): string[];
  /** Abort all active turns and clear state. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface TurnState {
  controller: AbortController;
  clientId: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DefaultTurnManager implements TurnManager {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _logger: Logger | undefined;
  private readonly _activeTurns = new Map<string, TurnState>();

  constructor(channel: Ably.RealtimeChannel, logger?: Logger) {
    this._channel = channel;
    this._logger = logger?.withContext({ component: 'TurnManager' });
  }

  async startTurn(turnId: string, clientId?: string, externalController?: AbortController): Promise<AbortSignal> {
    this._logger?.trace('DefaultTurnManager.startTurn();', { turnId, clientId });

    const controller = externalController ?? new AbortController();
    const resolvedClientId = clientId ?? '';
    this._activeTurns.set(turnId, { controller, clientId: resolvedClientId });

    await this._channel.publish({
      name: EVENT_TURN_START,
      extras: {
        headers: {
          [HEADER_TURN_ID]: turnId,
          [HEADER_TURN_CLIENT_ID]: resolvedClientId,
        },
      },
    });

    this._logger?.debug('DefaultTurnManager.startTurn(); turn started', { turnId });
    return controller.signal;
  }

  async endTurn(turnId: string, reason: TurnEndReason): Promise<void> {
    this._logger?.trace('DefaultTurnManager.endTurn();', { turnId, reason });

    const state = this._activeTurns.get(turnId);
    const resolvedClientId = state?.clientId ?? '';

    // Publish before deleting local state so that if publish fails,
    // the turn remains in the active set and can be retried or cleaned up.
    await this._channel.publish({
      name: EVENT_TURN_END,
      extras: {
        headers: {
          [HEADER_TURN_ID]: turnId,
          [HEADER_TURN_CLIENT_ID]: resolvedClientId,
          [HEADER_TURN_REASON]: reason,
        },
      },
    });

    this._activeTurns.delete(turnId);
    this._logger?.debug('DefaultTurnManager.endTurn(); turn ended', { turnId, reason });
  }

  getSignal(turnId: string): AbortSignal | undefined {
    return this._activeTurns.get(turnId)?.controller.signal;
  }

  getClientId(turnId: string): string | undefined {
    return this._activeTurns.get(turnId)?.clientId;
  }

  abort(turnId: string): void {
    this._logger?.debug('DefaultTurnManager.abort();', { turnId });
    this._activeTurns.get(turnId)?.controller.abort();
  }

  getActiveTurnIds(): string[] {
    return [...this._activeTurns.keys()];
  }

  close(): void {
    this._logger?.trace('DefaultTurnManager.close();', { activeTurns: this._activeTurns.size });
    for (const state of this._activeTurns.values()) {
      state.controller.abort();
    }
    this._activeTurns.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a turn manager bound to the given channel.
 * @param channel - The Ably channel to publish lifecycle events on.
 * @param logger - Optional logger for diagnostic output.
 * @returns A new {@link TurnManager} instance.
 */
export const createTurnManager = (channel: Ably.RealtimeChannel, logger?: Logger): TurnManager =>
  new DefaultTurnManager(channel, logger);
