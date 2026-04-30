import type { Logger } from '../../logger.js';

/**
 * A node in the session's conversation tree. Carries the domain message
 * plus transport metadata (identity, attribution) and the Ably message
 * serial that ordered it on the channel.
 *
 * Phase 1 subset of the RFC's `MessageNode` — the `parentId`, `children`,
 * `run`, `step`, and `streaming` fields are deferred and will be added
 * additively in later phases.
 */
export interface MessageNode<TMessage> {
  /** Unique message ID (from the `x-ably-msg-id` header). */
  readonly id: string;

  /**
   * The participant type that produced this message (from the `x-ably-role`
   * header). Client-initiated publishes are `user`; agent-initiated publishes
   * are `assistant`. This is the protocol role, which may differ from the
   * role the codec encodes inside the domain message — use this when filtering
   * or attributing at the transport level.
   */
  readonly role: 'user' | 'assistant';

  /**
   * The clientId this message is attributed to. Taken from the
   * `x-ably-client-id` header when present (a backend publishing on behalf
   * of an end-user), otherwise from the publishing connection's
   * `message.clientId`. Use this for UI attribution, access checks, and
   * filtering to a specific user's activity.
   */
  readonly clientId: string;

  /** The domain message in the codec's representation. */
  readonly message: TMessage;

  /**
   * The Ably message serial that delivered this node. Retained on the
   * node so later phases (step supersession in particular) can reason
   * about total ordering on the channel without having to thread the
   * inbound message through.
   */
  readonly serial: string;
}

/**
 * The unfiltered conversation tree: every node the session has observed,
 * ordered by Ably message serial. The tree is the canonical source of
 * conversation structure within a session; views project it.
 *
 * Phase 1 subset — exposes only the coarse `subscribe` notification and
 * the message list. Granular events (`message-added`, `run-started`, …),
 * `runs`/`steps` collections, and lookup helpers land in later phases.
 */
export interface Tree<TMessage> {
  /** All message nodes the tree has observed, ordered by serial. */
  readonly messages: readonly MessageNode<TMessage>[];

  /**
   * Register a coarse change listener. The handler fires after every
   * structural change to the tree — callers re-read {@link messages} to
   * project the new state. Returns an unsubscribe function; subsequent
   * calls to it are idempotent.
   * @param callback Invoked with no arguments after each change.
   * @returns A function that removes the listener when called.
   */
  subscribe(callback: () => void): () => void;
}

/**
 * Internal extension of {@link Tree}. The decode loop and other SDK
 * components apply observed messages through this surface; consumers
 * see only the read-only {@link Tree}.
 * @internal
 */
export interface TreeInternal<TMessage> extends Tree<TMessage> {
  /**
   * Insert a node into the tree at its serial-ordered position and notify
   * subscribers. Out-of-order serials still land in serial order so the
   * tree's `messages` array remains a stable projection of channel order
   * regardless of arrival sequence.
   * @param node The node to insert.
   */
  applyMessage(node: MessageNode<TMessage>): void;
}

/** Options for constructing a {@link DefaultTree}. */
export interface TreeOptions {
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link TreeInternal} implementation. Maintains a single array
 * of nodes ordered by serial and a flat set of coarse subscribers.
 * @internal
 */
export class DefaultTree<TMessage> implements TreeInternal<TMessage> {
  private readonly _logger: Logger;
  private readonly _messages: MessageNode<TMessage>[] = [];
  private readonly _subscribers = new Set<() => void>();

  constructor(options: TreeOptions) {
    this._logger = options.logger.withContext({ component: 'Tree' });
    this._logger.trace('DefaultTree(); initialized');
  }

  get messages(): readonly MessageNode<TMessage>[] {
    return this._messages;
  }

  applyMessage(node: MessageNode<TMessage>): void {
    this._logger.trace('DefaultTree.applyMessage();', { id: node.id, serial: node.serial });

    const insertAt = this._messages.findIndex((existing) => existing.serial > node.serial);
    const targetIndex = insertAt === -1 ? this._messages.length : insertAt;
    this._messages.splice(targetIndex, 0, node);

    this._notify();
  }

  subscribe(callback: () => void): () => void {
    this._logger.trace('DefaultTree.subscribe();');
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  private _notify(): void {
    // Set iteration tolerates a handler removing itself: the current element is
    // already yielded, and subsequent live subscribers continue to be visited.
    for (const callback of this._subscribers) {
      try {
        callback();
      } catch (error) {
        this._logger.error('DefaultTree._notify(); subscriber threw', { error });
      }
    }
  }
}
