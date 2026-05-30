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
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
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
      inputClientId?: string;
      continuation?: boolean;
    },
  ): Promise<AbortSignal>;
  /** End a run. Publishes run-end on the channel. Cleans up internal state. */
  endRun(runId: string, reason: RunEndReason, invocationId?: string, inputClientId?: string): Promise<void>;
  /** Get the AbortSignal for a run. */
  getSignal(runId: string): AbortSignal | undefined;
  /** Get the clientId that owns a run. */
  getClientId(runId: string): string | undefined;
  /** Fire the AbortSignal for a run to cancel any in-flight work. */
  cancel(runId: string): void;
  /** Get all active run IDs. */
  getActiveRunIds(): string[];
  /** Cancel all active runs and clear state. */
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
      inputClientId?: string;
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
    if (metadata?.inputClientId !== undefined) {
      headers[HEADER_INPUT_CLIENT_ID] = metadata.inputClientId;
    }
    if (metadata?.continuation) {
      headers[HEADER_RUN_CONTINUE] = 'true';
    }

    await this._channel.publish({
      name: EVENT_RUN_START,
      extras: { ai: { transport: headers } },
    });

    this._logger?.debug('DefaultRunManager.startRun(); run started', { runId });
    return controller.signal;
  }

  async endRun(runId: string, reason: RunEndReason, invocationId?: string, inputClientId?: string): Promise<void> {
    this._logger?.trace('DefaultRunManager.endRun();', { runId, reason });

    const state = this._activeRuns.get(runId);
    const resolvedClientId = state?.clientId ?? '';

    const headers: Record<string, string> = {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: resolvedClientId,
      [HEADER_RUN_REASON]: reason,
    };
    // Mirror startRun: stamp invocation-id so the client's run-end gating
    // can match the terminating run-end against the invocation bound to the
    // active run (e.g. distinguishing a continuation from the run it
    // resumed under the same run-id).
    if (invocationId !== undefined) {
      headers[HEADER_INVOCATION_ID] = invocationId;
    }
    if (inputClientId !== undefined) {
      headers[HEADER_INPUT_CLIENT_ID] = inputClientId;
    }

    // Publish before deleting local state so that if publish fails,
    // the run remains in the active set and can be retried or cleaned up.
    await this._channel.publish({
      name: EVENT_RUN_END,
      extras: { ai: { transport: headers } },
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

  cancel(runId: string): void {
    this._logger?.debug('DefaultRunManager.cancel();', { runId });
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
