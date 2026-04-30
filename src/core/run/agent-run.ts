import * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { MessageNode, Tree } from '../tree/index.js';
import type { AgentView } from '../view/index.js';
import { DefaultAgentView } from '../view/index.js';
import type { Run, RunEndStatus, RunStatus } from './run.js';

/**
 * Run as seen from an {@link AgentSession}. Phase 7 subset of the RFC's
 * `AgentRun<C>` — adds `view`, `messages`, `end`, and the async disposer
 * on top of the base {@link Run}. `createStep`, `suspend`, `lastStep`,
 * `when`, and run-level `sendMessages`/`sendParts`/`sendEvents` land in
 * later phases.
 *
 * Returned by {@link AgentSession.createRun}.
 */
export interface AgentRun<C extends AnyCodec> extends Run<CodecMessage<C>> {
  /**
   * The linear read projection for this run: every message published
   * within the run, filtered from the session's tree on each read.
   * Subscribe via `run.view.subscribe(...)` to observe ancestry fill-in
   * and steering messages that arrive mid-execution.
   */
  readonly view: AgentView<C>;

  /**
   * Messages published within this run, filtered from the session's tree
   * by the run's id. Equivalent to `run.view.messages` in phase 7's
   * subset (no parent-run ancestry yet).
   */
  readonly messages: readonly MessageNode<CodecMessage<C>>[];

  /**
   * Finalise the run. Phase 7 subset of the RFC's `end` classifier — no
   * error → publishes `x-ably-run-end` with status `'complete'`; an
   * error → publishes status `'failed'`. The pause and abort rows of the
   * RFC classifier depend on `step.signal.reason` and land in phase 11.
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
      runId: options.runId,
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
    // status the agent expects to see, namely 'active'.
    return this._tree.runs.find((run) => run.id === this._runId)?.status ?? 'active';
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

    const status: RunEndStatus = error === undefined ? 'complete' : 'failed';
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
}
