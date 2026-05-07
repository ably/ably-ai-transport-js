import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { Invocation } from '../invocation/index.js';
import { Invocation as InvocationCtor } from '../invocation/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { ControlSignal, Tree } from '../tree/index.js';
import type { Run, RunStatus } from './run.js';

/**
 * Run as seen from a {@link ClientSession}. Adds `toInvocation` and the
 * `abort` control method on top of the base {@link Run<TMessage>}.
 *
 * Returned by {@link ClientView.send}; the caller either calls
 * `run.toInvocation()` to produce a wake-up payload to POST to an agent,
 * or `run.abort()` to publish a durable abort control signal.
 */
export interface ClientRun<C extends AnyCodec> extends Run<CodecMessage<C>> {
  /**
   * Snapshot the run's current state into an {@link Invocation} the caller
   * can serialise and POST to an agent endpoint. Carries the session name,
   * this run's ID, and (when present) the message ID of the message that
   * opened the run, so the agent can wait for that message to be visible
   * before starting its step.
   * @returns A new {@link Invocation} bound to this run's preconditions.
   */
  toInvocation(): Invocation;

  /**
   * Abort this run by publishing an `x-ably-abort` control signal.
   * Observation of the signal does not change run status on its own —
   * the agent processing it publishes `run-end (aborted)`, and that
   * lifecycle wire is what transitions the run to `'aborted'`.
   *
   * Returns an {@link Invocation} the caller can POST to wake an
   * offline agent. With a live agent on the channel, the subscription
   * delivers the abort directly and POSTing is optional.
   *
   * No-op on already-terminal runs (`'aborted' | 'complete' | 'failed'`)
   * — multi-device idempotence. The returned `Invocation` is valid
   * regardless of the no-op path.
   * @returns The run's `Invocation` for the caller to POST.
   */
  abort(): Promise<Invocation>;

  /**
   * Retry this run by publishing an `x-ably-retry` control signal.
   * Publishes unconditionally regardless of current status — the
   * agent processing the signal opens a new step, and that step-start
   * is what re-activates the run from any prior terminal status.
   *
   * The returned {@link Invocation} carries the retry signal's wire
   * messageId as the precondition the agent waits for, plus the
   * `stepId` argument when supplied (so the agent can scope checkpoint
   * state lookup to the targeted step). POST it to wake the agent.
   * @param options Optional step-id for step-level retry.
   * @param options.stepId The id of a specific prior step to retry.
   *   When set, the agent uses it to scope checkpoint state lookup;
   *   the step's id rides on the signal wire and the produced
   *   `Invocation`. Omit for run-level retry.
   * @returns The retry-targeting `Invocation` for the caller to POST.
   */
  retry(options?: { stepId?: string }): Promise<Invocation>;

  /**
   * Pause this run by publishing an `x-ably-pause` control signal.
   * Observation of the signal does not change run status on its own —
   * the agent processing it lets the in-flight step run to completion
   * (mid-step interruption is not supported in this iteration), then
   * publishes `x-ably-run-suspend (paused)` which transitions the run
   * to `'suspended'`.
   *
   * Silent no-op when the run is already `'suspended'` or terminal —
   * publishing a pause then would have no observable effect. The
   * returned `Invocation` is valid regardless of the no-op path so
   * callers can blindly POST it to wake an agent.
   * @returns The run's `Invocation` for the caller to POST.
   */
  pause(): Promise<Invocation>;

  /**
   * Resume this run by publishing an `x-ably-resume` control signal.
   * Observation of the signal does not change run status on its own —
   * the agent processing it publishes a fresh `x-ably-step-start`
   * which transitions the run back to `'active'`.
   *
   * Silent no-op when the run is not currently `'suspended'` (i.e.
   * `'active'` or terminal). The returned `Invocation` is valid
   * regardless of the no-op path; POST it to wake an offline agent.
   * @returns The run's `Invocation` for the caller to POST.
   */
  resume(): Promise<Invocation>;

  /**
   * Resolve when the run's status enters any of the targeted set, or
   * reject with {@link ErrorCode.RunClosed} if the underlying session
   * closes first.
   *
   * Resolves synchronously (on the next microtask) when the run is
   * already in one of the targeted states. Otherwise subscribes to the
   * underlying tree and resolves the moment the run transitions into a
   * targeted state. Pass `['complete', 'failed', 'aborted']` for the
   * common "run is over" case.
   *
   * The returned promise is single-shot: subscribers are released as
   * soon as the promise settles. Repeat calls are safe — each gets its
   * own subscription.
   * @param statuses The run statuses to wait for. Empty arrays never
   *   resolve; the caller is responsible for not passing them.
   * @returns The status the run transitioned into.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.RunClosed}
   *   when the session closes before the run reaches a targeted state.
   */
  when(statuses: readonly RunStatus[]): Promise<RunStatus>;
}

/** Options for {@link createClientRun}. */
export interface ClientRunOptions<C extends AnyCodec> {
  /** The run's unique ID. */
  id: string;
  /** Initial run status — `view.send` always opens runs as `'active'`. */
  status: RunStatus;
  /** The clientId of the participant that opened the run. */
  initiatorClientId: string;
  /** The session this run belongs to; written into produced invocations. */
  sessionName: string;
  /**
   * The message ID published alongside `x-ably-run-start`. When present, an
   * agent receiving the produced {@link Invocation} can wait for this
   * message to be visible on the channel before starting its step.
   */
  messageId?: string;
  /** Tree the handle reads run state from for status and idempotence. */
  tree: Tree<CodecMessage<C>>;
  /** Writer used to publish `x-ably-abort` from {@link ClientRun.abort}. */
  writer: DefaultSessionWriter<C>;
  /**
   * Signal the run watches to detect "session is closed" while a
   * {@link ClientRun.when} promise is still pending. The owning session
   * fires this signal in its own `close()`; pending `when` promises
   * reject with {@link ErrorCode.RunClosed} immediately afterwards.
   * Optional so unit tests can construct a handle without a session.
   */
  closeSignal?: AbortSignal;
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link ClientRun} implementation. Lazy-reads run state from the
 * tree on each getter access (so `status` reflects the latest observed
 * lifecycle wire) and publishes through the session's writer on
 * `abort()` and `retry()`. The instance is constructed by
 * {@link DefaultClientView.send} after a successful run-start; it lives
 * for as long as the calling code holds the reference.
 * @internal
 */
class DefaultClientRun<C extends AnyCodec> implements ClientRun<C> {
  private readonly _id: string;
  private readonly _initialStatus: RunStatus;
  private readonly _initiatorClientId: string;
  private readonly _sessionName: string;
  private readonly _messageId?: string;
  private readonly _tree: Tree<CodecMessage<C>>;
  private readonly _writer: DefaultSessionWriter<C>;
  private readonly _closeSignal?: AbortSignal;
  private readonly _logger: Logger;

  constructor(options: ClientRunOptions<C>) {
    this._id = options.id;
    this._initialStatus = options.status;
    this._initiatorClientId = options.initiatorClientId;
    this._sessionName = options.sessionName;
    this._messageId = options.messageId;
    this._tree = options.tree;
    this._writer = options.writer;
    this._closeSignal = options.closeSignal;
    this._logger = options.logger.withContext({ component: 'ClientRun', runId: options.id });
    this._logger.trace('DefaultClientRun(); initialized');
  }

  get id(): string {
    return this._id;
  }

  get status(): RunStatus {
    // Read from the tree so observed lifecycle wires drive status
    // without a separate code path. Falls back to the local initial
    // status when the run-start hasn't echoed back through the decode
    // loop yet (publisher-only pre-echo hint; falls away once the wire
    // confirms).
    return this._tree.runs.find((r) => r.id === this._id)?.status ?? this._initialStatus;
  }

  get initiatorClientId(): string {
    return this._initiatorClientId;
  }

  get controlSignals(): readonly ControlSignal[] {
    return this._tree.runs.find((r) => r.id === this._id)?.controlSignals ?? [];
  }

  get pauseRequested(): boolean {
    return this._tree.runs.find((r) => r.id === this._id)?.pauseRequested ?? false;
  }

  toInvocation(): Invocation {
    return InvocationCtor.fromJSON({
      sessionName: this._sessionName,
      runId: this._id,
      ...(this._messageId === undefined ? {} : { messageId: this._messageId }),
    });
  }

  async abort(): Promise<Invocation> {
    this._logger.trace('DefaultClientRun.abort();');
    const status = this.status;
    if (status === 'aborted' || status === 'complete' || status === 'failed') {
      this._logger.debug('DefaultClientRun.abort(); run is terminal — no publish', {
        runId: this._id,
        status,
      });
      return this.toInvocation();
    }
    await this._writer.abort({ runId: this._id });
    return this.toInvocation();
  }

  async retry(options?: { stepId?: string }): Promise<Invocation> {
    this._logger.trace('DefaultClientRun.retry();', { stepId: options?.stepId });
    const { messageId } = await this._writer.retry({
      runId: this._id,
      ...(options?.stepId === undefined ? {} : { stepId: options.stepId }),
    });
    return InvocationCtor.fromJSON({
      sessionName: this._sessionName,
      runId: this._id,
      messageId,
      ...(options?.stepId === undefined ? {} : { stepId: options.stepId }),
    });
  }

  async pause(): Promise<Invocation> {
    // Spec: AIT-CS7a.
    this._logger.trace('DefaultClientRun.pause();');
    const status = this.status;
    if (status !== 'active') {
      // Pause only advances state from 'active' → 'suspended' (after the
      // agent observes and publishes run-suspend). Suspended runs have
      // already paused; terminal runs are done. Either way no signal is
      // published; the returned Invocation lets the caller blindly POST
      // without checking state.
      this._logger.debug('DefaultClientRun.pause(); run is not active — no publish', {
        runId: this._id,
        status,
      });
      return this.toInvocation();
    }
    const { messageId } = await this._writer.pause({ runId: this._id });
    return InvocationCtor.fromJSON({
      sessionName: this._sessionName,
      runId: this._id,
      messageId,
    });
  }

  async resume(): Promise<Invocation> {
    // Spec: AIT-CS7b.
    this._logger.trace('DefaultClientRun.resume();');
    const status = this.status;
    if (status !== 'suspended') {
      // Resume only advances state from 'suspended' → 'active'. An already-
      // active run has nothing to wake; a terminal run is done. Either way
      // no signal is published; the returned Invocation lets the caller
      // blindly POST without checking state.
      this._logger.debug('DefaultClientRun.resume(); run is not suspended — no publish', {
        runId: this._id,
        status,
      });
      return this.toInvocation();
    }
    const { messageId } = await this._writer.resume({ runId: this._id });
    return InvocationCtor.fromJSON({
      sessionName: this._sessionName,
      runId: this._id,
      messageId,
    });
  }

  async when(statuses: readonly RunStatus[]): Promise<RunStatus> {
    this._logger.trace('DefaultClientRun.when();', { statuses });

    // Synchronous check first so the common "already terminal" case
    // resolves on the next microtask without paying for a subscription.
    const current = this.status;
    if (statuses.includes(current)) {
      this._logger.debug('DefaultClientRun.when(); resolved synchronously', { status: current });
      return current;
    }

    // Pre-check the close signal — reject without subscribing if the
    // session has already closed. The close path otherwise lands as a
    // subscription event below.
    if (this._closeSignal?.aborted === true) {
      this._logger.debug('DefaultClientRun.when(); rejecting — session already closed');
      throw this._runClosedError();
    }

    return new Promise<RunStatus>((resolve, reject) => {
      let unsubscribeTree: (() => void) | undefined;
      let onClose: (() => void) | undefined;
      const cleanup = (): void => {
        unsubscribeTree?.();
        unsubscribeTree = undefined;
        if (onClose !== undefined && this._closeSignal !== undefined) {
          this._closeSignal.removeEventListener('abort', onClose);
          onClose = undefined;
        }
      };
      unsubscribeTree = this._tree.subscribe(() => {
        const next = this.status;
        if (statuses.includes(next)) {
          cleanup();
          this._logger.debug('DefaultClientRun.when(); resolved on tree change', { status: next });
          resolve(next);
        }
      });
      if (this._closeSignal !== undefined) {
        onClose = (): void => {
          cleanup();
          this._logger.warn('DefaultClientRun.when(); rejecting — session closed before status hit');
          reject(this._runClosedError());
        };
        this._closeSignal.addEventListener('abort', onClose, { once: true });
      }
    });
  }

  private _runClosedError(): Ably.ErrorInfo {
    return new Ably.ErrorInfo(
      `unable to await run status; session for run ${this._id} closed`,
      ErrorCode.RunClosed,
      400,
    );
  }
}

/**
 * Build a {@link ClientRun} handle. Returned by
 * {@link ClientView.send}; lazy-reads from the tree so multi-device
 * status (and tree-synthesised `'aborted'`) is reflected on every access.
 * @param options The run's identity, session binding, tree, and writer.
 * @returns A {@link ClientRun} bound to the supplied tree and writer.
 */
export const createClientRun = <C extends AnyCodec>(options: ClientRunOptions<C>): ClientRun<C> =>
  new DefaultClientRun<C>(options);
