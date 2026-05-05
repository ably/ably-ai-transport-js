import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { ClientRun, Run } from '../run/index.js';
import { createClientRun } from '../run/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { MessageNode, Tree } from '../tree/index.js';

/**
 * Base read projection over a session's tree. A view exposes the messages
 * the consumer should render and a state-oriented subscription for observing
 * changes; both `ClientView` and (eventually) `AgentView` share this contract.
 *
 * Generic over `TRun` so the projection can attach the codec-typed run
 * handle on each node (`ClientRun<C>` for a `ClientView`, the plain
 * {@link Run} record on the base interface). Defaults to `Run<TMessage>`
 * so the AgentView and tree-level uses do not need to name the parameter.
 *
 * Phase 2 subset of the RFC `View` interface — branching, pagination, and
 * the codec-typed run variant on each node land in later phases. The shape
 * is a strict subset, so future additions are additive.
 */
export interface View<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /**
   * Messages visible in this view. Phase 2 returns the tree's full message
   * list in serial order; later phases project a single selected sibling at
   * each branch point.
   *
   * The element type carries the projection's run variant in the optional
   * `run` slot. Whether it is populated depends on the projection: the
   * default {@link DefaultView} returns tree-level nodes whose `run` slot
   * is undefined, while {@link DefaultClientView} attaches the typed
   * {@link ClientRun} handle so UI code can call `node.run?.abort()`
   * directly from a rendered node.
   */
  readonly messages: readonly MessageNode<TMessage, TRun>[];

  /**
   * Subscribe to view state changes. The callback fires whenever the visible
   * output changes — a new message, an updated message, etc. Returns an
   * unsubscribe function; subsequent calls to it are idempotent.
   *
   * This is the primary subscription for UI rendering. The Tree exposes
   * granular events; the View exposes coarse state-oriented observation.
   * @param callback Invoked with no arguments after each visible-state change.
   * @returns A function that removes the listener when called.
   */
  subscribe(callback: () => void): () => void;

  /**
   * Release this view's subscriptions. After `close()`, the view no longer
   * fires subscribers and stops mirroring the tree. `Session.close()` closes
   * all views automatically.
   *
   * Idempotent — calling `close()` a second time is a no-op.
   */
  close(): void;
}

/**
 * Read projection scoped to a specific run from the agent's perspective.
 *
 * Phase 7 subset — `extends View<CodecMessage<C>>` with no extra members
 * yet. Messages visible on this view are filtered to the bound run's
 * ancestry (in basic-chat without forks, that's all messages produced
 * within the run). Branching, pagination, and the codec-typed `run`
 * field on each node land in later phases.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Phase 7 subset; members added additively in later phases.
export interface AgentView<C extends AnyCodec> extends View<CodecMessage<C>> {}

/**
 * Read projection scoped to the client's UI perspective.
 *
 * Phase 6 subset — exposes `send`, the verb that opens a new run with the
 * supplied user message, and `runs`, the live list of {@link ClientRun}
 * handles for runs visible in this view. `regenerate`, `edit`, `select`,
 * `loadMore`, `hasMore`, and `createRun` land additively in later phases.
 */
export interface ClientView<C extends AnyCodec> extends View<CodecMessage<C>, ClientRun<C>> {
  /**
   * Live list of {@link ClientRun} handles for runs visible in this view.
   * Each handle reads its status lazily from the underlying tree, so
   * iterating `runs` and reading `r.status` reflects the latest observed
   * lifecycle wires (`x-ably-run-start`, `x-ably-run-end`, `x-ably-abort`)
   * without the consumer subscribing to them directly.
   *
   * Identity is stable per run id — a run that surfaces twice in two reads
   * returns the same `ClientRun` instance, so React `useMemo`/keyed lists
   * do not see spurious churn. Subscribe via {@link View.subscribe} to
   * re-read after each tree change.
   */
  readonly runs: readonly ClientRun<C>[];

  /**
   * Open a new run at the current branch tip and publish the user
   * message(s) on it. The SDK builds an `x-ably-run-start` and the encoded
   * messages, publishes them in a single atomic Ably batch — the run
   * either lands fully live with its first messages or not at all — and
   * returns the resulting {@link ClientRun}. POST
   * `run.toInvocation().toJSON()` to wake the agent endpoint.
   *
   * The {@link Invocation} produced by `run.toInvocation()` carries the
   * **last** message's id as the precondition — the agent waits for that
   * message to be visible before starting its step.
   * @param messages A single user message or an array of user messages to
   *   publish onto the newly opened run.
   * @returns The live {@link ClientRun}, with `status === 'active'`.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after the session has been closed.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.InvalidArgument}
   *   when the realtime connection has no concrete `clientId` — run
   *   attribution requires one — or when `messages` is an empty array.
   */
  send(messages: CodecMessage<C> | CodecMessage<C>[]): Promise<ClientRun<C>>;
}

/** Options for constructing a {@link DefaultView}. */
export interface ViewOptions<TMessage> {
  /** Tree the view projects from. */
  tree: Tree<TMessage>;
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Options for constructing a {@link DefaultClientView}. Extends
 * {@link ViewOptions} with the dependencies `view.send` needs to open a
 * run on the channel.
 */
export interface ClientViewOptions<C extends AnyCodec> extends ViewOptions<CodecMessage<C>> {
  /**
   * Writer that owns the publish path. The view drives `view.send` through
   * the writer's internal `startRunWithMessages` so all wire-format work
   * stays out of the view.
   */
  writer: DefaultSessionWriter<C>;
  /** Session name written into the {@link Invocation} produced by `run.toInvocation`. */
  sessionName: string;
}

/**
 * Options for constructing a {@link DefaultAgentView}. Same shape as
 * {@link ViewOptions} today — the linear projection does not need to
 * distinguish runs. The branching implementation will reintroduce a
 * run-anchor field here.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- forward-compatible alias; branching will add fields here.
export interface AgentViewOptions<C extends AnyCodec> extends ViewOptions<CodecMessage<C>> {}

/**
 * Default {@link View} implementation. Phase 2 mirrors the tree directly —
 * `messages` returns `tree.messages` unchanged. The view subscribes to the
 * tree on construction and forwards each notification to its own subscribers
 * so that `close()` can sever the chain without affecting the tree.
 *
 * The class is non-generic over `TRun` — the base view does not enrich
 * `node.run`. {@link DefaultClientView} extends and overrides
 * {@link messages} to attach the codec-typed run handle.
 * @internal
 */
export class DefaultView<TMessage> implements View<TMessage> {
  protected readonly _logger: Logger;
  protected readonly _tree: Tree<TMessage>;
  private readonly _subscribers = new Set<() => void>();
  private _treeUnsubscribe?: () => void;
  private _closed = false;

  constructor(options: ViewOptions<TMessage>) {
    this._logger = options.logger.withContext({ component: 'View' });
    this._tree = options.tree;
    this._treeUnsubscribe = this._tree.subscribe(() => {
      this._notify();
    });
    this._logger.trace('DefaultView(); initialized');
  }

  get messages(): readonly MessageNode<TMessage>[] {
    return this._tree.messages;
  }

  subscribe(callback: () => void): () => void {
    this._logger.trace('DefaultView.subscribe();');
    if (this._closed) {
      // After close the view no longer fires; hand back a no-op unsubscribe so
      // callers can wire teardown uniformly without a closed-state branch.
      return () => {
        // no-op
      };
    }
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  close(): void {
    this._logger.trace('DefaultView.close();');
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._treeUnsubscribe?.();
    this._treeUnsubscribe = undefined;
    this._subscribers.clear();
  }

  private _notify(): void {
    if (this._closed) {
      return;
    }
    // Set iteration tolerates a handler removing itself: the current element is
    // already yielded, and subsequent live subscribers continue to be visited.
    for (const callback of this._subscribers) {
      try {
        callback();
      } catch (error) {
        this._logger.error('DefaultView._notify(); subscriber threw', { error });
      }
    }
  }
}

/**
 * Default {@link ClientView} implementation. Adds:
 *
 *   - `send` — publishes a fresh run + user message through the writer.
 *   - `runs` — projects the underlying tree's runs through a per-id
 *     `ClientRun` cache so the consumer sees stable handles.
 *   - `messages` (override) — projects the underlying tree's nodes,
 *     attaching the typed `ClientRun<C>` handle to each `node.run`.
 *
 * The cache is keyed by run id and lives until {@link close}. Subscribe /
 * close machinery (and the {@link send} writer plumbing) flows through
 * inheritance from {@link DefaultView}.
 * @internal
 */
export class DefaultClientView<C extends AnyCodec> extends DefaultView<CodecMessage<C>> implements ClientView<C> {
  private readonly _writer: DefaultSessionWriter<C>;
  private readonly _sessionName: string;
  /**
   * Per-id cache of {@link ClientRun} handles keyed by run id, so the
   * consumer sees a stable `view.runs[i] === view.runs[i]` identity
   * across reads. Populated lazily as `runs` / `messages` getters
   * project a tree run for the first time.
   */
  private readonly _runHandles = new Map<string, ClientRun<C>>();
  /**
   * Memoised projection of `tree.messages` into nodes whose `run` slot
   * carries the typed {@link ClientRun} handle. Invalidated whenever the
   * tree fires a change notification — the array identity flips on the
   * next read so React `useSyncExternalStore` consumers detect the
   * change without a deep comparison.
   */
  private _messagesProjection?: readonly MessageNode<CodecMessage<C>, ClientRun<C>>[];
  /**
   * Same memoisation strategy for `runs`. Refreshed when the tree
   * notifies; null until first read after construction or invalidation.
   */
  private _runsProjection?: readonly ClientRun<C>[];
  /** Unsubscribe handle for the projection-invalidation tree listener. */
  private readonly _projectionUnsubscribe: () => void;

  constructor(options: ClientViewOptions<C>) {
    super({ tree: options.tree, logger: options.logger });
    this._writer = options.writer;
    this._sessionName = options.sessionName;
    // Invalidate the memoised projections on every tree change so
    // subsequent reads rebuild from the latest state. The base class's
    // own subscriber forwards the notification to view subscribers; this
    // listener runs alongside it for projection bookkeeping only and is
    // released in close().
    this._projectionUnsubscribe = this._tree.subscribe(() => {
      this._messagesProjection = undefined;
      this._runsProjection = undefined;
    });
  }

  override get messages(): readonly MessageNode<CodecMessage<C>, ClientRun<C>>[] {
    this._messagesProjection ??= this._tree.messages.map((node) => ({
      ...node,
      run: this._handleFor(node.runId),
    }));
    return this._messagesProjection;
  }

  get runs(): readonly ClientRun<C>[] {
    if (this._runsProjection !== undefined) {
      return this._runsProjection;
    }
    // Iterate the tree's runs first so the shared observation order is
    // preserved across multi-device clients hydrating from the same
    // channel. Then append any view-seeded handles (e.g. from `send` that
    // hasn't echoed back yet) whose runId isn't already on the tree —
    // the user clicking "send" expects the run to surface in `view.runs`
    // immediately, before the publish round-trips.
    const seen = new Set<string>();
    const result: ClientRun<C>[] = [];
    for (const record of this._tree.runs) {
      // Records iterated here are observed runs; `_wrapRecord` is the
      // direct path that always produces a handle.
      result.push(this._wrapRecord(record));
      seen.add(record.id);
    }
    for (const [runId, handle] of this._runHandles) {
      if (!seen.has(runId)) {
        result.push(handle);
      }
    }
    this._runsProjection = result;
    return this._runsProjection;
  }

  override close(): void {
    this._projectionUnsubscribe();
    super.close();
    this._runHandles.clear();
    this._messagesProjection = undefined;
    this._runsProjection = undefined;
  }

  async send(messages: CodecMessage<C> | CodecMessage<C>[]): Promise<ClientRun<C>> {
    this._logger.trace('DefaultClientView.send();');
    const { runId, lastMessageId, initiatorClientId } = await this._writer.startRunWithMessages({ messages });
    const run = createClientRun<C>({
      id: runId,
      status: 'active',
      initiatorClientId,
      sessionName: this._sessionName,
      messageId: lastMessageId,
      tree: this._tree,
      writer: this._writer,
      logger: this._logger,
    });
    // Seed the cache so a node arriving via the decode loop reuses this
    // exact handle rather than synthesising a fresh one. Important for
    // the messageId carried on `toInvocation()` — the node.run reference
    // and the handle returned by `view.send` are the same object.
    this._runHandles.set(runId, run);
    // Invalidate the memoised `runs`/`messages` projections so the next
    // read includes the freshly seeded handle. The tree subscriber covers
    // the inbound-echo path; `send` is the local-only path the tree never
    // observes synchronously.
    this._runsProjection = undefined;
    this._messagesProjection = undefined;
    return run;
  }

  /**
   * Resolve a {@link ClientRun} handle by id from the cache or, when not
   * cached, by looking up the run record on the tree and wrapping it.
   * Returns `undefined` when the tree has not observed an
   * `x-ably-run-start` for this id — used by the messages projection,
   * which surfaces messages whose run-start hasn't landed yet (a
   * transient gap during out-of-order delivery).
   *
   * Note: handles synthesised here have no `messageId` — they are the
   * "rehydrated from the tree" path, where no specific message was just
   * published, so an invocation built from them carries the runId only.
   * Handles seeded by {@link send} take precedence in the cache so their
   * own `messageId` (the precondition for the agent's first step) is
   * preserved.
   * @param runId The run id to resolve.
   * @returns A stable {@link ClientRun} bound to the tree, or `undefined`
   *   if the tree has not yet observed the run.
   */
  private _handleFor(runId: string): ClientRun<C> | undefined {
    const cached = this._runHandles.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    const record = this._tree.getRun(runId);
    if (record === undefined) {
      return undefined;
    }
    return this._wrapRecord(record);
  }

  /**
   * Build (and cache) a {@link ClientRun} handle for the given tree
   * record. The runs projection feeds tree-iterated records straight
   * here so the unreachable "record not found" branch does not pollute
   * the call site. See {@link _handleFor} for the by-id path used by
   * the messages projection.
   * @param record The tree-side run record to wrap.
   * @returns A stable {@link ClientRun} bound to the tree.
   */
  private _wrapRecord(record: Run<CodecMessage<C>>): ClientRun<C> {
    const cached = this._runHandles.get(record.id);
    if (cached !== undefined) {
      return cached;
    }
    const run = createClientRun<C>({
      id: record.id,
      status: record.status,
      initiatorClientId: record.initiatorClientId,
      sessionName: this._sessionName,
      tree: this._tree,
      writer: this._writer,
      logger: this._logger,
    });
    this._runHandles.set(record.id, run);
    return run;
  }
}

/**
 * Default {@link AgentView} implementation. Surfaces the linear conversation
 * the agent passes to the model: every message on the session's tree, in
 * serial order, regardless of which run produced it.
 *
 * In basic-chat each turn opens a new run, so a run-scoped filter would
 * strand the prior run's messages and the model would treat every turn as
 * a fresh conversation. The unfiltered projection is the right answer for
 * linear sessions; once branching (regenerate/edit) lands, this projection
 * will be replaced with one that walks the run-parent chain.
 * @internal
 */
export class DefaultAgentView<C extends AnyCodec> extends DefaultView<CodecMessage<C>> implements AgentView<C> {}
