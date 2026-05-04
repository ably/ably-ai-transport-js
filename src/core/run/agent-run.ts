import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { Step } from '../step/index.js';
import { DefaultStep } from '../step/index.js';
import type { MessageNode, Tree } from '../tree/index.js';
import type { AgentView } from '../view/index.js';
import { DefaultAgentView } from '../view/index.js';
import type { Run, RunEndStatus, RunStatus } from './run.js';

/**
 * Run as seen from an {@link AgentSession}. Phase 9 subset of the RFC's
 * `AgentRun<C>` — adds `view`, `messages`, `end`, the async disposer, and
 * `createStep` on top of the base {@link Run}. `suspend`, `lastStep`,
 * `when`, and run-level `sendMessages`/`sendParts`/`sendEvents` land in
 * later phases.
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
   * caller's error (or absence) and the run's durable abort state:
   *
   * | Inputs                                                    | Wire status   |
   * | --------------------------------------------------------- | ------------- |
   * | No error, run not aborted                                 | `'complete'`  |
   * | No error, run observed aborted (`abortRequested === true`) | `'aborted'`  |
   * | Error, run observed aborted, error is signal-driven       | `'aborted'`   |
   * | Error otherwise                                           | `'failed'`    |
   *
   * "Signal-driven" means a web-standard `AbortError` (what `AbortSignal`
   * paths throw, including model SDKs whose `abortSignal` is wired to
   * `step.signal`) or an `Ably.ErrorInfo` with code
   * {@link ErrorCode.RunAborted} (what {@link Step.start} throws when an
   * abort lands between steps). Any other error is genuine and routes to
   * `'failed'` even if the run has been aborted concurrently — `'failed'`
   * runs are retryable, `'aborted'` runs are not. Spec: AIT-AB7.
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
    // Lazy-read from the tree — the run-start may not yet be visible (the
    // plan defers slow-precondition handling), in which case we report the
    // status the agent expects to see, namely 'active'. Tree synthesises
    // 'aborted' when abortRequested is set, so this getter inherits that
    // synthesis transparently.
    return this._tree.runs.find((run) => run.id === this._runId)?.status ?? 'active';
  }

  get abortRequested(): boolean {
    return this._tree.runs.find((run) => run.id === this._runId)?.abortRequested === true;
  }

  get initiatorClientId(): string {
    return this._tree.runs.find((run) => run.id === this._runId)?.initiatorClientId ?? '';
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

  async close(): Promise<void> {
    this._logger.trace('DefaultAgentRun.close();');
    if (!this._ended) {
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
   * Pick the wire status for `x-ably-run-end` from the input error and
   * the run's durable abort state. Evaluated in two branches:
   *
   *   1. Error not supplied (happy path / disposer):
   *      - `tree.runs[runId].abortRequested === true` → `'aborted'`.
   *        Default flow: the step ran to completion while an abort was
   *        observed on the channel; this publish is the agent's
   *        confirmation. The wire is already aborted via the client's
   *        `x-ably-abort`.
   *      - Otherwise → `'complete'`.
   *
   *   2. Error supplied (catch path):
   *      - The run was observed aborted AND the error is attributable to
   *        the abort path (a web-standard `AbortError` from a model SDK
   *        whose `abortSignal` was wired to `step.signal`, or an
   *        SDK-thrown `Ably.ErrorInfo` with code `RunAborted`) →
   *        `'aborted'`.
   *      - Otherwise → `'failed'`. A genuine error wins over a coincident
   *        abort — `'failed'` runs are retryable, `'aborted'` runs are
   *        not, so the distinction is load-bearing. A non-signal-driven
   *        error means the throw was not the abort, even if
   *        `step.signal` happens to be aborted (e.g. the channel observed
   *        an abort while a network error bubbled up independently).
   *
   * Spec: AIT-AB7.
   * @param error The error supplied to {@link end}, or `undefined`.
   * @returns The wire status to publish on the run-end.
   */
  private _classifyEndStatus(error: unknown): RunEndStatus {
    if (error === undefined) {
      return this._abortRequestedForRun() ? 'aborted' : 'complete';
    }
    if (this._abortRequestedForRun() && (isAbortSignalError(error) || isRunAbortedErrorInfo(error))) {
      return 'aborted';
    }
    return 'failed';
  }

  private _abortRequestedForRun(): boolean {
    return this._tree.runs.find((r) => r.id === this._runId)?.abortRequested === true;
  }
}

/**
 * Detect a web-standard signal-driven abort error. `AbortSignal`-driven
 * paths (fetch, the Vercel AI SDK, most model SDK clients) throw a
 * `DOMException` whose `name` is `'AbortError'` when their bound signal
 * fires. Some SDKs wrap the abort in their own error class (e.g. the
 * OpenAI SDK's `APIUserAbortError` carries the original `AbortError` on
 * `cause`), so the check walks the cause chain.
 *
 * Used by the run-end classifier to distinguish signal-driven errors
 * (`'aborted'`) from genuine errors coincident with an abort observation
 * (`'failed'`).
 * @param error The caught error to classify.
 * @returns True when the error appears to be signal-driven.
 */
const isAbortSignalError = (error: unknown): boolean => {
  // Bound the cause chain walk to defend against pathological self-references.
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    if (typeof current !== 'object') {
      return false;
    }
    // CAST: errors are unstructured at the catch boundary. Read `name` and
    // `cause` defensively without committing to an `Error` shape so wrapper
    // classes from third-party SDKs are still inspected.
    const candidate = current as { name?: unknown; cause?: unknown };
    if (candidate.name === 'AbortError') {
      return true;
    }
    current = candidate.cause;
  }
  return false;
};

/**
 * Detect an SDK-thrown `Ably.ErrorInfo` whose code is {@link ErrorCode.RunAborted}.
 * Used by the run-end classifier to recognise an error that was thrown
 * because the run was already observably aborted (e.g. `step.start()`
 * rejected on a multi-step run after an abort landed between steps).
 * @param error The caught error to classify.
 * @returns True when the error is `Ably.ErrorInfo` with code `RunAborted`.
 */
const isRunAbortedErrorInfo = (error: unknown): boolean => {
  if (!(error instanceof Ably.ErrorInfo)) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return error.code === ErrorCode.RunAborted;
};
