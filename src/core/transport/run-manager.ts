/**
 * Server-side run state management and lifecycle event publishing.
 *
 * Owns the authoritative run lifecycle. Tracks active runs with their
 * AbortControllers and clientIds. Publishes run-start, run-resume, run-suspend, and
 * run-end events on the Ably channel so all clients can react to run
 * state changes.
 */

import type * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  EVENT_STEP_END,
  EVENT_STEP_START,
} from '../../constants.js';
import type { Logger } from '../../logger.js';
import { buildLifecycleHeaders, buildStepHeaders } from './headers.js';
import type { RunEndReason, StepEndReason } from './types.js';

/**
 * Per-invocation metadata carried on a run's opening lifecycle event. A
 * continuation (re-entering an existing run) sets `continuation` and omits the
 * structural `parent` / `forkOf` / `regenerates` fields.
 */
interface StartRunMetadata {
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

/**
 * The invocation correlation and the three concentric client-identity scopes
 * (`run-client-id` ⊃ `invocationClientId` ⊃ `stepClientId`) stamped on a step's
 * `ai-step-start` / `ai-step-end`. Carried verbatim onto the wire by
 * {@link RunManager.startStep} / {@link RunManager.endStep}; the publisher
 * (the agent run) owns resolving them. Each field is optional and omitted from
 * the wire when unset.
 */
export interface StepClientScopes {
  /** The invocation-id the step is published under (correlation). */
  invocationId?: string;
  /** The run owner's clientId (the outermost client scope). */
  runClientId?: string;
  /** The current invocation's input publisher (stamped as `input-client-id`, the middle scope). */
  invocationClientId?: string;
  /** The step's client (the innermost scope; the participant whose incorporated input shapes the step). */
  stepClientId?: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages active runs and publishes run lifecycle events on the channel. */
export interface RunManager {
  /**
   * Seed a run's owner entry WITHOUT publishing any lifecycle event. Records the
   * run's `clientId` and `AbortController` in the active-run set so the
   * per-output `run-client-id` ({@link getClientId}) and the terminal
   * ({@link endRun} / {@link suspendRun}) stamp the real owner, and so
   * {@link close} aborts the run's controller. The `clientId` defaults to the
   * empty string when omitted; the controller defaults to a fresh one.
   *
   * This is the seed-only half of {@link startRun}: a process that adopts an
   * already-open run for publishing needs the owner entry but must NOT re-emit
   * the opening event. {@link startRun} is `registerRun` followed by the opening
   * publish. Calling it again for the same run replaces the existing entry.
   * @param runId - The run to seed.
   * @param clientId - The run owner's clientId (empty string when omitted).
   * @param controller - The run's AbortController (a fresh one when omitted).
   */
  registerRun(runId: string, clientId?: string, controller?: AbortController): void;
  /**
   * Register a run and publish its opening lifecycle event. Seeds the owner
   * entry (via {@link registerRun}) then publishes `ai-run-start` for a fresh
   * run, or `ai-run-resume` when `metadata.continuation` is set (a subsequent
   * invocation re-entering an existing run). A resume omits the structural
   * `parent` / `forkOf` / `regenerates` headers — the original run-start owns
   * the run's structure.
   */
  startRun(runId: string, clientId?: string, controller?: AbortController, metadata?: StartRunMetadata): Promise<void>;
  /**
   * Suspend a run. Publishes run-suspend on the channel and drops the run's
   * active-run entry — the agent process terminates on suspend, so there is no
   * live AbortController to retain. A cancel arriving during suspension is a
   * no-op; the resuming invocation re-registers the run via {@link startRun}.
   * Carries the same per-invocation attribution as {@link endRun}
   * (`inputClientId`, `inputCodecMessageId`), since a suspend is the terminal
   * event of the suspending invocation just as run-end is of an ending one.
   * When `consideredInputIds` is supplied and non-empty, it is stamped as the
   * `input-codec-message-ids` bracket receipt — the codec-message-ids of every
   * input the run's output has considered so far.
   */
  suspendRun(
    runId: string,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
    consideredInputIds?: string[],
  ): Promise<void>;
  /**
   * End a run. Publishes run-end on the channel (stamping `reason` as the
   * run-reason header) and drops the run's active-run entry. Carries the same
   * per-invocation attribution as {@link suspendRun} (`invocationId`,
   * `inputClientId`, `inputCodecMessageId`), since run-end is the terminal event
   * of the ending invocation. When `reason` is `'error'` and an `error` is
   * supplied, its `code` and `message` are additionally stamped as the
   * `error-code` / `error-message` headers — a codec-agnostic baseline failure
   * detail for consumers; omitting `error` publishes a bare `reason: 'error'`.
   * When `consideredInputIds` is supplied and non-empty, it is stamped as the
   * `input-codec-message-ids` bracket receipt — the codec-message-ids of every
   * input the run's output considered.
   */
  endRun(
    runId: string,
    reason: RunEndReason,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
    error?: Ably.ErrorInfo,
    consideredInputIds?: string[],
  ): Promise<void>;
  /**
   * Publish `ai-step-start` to open a step attempt within a run. Carries
   * `step-id` plus the step's invocation correlation and the three concentric
   * client-identity scopes ({@link StepClientScopes}). The published message's
   * channel serial IS the attempt's identity (its `step-start-serial`), returned to
   * the caller to back-reference on the step's output and `ai-step-end`. A retry
   * of a step publishes a fresh start with the same `stepId` and a new serial;
   * the latest-serial start is the canonical attempt.
   * @param runId - The run the step belongs to.
   * @param stepId - The step's id (stable across retry attempts).
   * @param scopes - The step's invocation + client-identity scopes, stamped on the wire.
   * @returns The published `ai-step-start`'s channel serial (the `step-start-serial`),
   *   or `undefined` when the publish returned no serial.
   */
  startStep(runId: string, stepId: string, scopes?: StepClientScopes): Promise<string | undefined>;
  /**
   * Publish `ai-step-end` to close a step attempt, back-referencing the
   * attempt's `step-start-serial` and stamping `step-reason` plus the same invocation
   * correlation and client-identity scopes ({@link StepClientScopes}) as the
   * matching `ai-step-start`.
   * @param runId - The run the step belongs to.
   * @param stepId - The step's id.
   * @param stepStartSerial - The attempt's `step-start-serial` (its `ai-step-start`'s serial).
   * @param reason - Why the step attempt ended.
   * @param scopes - The step's invocation + client-identity scopes, stamped on the wire.
   */
  endStep(
    runId: string,
    stepId: string,
    stepStartSerial: string,
    reason: StepEndReason,
    scopes?: StepClientScopes,
  ): Promise<void>;
  /** Get the clientId that owns a run. */
  getClientId(runId: string): string | undefined;
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

  registerRun(runId: string, clientId?: string, externalController?: AbortController): void {
    this._logger?.trace('DefaultRunManager.registerRun();', { runId, clientId });
    const controller = externalController ?? new AbortController();
    const resolvedClientId = clientId ?? '';
    this._activeRuns.set(runId, { controller, clientId: resolvedClientId });
  }

  async startRun(
    runId: string,
    clientId?: string,
    externalController?: AbortController,
    metadata?: StartRunMetadata,
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.startRun();', { runId, clientId });

    // Seed the owner entry first; the publish below opens the run on the wire.
    this.registerRun(runId, clientId, externalController);
    const resolvedClientId = clientId ?? '';

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
  }

  async suspendRun(
    runId: string,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
    consideredInputIds?: string[],
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.suspendRun();', { runId });
    await this._publishTerminal(EVENT_RUN_SUSPEND, runId, {
      invocationId,
      inputClientId,
      inputCodecMessageId,
      consideredInputIds,
    });
    this._logger?.debug('DefaultRunManager.suspendRun(); run suspended', { runId });
  }

  async endRun(
    runId: string,
    reason: RunEndReason,
    invocationId?: string,
    inputClientId?: string,
    inputCodecMessageId?: string,
    error?: Ably.ErrorInfo,
    consideredInputIds?: string[],
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.endRun();', { runId, reason });
    // Stamp error detail only for a terminal error the agent chose to surface
    // (AIT-ST6b4: explicit, never automatic). error-code / error-message are
    // generic transport headers, so any codec or consumer can read them.
    const errorAttribution = reason === 'error' && error ? { errorCode: error.code, errorMessage: error.message } : {};
    await this._publishTerminal(EVENT_RUN_END, runId, {
      reason,
      invocationId,
      inputClientId,
      inputCodecMessageId,
      consideredInputIds,
      ...errorAttribution,
    });
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
   * @param attribution.consideredInputIds - Codec-message-ids of every input the
   *   run's output considered, stamped as the `input-codec-message-ids` bracket
   *   receipt. Omitted when absent or empty.
   * @param attribution.errorCode - Numeric error code; set for run-end only when a terminal error is surfaced.
   * @param attribution.errorMessage - Error message; paired with errorCode.
   */
  private async _publishTerminal(
    eventName: string,
    runId: string,
    attribution: {
      reason?: RunEndReason;
      invocationId?: string;
      inputClientId?: string;
      inputCodecMessageId?: string;
      consideredInputIds?: string[];
      errorCode?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    const resolvedClientId = this._activeRuns.get(runId)?.clientId ?? '';
    const headers = buildLifecycleHeaders({ runId, runClientId: resolvedClientId, ...attribution });
    await this._channel.publish({ name: eventName, extras: { ai: { transport: headers } } });
    this._activeRuns.delete(runId);
  }

  async startStep(runId: string, stepId: string, scopes?: StepClientScopes): Promise<string | undefined> {
    this._logger?.trace('DefaultRunManager.startStep();', { runId, stepId });
    const headers = buildStepHeaders({ runId, stepId, ...scopes });
    const result = await this._channel.publish({ name: EVENT_STEP_START, extras: { ai: { transport: headers } } });
    // The step-start's own channel serial is the attempt's identity (its
    // `step-start-serial`); the caller back-references it on the step's output and
    // `ai-step-end`. May be undefined if the publish returned no serial.
    const stepStartSerial = result.serials[0] ?? undefined;
    this._logger?.debug('DefaultRunManager.startStep(); step started', { runId, stepId, stepStartSerial });
    return stepStartSerial;
  }

  async endStep(
    runId: string,
    stepId: string,
    stepStartSerial: string,
    reason: StepEndReason,
    scopes?: StepClientScopes,
  ): Promise<void> {
    this._logger?.trace('DefaultRunManager.endStep();', { runId, stepId, stepStartSerial, reason });
    const headers = buildStepHeaders({ runId, stepId, stepStartSerial, reason, ...scopes });
    await this._channel.publish({ name: EVENT_STEP_END, extras: { ai: { transport: headers } } });
    this._logger?.debug('DefaultRunManager.endStep(); step ended', { runId, stepId, stepStartSerial, reason });
  }

  getClientId(runId: string): string | undefined {
    return this._activeRuns.get(runId)?.clientId;
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
