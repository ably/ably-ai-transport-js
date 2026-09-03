/**
 * The agent's per-run write handle.
 *
 * {@link DefaultAgentRunTransport} owns everything scoped to one run: the
 * publish gate, the loop driver behind `hasInput()`, the lazily-started step
 * wrapper, and the two terminal publishes. It composes its own step writer,
 * whose callbacks read the run's state through {@link RunGate} — that
 * indirection is what keeps the run and the writer from having to be
 * constructed in terms of each other.
 *
 * The transport owns everything outside one run: identity resolution, the
 * cancel-routing registries, and the opening publish. It hands the resolved
 * values here and gets a handle back.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import type { WireCodec } from '../codec/types.js';
import { publishLifecycleEvent } from './lifecycle-publish.js';
import type { RunManager, RunTerminalAttribution } from './run-manager.js';
import type { RunSteerTracker } from './run-steer-tracker.js';
import { createRunStepWriter, type RunStepWriter, stepEndReasonFor } from './run-step-writer.js';
import type {
  AgentRunTransport,
  OpenRunHooks,
  PipeSource,
  RunEndParams,
  RunEndResult,
  RunStepTransport,
  StepEndParams,
  StepEndResult,
  StepLifecycleEvent,
  StepOptions,
  StreamResult,
} from './types.js';

/**
 * A run's mutable publish state: the gate the output verbs are allowed through,
 * and whether the run has published anything yet.
 *
 * Split out from the handle because the run's step writer has to read it too,
 * through the `assertPublishable` and `markOutputProduced` callbacks. Sharing
 * this small object means the handle can build its writer in its constructor
 * without either one being half-initialised.
 */
export class RunGate {
  /** 'open' accepts output, 'suspended' blocks it until `resume()`, 'ended' is terminal. */
  private _state: 'open' | 'suspended' | 'ended' = 'open';
  /** Whether a step attempt has opened, which is what marks the run as having answered its trigger. */
  private _hasProducedOutput = false;

  /** @returns The gate's current state. */
  get state(): 'open' | 'suspended' | 'ended' {
    return this._state;
  }

  /** @returns True once a step attempt has opened on this run. */
  get hasProducedOutput(): boolean {
    return this._hasProducedOutput;
  }

  /** Record that a step attempt opened, so the initial-response pass stops firing. */
  markOutputProduced(): void {
    this._hasProducedOutput = true;
  }

  /**
   * Move the gate to a new state. The caller sequences this against its
   * publish: a terminal closes the gate first, and a suspend or resume only
   * moves it once the publish lands.
   * @param state - The state to move to.
   */
  moveTo(state: 'open' | 'suspended' | 'ended'): void {
    this._state = state;
  }

  /**
   * Throw if the run is not open for publishing. The run owns this policy; its
   * writer only gates on it.
   * @param verb - The calling verb, selecting the action named in the message.
   * @param runId - The run's id, named in the message.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the run is suspended or ended.
   */
  assertPublishable(verb: 'pipe' | 'step' | 'send', runId: string): void {
    if (this._state === 'open') return;
    const action = verb === 'pipe' ? 'pipe stream' : verb === 'step' ? 'run step' : 'send output';
    throw new Ably.ErrorInfo(
      this._state === 'suspended'
        ? `unable to ${action}; run ${runId} is suspended`
        : `unable to ${action}; run ${runId} has already ended`,
      ErrorCode.InvalidArgument,
      400,
    );
  }
}

/**
 * Options for {@link DefaultAgentRunTransport}. The transport resolves every
 * one of these before the run exists; the handle only reads them.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface AgentRunTransportOptions<TInput, TOutput> {
  /** The run's resolved id. */
  runId: string;
  /** The invocation's resolved id, scoping default step-ids and stamped on every publish. */
  invocationId: string;
  /** The triggering input's transport-message-id, when known. Anchors output and both terminals. */
  inputTransportMessageId?: string;
  /** The triggering input's publisher, stamped as `input-client-id` so several clients agree which owns the run. */
  inputClientId?: string;
  /** The agent's own Ably `clientId`, for the run manager's owner entry on a resume. */
  clientId?: string;
  /** The shared Ably channel the run's encoder publishes to. */
  channel: Ably.RealtimeChannel;
  /** The wire tier of the codec, used to create a per-stream encoder. */
  codec: WireCodec<TInput, TOutput>;
  /** The run manager, which publishes lifecycle events and holds the run owner's client-id. */
  runManager: RunManager;
  /** Resolves once the opening publish has landed. Every output verb awaits it, so `ai-run-start` precedes the first `ai-output`. */
  opened: Promise<void>;
  /** The run's abort signal: its own cancel controller combined with any caller-supplied one. */
  signal: AbortSignal;
  /** The run's steer state, already seeded with any steers that landed before the run registered. */
  steerTracker: RunSteerTracker;
  /** The caller's per-run callbacks. */
  hooks: OpenRunHooks<TOutput>;
  /**
   * Emit the writer's optimistic step-lifecycle seed. The transport re-emits it
   * on its own receive stream, so a subscriber sees the bracket before the wire
   * echo and reconciles by `stepStartSerial`.
   * @param event - The optimistic step-start / step-end event.
   */
  emitStepLifecycle: (event: StepLifecycleEvent) => void;
  /**
   * Drop the run from the transport's cancel-routing registries. Called once
   * the run is terminal, before the terminal publish completes — a terminal run
   * receives no further signals even while its publish is in flight.
   */
  deregister: () => void;
  /** The transport's contexted logger. */
  logger: Logger;
}

/** Default {@link AgentRunTransport}. See the file header for the split. */
export class DefaultAgentRunTransport<TInput, TOutput> implements AgentRunTransport<TOutput> {
  private readonly _runId: string;
  private readonly _invocationId: string;
  private readonly _inputTransportMessageId: string | undefined;
  private readonly _inputClientId: string | undefined;
  private readonly _clientId: string | undefined;
  private readonly _runManager: RunManager;
  private readonly _opened: Promise<void>;
  private readonly _signal: AbortSignal;
  private readonly _steerTracker: RunSteerTracker;
  private readonly _deregister: () => void;
  private readonly _logger: Logger;
  private readonly _gate = new RunGate();
  private readonly _stepWriter: RunStepWriter<TOutput>;

  constructor(options: AgentRunTransportOptions<TInput, TOutput>) {
    this._runId = options.runId;
    this._invocationId = options.invocationId;
    this._inputTransportMessageId = options.inputTransportMessageId;
    this._inputClientId = options.inputClientId;
    this._clientId = options.clientId;
    this._runManager = options.runManager;
    this._opened = options.opened;
    this._signal = options.signal;
    this._steerTracker = options.steerTracker;
    this._deregister = options.deregister;
    this._logger = options.logger;
    this._stepWriter = createRunStepWriter<TInput, TOutput>({
      getRunId: () => this._runId,
      invocationId: options.invocationId,
      codec: options.codec,
      channel: options.channel,
      runManager: options.runManager,
      emitStepLifecycle: options.emitStepLifecycle,
      // The caller's per-run hooks, `onError` included: the writer fires it
      // with a wrapped pipe stream failure alongside the `StreamResult.error`
      // return.
      hooks: options.hooks,
      signal: options.signal,
      markOutputProduced: () => {
        this._gate.markOutputProduced();
      },
      consumeSteerStampIds: () => this._steerTracker.consumeRecentlyProcessed(),
      logger: options.logger,
      // The output verbs await the opening publish so `ai-run-start` precedes
      // the first `ai-output` on the wire.
      requireConnected: async () => {
        await this._opened;
      },
      assertPublishable: (verb) => {
        this._gate.assertPublishable(verb, this._runId);
      },
      // The anchors come straight from the open options — there is no
      // triggering-input resolution here (a durable agent reads it via
      // locateInput and threads it through openRun itself).
      getAnchors: () => ({
        inputClientId: this._inputClientId,
        inputTransportMessageId: this._inputTransportMessageId,
      }),
    });
  }

  get runId(): string {
    return this._runId;
  }

  get opened(): Promise<void> {
    return this._opened;
  }

  get abortSignal(): AbortSignal {
    return this._signal;
  }

  get pipe(): (source: PipeSource<TOutput>) => Promise<StreamResult> {
    return this._stepWriter.pipe;
  }

  hasInput(): boolean {
    // Loop driver: run at least once for the triggering input, then again for
    // each steering message tracked since the previous pass. A cancel (aborted
    // signal) stops the loop. Reading DRAINS pending steers into the set the
    // next step attempt stamps, so there is no observe-only check.
    if (this._signal.aborted) return false;
    const hadPending = this._steerTracker.hasPending();
    if (hadPending) this._steerTracker.drainPending();
    if (!this._gate.hasProducedOutput) return true;
    return hadPending;
  }

  createStep(stepOpts?: StepOptions): RunStepTransport<TOutput> {
    const step = this._stepWriter.createStep(stepOpts);
    let starting: Promise<void> | undefined;
    // One shared in-flight start, cleared again if it fails. A latched but
    // failed start would make every later pipe/send reject with "call
    // start() first", which this wrapper's caller cannot act on because the
    // surface exposes no start(); clearing it lets the next call retry.
    const ensureStarted = async (): Promise<void> => {
      starting ??= (async () => {
        try {
          await step.start();
        } catch (error) {
          starting = undefined;
          throw error;
        }
      })();
      await starting;
    };
    return {
      get stepId() {
        return step.stepId;
      },
      pipe: async (source: PipeSource<TOutput>): Promise<StreamResult> => {
        await ensureStarted();
        return step.pipe(source);
      },
      send: async (event: TOutput): Promise<void> => {
        await ensureStarted();
        await step.send(event);
      },
      end: async (params?: StepEndParams): Promise<StepEndResult> => step.end(params),
    };
  }

  async suspend(): Promise<void> {
    this._logger.trace('AgentRunTransport.suspend();', { runId: this._runId });
    if (this._gate.state !== 'open') return;
    // A suspend mid-step would strand the open step (no `ai-step-end` before
    // the run pauses); require the caller to end it first. Unlike end, suspend
    // does not auto-close — a resumed run may continue the step.
    if (this._stepWriter.hasActiveStep()) {
      throw new Ably.ErrorInfo(
        `unable to suspend run; end the active step before suspending (run ${this._runId})`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    await publishLifecycleEvent(
      {
        phase: 'run-suspend',
        component: 'AgentRunTransport',
        method: 'suspend',
        runId: this._runId,
        logger: this._logger,
      },
      async () => this._runManager.suspendRun(this._runId, this._terminalAttribution()),
    );
    // Only after the publish lands, matching `resume()`: a failed suspend
    // leaves the run open, so the local gate must not close ahead of it.
    this._gate.moveTo('suspended');
  }

  async resume(): Promise<void> {
    this._logger.trace('AgentRunTransport.resume();', { runId: this._runId });
    if (this._gate.state === 'ended') {
      throw new Ably.ErrorInfo(
        `unable to resume run; run ${this._runId} has already ended`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    // A pure re-entry signal: republish `ai-run-resume` under the same run-id
    // as a bare re-entry signal (continuation). The gate re-opens only once
    // the publish succeeds, so a failed resume leaves the run suspended.
    await publishLifecycleEvent(
      {
        phase: 'run-resume',
        component: 'AgentRunTransport',
        method: 'resume',
        runId: this._runId,
        logger: this._logger,
      },
      async () =>
        this._runManager.startRun(this._runId, this._clientId, {
          invocationId: this._invocationId,
          continuation: true,
        }),
    );
    this._gate.moveTo('open');
  }

  async end(params: RunEndParams): Promise<RunEndResult> {
    this._logger.trace('AgentRunTransport.end();', { runId: this._runId, reason: params.reason });
    // Terminal and idempotent: a second call publishes nothing, so it has no
    // acknowledgement to report.
    if (this._gate.state === 'ended') return { serial: undefined };
    this._gate.moveTo('ended');
    // The run stops receiving signals the moment it is terminal, even if the
    // terminal publish below is still in flight.
    this._deregister();
    // Auto-close any still-open step first so its `ai-step-end` precedes this
    // `ai-run-end` on the wire and no observer is stranded. Best-effort — a
    // step-close failure must not block the run terminal.
    try {
      await this._stepWriter.closeActiveStep(stepEndReasonFor(params.reason));
    } catch (closeError) {
      // Best-effort and deliberately tolerated: a step-close failure must not
      // block the run terminal, so this log is its only record.
      this._logger.warn('AgentRunTransport.end(); failed to auto-close active step', {
        runId: this._runId,
        error: errorMessage(closeError),
      });
    }
    const error = params.reason === 'error' ? params.error : undefined;
    const serial = await publishLifecycleEvent(
      { phase: 'run-end', component: 'AgentRunTransport', method: 'end', runId: this._runId, logger: this._logger },
      async () => this._runManager.endRun(this._runId, params.reason, this._terminalAttribution(), error),
    );
    return { serial };
  }

  /**
   * The attribution both terminals carry, matching what `ai-run-start`
   * stamped. `input-client-id` is what lets several clients on one channel
   * agree which of them owns the run, so a terminal that dropped it would
   * leave a late-joining client unable to resolve the owner from the run's own
   * lifecycle events.
   *
   * `consideredInputIds` is `undefined` until the run has produced output — a
   * run that published nothing considered nothing, so its bracket claims
   * nothing.
   * @returns The terminal attribution for this run.
   */
  private _terminalAttribution(): RunTerminalAttribution {
    return {
      invocationId: this._invocationId,
      inputClientId: this._inputClientId,
      inputTransportMessageId: this._inputTransportMessageId,
      consideredInputIds: this._gate.hasProducedOutput ? this._steerTracker.consideredIds() : undefined,
    };
  }
}
