import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { isAbortSignalError } from '../abort-error.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { Step } from '../step/index.js';
import { DefaultStep } from '../step/index.js';
import type { ControlSignal, MessageNode, Tree } from '../tree/index.js';
import type { AgentView } from '../view/index.js';
import { DefaultAgentView } from '../view/index.js';
import type { Run, RunEndStatus, RunStatus } from './run.js';

/**
 * Run as seen from an {@link AgentSession}. Adds `view`, `messages`,
 * `end`, `suspend`, the async disposer, and `createStep` on top of the
 * base {@link Run}. `lastStep`, `when`, and run-level
 * `sendMessages`/`sendParts`/`sendEvents` land in later phases.
 *
 * Returned by {@link AgentSession.createRun}.
 */
export interface AgentRun<C extends AnyCodec> extends Run<CodecMessage<C>> {
  /**
   * The linear read projection the agent passes to the model: every
   * message on the session's tree, in serial order, regardless of which
   * run produced it. This is what the model needs as conversation
   * context, so multi-turn sessions see the full history (each turn
   * opens a new run on the wire). Subscribe via `run.view.subscribe(...)`
   * to observe ancestry fill-in and steering messages that arrive
   * mid-execution.
   *
   * Branching (regenerate/edit) is not yet implemented — once it is,
   * this projection will switch to walking the run-parent chain rather
   * than returning the entire tree.
   */
  readonly view: AgentView<C>;

  /**
   * Messages published within this run, filtered from the session's tree
   * by the run's id. The run-scoped view of "what did this run produce";
   * use {@link AgentRun.view} to read the conversation as a whole.
   */
  readonly messages: readonly MessageNode<CodecMessage<C>>[];

  /**
   * Finalise the run. The classifier picks the wire status from the
   * caller's error (or absence):
   *
   * | Inputs                            | Wire status  |
   * | --------------------------------- | ------------ |
   * | No error                          | `'complete'` |
   * | Error, signal-driven              | `'aborted'`  |
   * | Error, otherwise                  | `'failed'`   |
   *
   * "Signal-driven" means a web-standard `AbortError` — what
   * `AbortSignal`-driven paths throw, including model SDKs whose
   * `abortSignal` was wired to `step.signal` and the abort observed
   * during the step's lifetime fires it. Any other error routes to
   * `'failed'` so the run remains retryable.
   *
   * Status is decided purely from `error` — observation of an abort
   * signal on the channel does not preempt the classifier. The
   * classifier reads inputs the SDK already holds and produces the
   * lifecycle wire that actually transitions run status.
   *
   * Idempotent — a second call after the first has resolved is a no-op
   * and resolves `void`. Does not close the run's view; pair with the
   * async disposer (or call `view.close()` directly) to release local
   * resources.
   * @param error The caught error, or omitted on the happy path.
   * @returns Resolves once Ably has acknowledged the publish (or
   *   immediately when the run is already terminal locally).
   */
  end(error?: unknown): Promise<void>;

  /**
   * Suspend the run. Publishes `x-ably-run-suspend` carrying
   * `x-ably-status: 'paused'`. Receivers transition the run to
   * `'suspended'`; a later `x-ably-step-start` re-activates it.
   *
   * Independent of {@link Run.pauseRequested} — the agent may suspend
   * a run that has not received a pause request (orchestrator-driven
   * suspend), and may complete the run normally despite a pending
   * pause request. {@link end} never auto-routes to suspend.
   *
   * Throws {@link ErrorCode.RunAlreadySuspended} when called on a run
   * already in `'suspended'`, and {@link ErrorCode.RunAlreadyTerminal}
   * when called on a terminal run. Suspend is forward motion; both
   * states make the call meaningless and are flagged loudly so the
   * orchestration bug is visible.
   * @returns Resolves once Ably has acknowledged the publish.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.RunAlreadySuspended} when the run is already
   *   suspended.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.RunAlreadyTerminal} when the run is already
   *   terminal (`'complete'`/`'failed'`/`'aborted'`).
   */
  suspend(): Promise<void>;

  /**
   * Release the run handle: call {@link end} if the run hasn't been ended
   * yet, then close the underlying {@link AgentView}. Provided so callers
   * who don't use `await using` syntax can still drive the same teardown
   * explicitly:
   *
   * ```ts
   * try { ... } finally { await run.close(); }
   * ```
   *
   * If {@link end} was already called, `close` skips publishing and only
   * closes the view. Idempotent.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to {@link close}. Enables
   * scope-based cleanup in serverless handlers:
   *
   * ```ts
   * await using run = session.createRun(invocation);
   * ```
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Create a new {@link Step} bound to this run. Phase 9 subset — the
   * returned handle owns its own freshly generated id and exposes
   * {@link Step.start}; the rest of the step surface (`pipe`, `end`,
   * `signal`, etc.) lands in later phases.
   * @returns A `'pending'` step handle ready for {@link Step.start}.
   */
  createStep(): Step<C>;
}

/** Options for constructing a {@link DefaultAgentRun}. */
export interface AgentRunOptions<C extends AnyCodec> {
  /** The id of the run this handle is bound to. */
  runId: string;
  /** Tree the handle reads run state and messages from. */
  tree: Tree<CodecMessage<C>>;
  /** Writer used to publish `x-ably-run-end` from {@link DefaultAgentRun.end}. */
  writer: DefaultSessionWriter<C>;
  /** Logger inherited from the owning session. */
  logger: Logger;
  /**
   * Optional callback the run invokes once with its newly constructed
   * view. The owning session uses this to register the view in its set
   * of "views to close on `Session.close`", so the contract that
   * `Session.close` closes every view created from a session holds for
   * agent-run views as well as `createView` results.
   * @param view The view the run created and now owns.
   */
  registerView?: (view: DefaultAgentView<C>) => void;
}

/**
 * Default {@link AgentRun} implementation. Lazy-reads run state from the
 * tree on each getter access; `end` publishes through the writer and
 * tracks a local terminal flag for idempotency. The bound view is
 * created at construction so the agent can subscribe before any fill-in
 * happens.
 * @internal
 */
export class DefaultAgentRun<C extends AnyCodec> implements AgentRun<C> {
  private readonly _runId: string;
  private readonly _tree: Tree<CodecMessage<C>>;
  private readonly _writer: DefaultSessionWriter<C>;
  private readonly _logger: Logger;
  private readonly _view: DefaultAgentView<C>;
  private _ended = false;
  private _suspended = false;

  constructor(options: AgentRunOptions<C>) {
    this._runId = options.runId;
    this._tree = options.tree;
    this._writer = options.writer;
    this._logger = options.logger.withContext({ component: 'AgentRun', runId: options.runId });
    this._view = new DefaultAgentView<C>({
      tree: options.tree,
      logger: options.logger,
    });
    options.registerView?.(this._view);
    this._logger.trace('DefaultAgentRun(); initialized');
  }

  get id(): string {
    return this._runId;
  }

  get status(): RunStatus {
    // Lazy-read from the tree — the run-start may not yet be visible
    // (precondition wait covers that path), in which case we report the
    // status the agent expects to see at this point, namely 'active'.
    return this._tree.runs.find((run) => run.id === this._runId)?.status ?? 'active';
  }

  get initiatorClientId(): string {
    return this._tree.runs.find((run) => run.id === this._runId)?.initiatorClientId ?? '';
  }

  get controlSignals(): readonly ControlSignal[] {
    return this._tree.runs.find((run) => run.id === this._runId)?.controlSignals ?? [];
  }

  get pauseRequested(): boolean {
    return this._tree.runs.find((run) => run.id === this._runId)?.pauseRequested ?? false;
  }

  get view(): AgentView<C> {
    return this._view;
  }

  get messages(): readonly MessageNode<CodecMessage<C>>[] {
    return this._tree.messages.filter((node) => node.runId === this._runId);
  }

  async end(error?: unknown): Promise<void> {
    this._logger.trace('DefaultAgentRun.end();', { hasError: error !== undefined });

    if (this._ended) {
      this._logger.debug('DefaultAgentRun.end(); already ended — no-op');
      return;
    }
    this._ended = true;

    const status: RunEndStatus = this._classifyEndStatus(error);
    try {
      await this._writer.endRun({ runId: this._runId, status });
    } catch (publishError) {
      // Surface the publish failure but keep `_ended` true: the caller has
      // committed to ending the run; another attempt would race with our
      // publish and could double-send if the first eventually lands.
      if (publishError instanceof Ably.ErrorInfo) {
        throw new Ably.ErrorInfo(
          `unable to end run; ${publishError.message}`,
          publishError.code,
          publishError.statusCode,
          publishError,
        );
      }
      throw publishError;
    }

    this._logger.debug('DefaultAgentRun.end(); published', { status });
  }

  async suspend(): Promise<void> {
    // Spec: AIT-RS5, AIT-RS6.
    this._logger.trace('DefaultAgentRun.suspend();');

    if (this._ended) {
      throw new Ably.ErrorInfo(
        'unable to suspend run; run.end() has already been called',
        ErrorCode.RunAlreadyTerminal,
        400,
      );
    }
    if (this._suspended) {
      throw new Ably.ErrorInfo('unable to suspend run; run is already suspended', ErrorCode.RunAlreadySuspended, 400);
    }
    const status = this.status;
    if (status === 'suspended') {
      throw new Ably.ErrorInfo('unable to suspend run; run is already suspended', ErrorCode.RunAlreadySuspended, 400);
    }
    if (status === 'complete' || status === 'failed' || status === 'aborted') {
      throw new Ably.ErrorInfo(`unable to suspend run; run is already ${status}`, ErrorCode.RunAlreadyTerminal, 400);
    }

    try {
      await this._writer.suspendRun({ runId: this._runId });
    } catch (publishError) {
      if (publishError instanceof Ably.ErrorInfo) {
        throw new Ably.ErrorInfo(
          `unable to suspend run; ${publishError.message}`,
          publishError.code,
          publishError.statusCode,
          publishError,
        );
      }
      throw publishError;
    }

    // Set _suspended *after* the publish resolves so a failed publish
    // leaves the handle re-callable: nothing reached the channel, so the
    // caller can retry suspend() without seeing a stale RunAlreadySuspended
    // throw. Disposer behaviour is preserved — close() inspects this flag
    // only once the suspend publish succeeded.
    this._suspended = true;
    this._logger.debug('DefaultAgentRun.suspend(); published');
  }

  async close(): Promise<void> {
    this._logger.trace('DefaultAgentRun.close();');
    // Skip the implicit end() when the run was suspended explicitly —
    // run-suspend is the lifecycle wire the agent already published, and
    // an automatic end() here would clobber it with run-end. The agent
    // can still call end() explicitly after suspend if it wants to
    // forcibly terminate. Spec: AIT-RS7.
    if (!this._ended && !this._suspended) {
      try {
        await this.end();
      } catch (error) {
        // Teardown must not throw — surface the failure via the logger so
        // the original control-flow error (if any) is what surfaces to the
        // caller. Matches the "disposer must not leak subscriptions"
        // contract documented on Symbol.asyncDispose, which delegates here.
        this._logger.warn('DefaultAgentRun.close(); end() failed', { error });
      }
    }
    this._view.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  createStep(): Step<C> {
    this._logger.trace('DefaultAgentRun.createStep();');
    return new DefaultStep<C>({
      stepId: crypto.randomUUID(),
      runId: this._runId,
      tree: this._tree,
      writer: this._writer,
      logger: this._logger,
    });
  }

  /**
   * Pick the wire status for `x-ably-run-end` from the input error.
   *
   *   - Error not supplied (happy path / disposer) → `'complete'`.
   *   - Error supplied, signal-driven (web-standard `AbortError` from a
   *     model SDK whose `abortSignal` was wired to `step.signal`) →
   *     `'aborted'`. The abort signal that landed during the step's
   *     lifetime is what fired `step.signal`, so the throw is
   *     attributable to it.
   *   - Error supplied, otherwise → `'failed'`. A genuine error keeps
   *     the run retryable.
   *
   * Pure function of `error`; the channel's observed control signals
   * do not preempt the classification. The wire this publishes is the
   * lifecycle event that actually transitions the run; observation of
   * an abort signal alone never moves run status.
   * @param error The error supplied to {@link end}, or `undefined`.
   * @returns The wire status to publish on the run-end.
   */
  private _classifyEndStatus(error: unknown): RunEndStatus {
    if (error === undefined) {
      return 'complete';
    }
    if (isAbortSignalError(error)) {
      return 'aborted';
    }
    return 'failed';
  }
}
