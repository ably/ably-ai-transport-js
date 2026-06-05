/**
 * Server-side run state management and lifecycle event publishing.
 *
 * Owns the authoritative run lifecycle. Tracks active runs with their
 * AbortControllers and clientIds. Publishes run-start, run-suspend, and
 * run-end events on the Ably channel so all clients can react to run state
 * changes.
 */

import type * as Ably from 'ably';

import { EVENT_RUN_END, EVENT_RUN_RESUME, EVENT_RUN_START, EVENT_RUN_SUSPEND } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { buildLifecycleHeaders } from './headers.js';
import type { RunEndReason } from './types.js';

/**
 * Per-invocation metadata carried on a run's opening lifecycle event. A
 * continuation (re-entering an existing run) sets `continuation` and omits the
 * structural `parent` / `forkOf` / `regenerates` fields.
 */
export interface StartRunMetadata {
  /** Structural parent codec-message-id (fresh run-start only). */
  parent?: string;
  /** Forked user-prompt codec-message-id for an edit (fresh run-start only). */
  forkOf?: string;
  /** Regenerated assistant codec-message-id (fresh run-start only). */
  regenerates?: string;
  /** Agent-minted invocation id, carried on the lifecycle event. */
  invocationId?: string;
  /** ClientId of the triggering input event. */
  inputClientId?: string;
  /** Codec-message-id of the triggering input event. */
  inputCodecMessageId?: string;
  /** When true, publish `ai-run-resume` (re-entry) instead of `ai-run-start`. */
  continuation?: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages active runs and publishes run lifecycle events on the channel. */
export interface RunManager {
  /**
   * Register a run and publish its opening lifecycle event. Publishes
   * `ai-run-start` for a fresh run, or `ai-run-resume` when `metadata.continuation`
   * is set (a subsequent invocation re-entering an existing run). A resume omits
   * the structural `parent` / `forkOf` / `regenerates` headers — the original
   * run-start owns the run's structure. Returns the run's AbortSignal.
   */
  startRun(
    runId: string,
    clientId?: string,
    controller?: AbortController,
    metadata?: StartRunMetadata,
  ): Promise<AbortSignal>;
  /**
   * Suspend a run. Publishes run-suspend on the channel and drops the run's
   * active-run entry — the agent process terminates on suspend, so there is no
   * live AbortController to retain. A cancel arriving during suspension is a
   * no-op; the resuming invocation re-registers the run via {@link startRun}.
   * Carries the same per-invocation attribution as {@link endRun}
   * (`inputClientId`, `inputCodecMessageId`), since a suspend is the terminal
   * event of the suspending invocation just as run-end is of an ending one.
   */
  suspendRun(runId: string, invocationId?: string, inputClientId?: string, inputCodecMessageId?: string): Promise<void>;
  /** End a run. Publishes run-end on the channel. Cleans up internal state. */
  endRun(
    runId: string,
    reason: RunEndReason,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
  ): Promise<void>;
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
    metadata?: StartRunMetadata,
  ): Promise<AbortSignal> {
    this._logger?.trace('DefaultRunManager.startRun();', { runId, clientId });

    const controller = externalController ?? new AbortController();
    const resolvedClientId = clientId ?? '';
    this._activeRuns.set(runId, { controller, clientId: resolvedClientId });

    // A continuation re-enters an already-started run: publish `ai-run-resume`
    // rather than `ai-run-start`. Resume is a pure re-entry signal — the
    // original run-start already established the run's structure, so the
    // parent / forkOf / regenerates metadata is NOT re-stamped here (doing so
    // would point the run at content within itself). The agent learned this is
    // a continuation from the run-id on the triggering input; the re-entry is
    // conveyed to clients by the event name, not a header echo. The
    // invocation-id / input attribution headers are carried on both.
    const continuation = metadata?.continuation === true;

    const headers = buildLifecycleHeaders({
      runId,
      runClientId: resolvedClientId,
      parent: continuation ? undefined : metadata?.parent,
      forkOf: continuation ? undefined : metadata?.forkOf,
      regenerates: continuation ? undefined : metadata?.regenerates,
      invocationId: metadata?.invocationId,
      inputClientId: metadata?.inputClientId,
      inputCodecMessageId: metadata?.inputCodecMessageId,
    });

    await this._channel.publish({
      name: continuation ? EVENT_RUN_RESUME : EVENT_RUN_START,
      extras: { ai: { transport: headers } },
    });

    this._logger?.debug('DefaultRunManager.startRun(); run started', { runId });
    return controller.signal;
  }

  async suspendRun(
    runId: string,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.suspendRun();', { runId });
    await this._publishTerminal(EVENT_RUN_SUSPEND, runId, { invocationId, inputClientId, inputCodecMessageId });
    this._logger?.debug('DefaultRunManager.suspendRun(); run suspended', { runId });
  }

  async endRun(
    runId: string,
    reason: RunEndReason,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.endRun();', { runId, reason });
    await this._publishTerminal(EVENT_RUN_END, runId, { reason, invocationId, inputClientId, inputCodecMessageId });
    this._logger?.debug('DefaultRunManager.endRun(); run ended', { runId, reason });
  }

  /**
   * Publish a run's terminal lifecycle event (run-suspend or run-end) and drop
   * its active-run entry. Both events are the suspending/ending invocation's
   * terminal signal, carrying the same per-invocation correlation; they differ
   * only by event name and the run-reason header (run-end). Publishes BEFORE
   * dropping local state so a publish failure leaves the run in the active set.
   * @param eventName - The lifecycle event to publish (run-suspend or run-end).
   * @param runId - The run being suspended or ended.
   * @param attribution - Per-invocation correlation and the terminal reason.
   * @param attribution.reason - Terminal reason; set for run-end, omitted for run-suspend.
   * @param attribution.invocationId - The invocation's id.
   * @param attribution.inputClientId - ClientId of the triggering input event.
   * @param attribution.inputCodecMessageId - Codec-message-id of the triggering input event.
   */
  private async _publishTerminal(
    eventName: string,
    runId: string,
    attribution: {
      reason?: RunEndReason;
      invocationId?: string;
      inputClientId?: string;
      inputCodecMessageId?: string;
    },
  ): Promise<void> {
    const resolvedClientId = this._activeRuns.get(runId)?.clientId ?? '';
    const headers = buildLifecycleHeaders({ runId, runClientId: resolvedClientId, ...attribution });
    await this._channel.publish({ name: eventName, extras: { ai: { transport: headers } } });
    this._activeRuns.delete(runId);
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
