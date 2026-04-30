import type { Logger } from '../../logger.js';
import type { AnyCodec, CodecMessage } from '../codec/index.js';
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
 * Phase 2 subset — `extends View<CodecMessage<C>>` with no extra members
 * yet. `send`, `regenerate`, `edit`, `select`, `loadMore`, `runs`, `hasMore`,
 * and `createRun` land additively in later phases (phase 6 onward).
 *
 * The interface is exported now so that `ClientSession.createView()` can
 * already return `ClientView<C>` and the return type never narrows when
 * later phases add members.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Phase 2 subset; members added additively in phase 6+.
export interface ClientView<C extends AnyCodec> extends View<CodecMessage<C>> {}

/** Options for constructing a {@link DefaultView}. */
export interface ViewOptions<TMessage> {
  /** Tree the view projects from. */
  tree: Tree<TMessage>;
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link View} implementation. Phase 2 mirrors the tree directly —
 * `messages` returns `tree.messages` unchanged. The view subscribes to the
 * tree on construction and forwards each notification to its own subscribers
 * so that `close()` can sever the chain without affecting the tree.
 * @internal
 */
export class DefaultView<TMessage> implements View<TMessage> {
  private readonly _logger: Logger;
  private readonly _tree: Tree<TMessage>;
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
