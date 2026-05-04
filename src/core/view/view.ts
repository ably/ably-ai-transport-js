import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
import type { ClientRun } from '../run/index.js';
import { createClientRun } from '../run/index.js';
import type { DefaultSessionWriter } from '../session/writer.js';
import type { MessageNode, Tree } from '../tree/index.js';

/**
 * Base read projection over a session's tree. A view exposes the messages
 * the consumer should render and a state-oriented subscription for observing
 * changes; both `ClientView` and (eventually) `AgentView` share this contract.
 *
 * Phase 2 subset of the RFC `View` interface — branching, pagination, and
 * the codec-typed run variant on each node land in later phases. The shape
 * is a strict subset, so future additions are additive.
 */
export interface View<TMessage> {
  /**
   * Messages visible in this view. Phase 2 returns the tree's full message
   * list in serial order; later phases project a single selected sibling at
   * each branch point.
   */
  readonly messages: readonly MessageNode<TMessage>[];

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
 * Read projection scoped to the client's UI perspective.
 *
 * Phase 6 subset — exposes `send`, the verb that opens a new run with the
 * supplied user message. `regenerate`, `edit`, `select`, `loadMore`,
 * `runs`, `hasMore`, and `createRun` land additively in later phases.
 */
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

export interface ClientView<C extends AnyCodec> extends View<CodecMessage<C>> {
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
 * Default {@link ClientView} implementation. Adds the publish path
 * (`send`) on top of the base {@link DefaultView}; everything else
 * (`messages`, `subscribe`, `close`) flows through inheritance.
 * @internal
 */
export class DefaultClientView<C extends AnyCodec> extends DefaultView<CodecMessage<C>> implements ClientView<C> {
  private readonly _writer: DefaultSessionWriter<C>;
  private readonly _sessionName: string;

  constructor(options: ClientViewOptions<C>) {
    super({ tree: options.tree, logger: options.logger });
    this._writer = options.writer;
    this._sessionName = options.sessionName;
  }

  async send(messages: CodecMessage<C> | CodecMessage<C>[]): Promise<ClientRun<C>> {
    this._logger.trace('DefaultClientView.send();');
    const { runId, lastMessageId, initiatorClientId } = await this._writer.startRunWithMessages({ messages });
    return createClientRun<C>({
      id: runId,
      status: 'active',
      initiatorClientId,
      sessionName: this._sessionName,
      messageId: lastMessageId,
      tree: this._tree,
      writer: this._writer,
      logger: this._logger,
    });
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
