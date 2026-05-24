/**
 * Server-side run state management and lifecycle event publishing.
 *
 * Owns the authoritative run lifecycle. Tracks active runs with their
 * AbortControllers and clientIds. Publishes run-start and run-end events
 * on the Ably channel so all clients can react to run state changes.
 */

import type * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_ERROR_STATUS_CODE,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import type { Logger } from '../../logger.js';
import type { RunEndReason } from './types.js';

/**
 * Optional error payload stamped onto an `ai-run-end` event whose
 * `reason` is `'error'`. Carried on the wire via
 * {@link HEADER_ERROR_CODE} and {@link HEADER_ERROR_MESSAGE} so clients
 * can surface the underlying failure without an out-of-band signal.
 */
export interface EndRunError {
  /** Numeric Ably.ErrorInfo error code. Stringified onto the wire. */
  code: number;
  /** Optional HTTP-style status code. Currently echoed back via Ably.ErrorInfo on the receiver. */
  statusCode?: number;
  /** Human-readable error message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages active runs and publishes run lifecycle events on the channel. */
export interface RunManager {
  /** Register a new run. Publishes run-start on the channel. Returns AbortSignal. */
  startRun(
    runId: string,
    clientId?: string,
    controller?: AbortController,
    metadata?: {
      parent?: string;
      forkOf?: string;
      regenerates?: string;
      invocationId?: string;
      continuation?: boolean;
    },
  ): Promise<AbortSignal>;
  /**
   * End a run. Publishes run-end on the channel. Cleans up internal state.
   * @param runId - The run to end.
   * @param reason - Why the run ended.
   * @param invocationId - The invocation-id that this end belongs to.
   * @param error - When `reason === 'error'`, optional error metadata
   *   stamped onto the run-end event so the client can reconstruct the
   *   underlying failure.
   */
  endRun(runId: string, reason: RunEndReason, invocationId?: string, error?: EndRunError): Promise<void>;
  /** Get the AbortSignal for a run. */
  getSignal(runId: string): AbortSignal | undefined;
  /** Get the clientId that owns a run. */
  getClientId(runId: string): string | undefined;
  /** Abort the signal for a run. */
  abort(runId: string): void;
  /** Get all active run IDs. */
  getActiveRunIds(): string[];
  /** Abort all active runs and clear state. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveRunEntry {
  controller: AbortController;
  clientId: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DefaultRunManager implements RunManager {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _logger: Logger | undefined;
  private readonly _activeRuns = new Map<string, ActiveRunEntry>();

  constructor(channel: Ably.RealtimeChannel, logger?: Logger) {
    this._channel = channel;
    this._logger = logger?.withContext({ component: 'RunManager' });
  }

  async startRun(
    runId: string,
    clientId?: string,
    externalController?: AbortController,
    metadata?: {
      parent?: string;
      forkOf?: string;
      regenerates?: string;
      invocationId?: string;
      continuation?: boolean;
    },
  ): Promise<AbortSignal> {
    this._logger?.trace('DefaultRunManager.startRun();', { runId, clientId });

    const controller = externalController ?? new AbortController();
    const resolvedClientId = clientId ?? '';
    this._activeRuns.set(runId, { controller, clientId: resolvedClientId });

    const headers: Record<string, string> = {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: resolvedClientId,
    };
    if (metadata?.parent !== undefined) {
      headers[HEADER_PARENT] = metadata.parent;
    }
    if (metadata?.forkOf !== undefined) {
      headers[HEADER_FORK_OF] = metadata.forkOf;
    }
    if (metadata?.regenerates !== undefined) {
      headers[HEADER_MSG_REGENERATE] = metadata.regenerates;
    }
    // Stamp the invocation-id on run-start so the client's send() promise
    // can match it against its pending invocation and resolve. Without it
    // the client's run-start matcher (keyed by invocation-id) never fires
    // and send() hangs for the full runStartDeadlineMs.
    if (metadata?.invocationId !== undefined) {
      headers[HEADER_INVOCATION_ID] = metadata.invocationId;
    }
    if (metadata?.continuation) {
      headers[HEADER_RUN_CONTINUE] = 'true';
    }

    await this._channel.publish({
      name: EVENT_RUN_START,
      extras: { headers },
    });

    this._logger?.debug('DefaultRunManager.startRun(); run started', { runId });
    return controller.signal;
  }

  async endRun(runId: string, reason: RunEndReason, invocationId?: string, error?: EndRunError): Promise<void> {
    this._logger?.trace('DefaultRunManager.endRun();', { runId, reason });

    const state = this._activeRuns.get(runId);
    const resolvedClientId = state?.clientId ?? '';

    const headers: Record<string, string> = {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: resolvedClientId,
      [HEADER_RUN_REASON]: reason,
    };
    // Mirror startRun: stamp invocation-id so the client's defensive
    // run-end gating can distinguish winning from losing invocations
    // under the same run-id.
    if (invocationId !== undefined) {
      headers[HEADER_INVOCATION_ID] = invocationId;
    }
    // When the run is ending in error, fold the underlying ErrorInfo's
    // code, message, and (optional) statusCode onto the run-end event so
    // the client can rebuild it without an out-of-band signal.
    if (error) {
      headers[HEADER_ERROR_CODE] = String(error.code);
      headers[HEADER_ERROR_MESSAGE] = error.message;
      if (error.statusCode !== undefined) {
        headers[HEADER_ERROR_STATUS_CODE] = String(error.statusCode);
      }
    }

    // Publish before deleting local state so that if publish fails,
    // the run remains in the active set and can be retried or cleaned up.
    await this._channel.publish({
      name: EVENT_RUN_END,
      extras: { headers },
    });

    this._activeRuns.delete(runId);
    this._logger?.debug('DefaultRunManager.endRun(); run ended', { runId, reason });
  }

  getSignal(runId: string): AbortSignal | undefined {
    return this._activeRuns.get(runId)?.controller.signal;
  }

  getClientId(runId: string): string | undefined {
    return this._activeRuns.get(runId)?.clientId;
  }

  abort(runId: string): void {
    this._logger?.debug('DefaultRunManager.abort();', { runId });
    this._activeRuns.get(runId)?.controller.abort();
  }

  getActiveRunIds(): string[] {
    return [...this._activeRuns.keys()];
  }

  close(): void {
    this._logger?.trace('DefaultRunManager.close();', { activeRuns: this._activeRuns.size });
    for (const state of this._activeRuns.values()) {
      state.controller.abort();
    }
    this._activeRuns.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a run manager bound to the given channel.
 * @param channel - The Ably channel to publish lifecycle events on.
 * @param logger - Optional logger for diagnostic output.
 * @returns A new {@link RunManager} instance.
 */
export const createRunManager = (channel: Ably.RealtimeChannel, logger?: Logger): RunManager =>
  new DefaultRunManager(channel, logger);
