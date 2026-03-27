/**
 * DefaultView — a paginated, branch-aware projection over the Tree.
 *
 * Wraps a Tree and manages a pagination window that controls which nodes
 * are visible to the UI. New live messages appear immediately; older messages
 * are revealed progressively via `loadOlder()`.
 *
 * Events are scoped to the visible window — 'update' only fires when the
 * visible output changes, 'ably-message' only for messages corresponding to
 * visible nodes, and 'turn' only for turns with visible messages.
 */

import type * as Ably from 'ably';

import { HEADER_MSG_ID, HEADER_TURN_ID } from '../../constants.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import type { DefaultTree } from './tree.js';
import type { PaginatedMessages, TreeNode, TurnLifecycleEvent, View } from './types.js';

// ---------------------------------------------------------------------------
// Events map
// ---------------------------------------------------------------------------

interface ViewEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  turn: TurnLifecycleEvent;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a View. */
export interface ViewOptions<TEvent, TMessage> {
  /** The tree to project. */
  tree: DefaultTree<TMessage>;
  /** The Ably channel to load history from. */
  channel: Ably.RealtimeChannel;
  /** The codec for decoding history messages. */
  codec: Codec<TEvent, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultView<TEvent, TMessage> implements View<TMessage> {
  private readonly _tree: DefaultTree<TMessage>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TEvent, TMessage>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;

  /** Msg-ids loaded from history but not yet revealed to the UI. */
  private readonly _withheldMsgIds = new Set<string>();

  /** Snapshot of visible msgIds — used to detect whether tree updates affect the view. */
  private _lastVisibleIds: string[] = [];

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: PaginatedMessages<TMessage> | undefined;

  /** Buffer of withheld nodes, drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: TreeNode<TMessage>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  private _closed = false;

  constructor(options: ViewOptions<TEvent, TMessage>) {
    this._tree = options.tree;
    this._channel = options.channel;
    this._codec = options.codec;
    this._logger = options.logger.withContext({ component: 'View' });
    this._emitter = new EventEmitter<ViewEventsMap>(this._logger);

    // Snapshot initial visible state
    this._lastVisibleIds = this._computeVisibleIds();

    // Subscribe to tree events and re-emit scoped versions
    this._unsubs.push(
      this._tree.on('update', () => {
        this._onTreeUpdate();
      }),
      this._tree.on('ably-message', (msg) => {
        this._onTreeAblyMessage(msg);
      }),
      this._tree.on('turn', (event) => {
        this._onTreeTurn(event);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  flattenNodes(): TreeNode<TMessage>[] {
    if (this._withheldMsgIds.size === 0) return this._tree.flattenNodes();
    return this._tree.flattenNodes().filter((n) => !this._withheldMsgIds.has(n.msgId));
  }

  hasOlder(): boolean {
    return this._withheldBuffer.length > 0 || this._hasMoreHistory;
  }

  async loadOlder(limit = 100): Promise<void> {
    if (this._closed) return;
    this._logger.trace('DefaultView.loadOlder();', { limit });

    // Drain withheld buffer first (older messages, released newest-first)
    if (this._withheldBuffer.length > 0) {
      const batch = this._withheldBuffer.splice(-limit, limit);
      this._releaseWithheld(batch);
      return;
    }

    // Buffer exhausted — load from channel history
    if (!this._hasMoreHistory && !this._lastHistoryPage) {
      // First load
      await this._loadFirstPage(limit);
      return;
    }

    if (!this._hasMoreHistory) return;

    // Continue from last page
    if (!this._lastHistoryPage?.hasNext()) {
      this._hasMoreHistory = false;
      return;
    }

    const nextPage = await this._lastHistoryPage.next();
    if (!nextPage) {
      this._hasMoreHistory = false;
      return;
    }

    await this._loadAndReveal(nextPage, limit);
  }

  getActiveTurnIds(): Map<string, Set<string>> {
    const allTurns = this._tree.getActiveTurnIds();
    if (this._withheldMsgIds.size === 0) return allTurns;

    // Filter to turns that have at least one visible message
    const visibleTurnIds = new Set<string>();
    for (const n of this.flattenNodes()) {
      const turnId = n.headers[HEADER_TURN_ID];
      if (turnId) visibleTurnIds.add(turnId);
    }

    const result = new Map<string, Set<string>>();
    for (const [clientId, turnIds] of allTurns) {
      const filtered = new Set<string>();
      for (const turnId of turnIds) {
        if (visibleTurnIds.has(turnId)) filtered.add(turnId);
      }
      if (filtered.size > 0) result.set(clientId, filtered);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'turn', handler: (event: TurnLifecycleEvent) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'turn',
    handler: (() => void) | ((msg: Ably.InboundMessage) => void) | ((event: TurnLifecycleEvent) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: ViewEventsMap[keyof ViewEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Tear down the view — unsubscribe from tree events.
   */
  close(): void {
    this._closed = true;
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._withheldMsgIds.clear();
    this._withheldBuffer.length = 0;
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  private async _loadFirstPage(limit: number): Promise<void> {
    // Snapshot before loading — everything already in the tree stays visible
    const beforeMsgIds = new Set(this._tree.flattenNodes().map((n) => n.msgId));

    const firstPage = await decodeHistory(this._channel, this._codec, { limit }, this._logger);
    const { newVisible, lastPage } = await this._loadUntilVisible(firstPage, limit, beforeMsgIds);

    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();

    // Withhold ALL new visible messages first, then release the newest batch
    for (const n of newVisible) {
      this._withheldMsgIds.add(n.msgId);
    }

    const released = newVisible.slice(-limit);
    const withheld = newVisible.slice(0, -limit);
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(released);
  }

  private async _loadAndReveal(page: PaginatedMessages<TMessage>, limit: number): Promise<void> {
    // Everything currently in the tree is "already known"
    const alreadyKnown = new Set(this._tree.flattenNodes().map((n) => n.msgId));

    const { newVisible, lastPage } = await this._loadUntilVisible(page, limit, alreadyKnown);
    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();

    for (const n of newVisible) {
      this._withheldMsgIds.add(n.msgId);
    }

    // Release the newest `limit` items; rest stays in buffer
    const batch = newVisible.splice(-limit, limit);
    this._withheldBuffer.push(...newVisible);
    this._releaseWithheld(batch);
  }

  private _processHistoryPage(page: PaginatedMessages<TMessage>): void {
    for (const [i, message] of page.items.entries()) {
      const headers = page.itemHeaders?.[i] ?? {};
      const serial = page.itemSerials?.[i];
      const msgId = headers[HEADER_MSG_ID];
      if (!msgId) continue;
      this._tree.upsert(msgId, message, headers, serial);
    }

    // Forward raw Ably messages through the tree
    if (page.rawMessages && page.rawMessages.length > 0) {
      for (const msg of page.rawMessages) {
        this._tree.emitAblyMessage(msg);
      }
    }
  }

  private async _loadUntilVisible(
    firstPage: PaginatedMessages<TMessage>,
    target: number,
    beforeMsgIds: Set<string>,
  ): Promise<{ newVisible: TreeNode<TMessage>[]; lastPage: PaginatedMessages<TMessage> }> {
    this._processHistoryPage(firstPage);
    let page = firstPage;

    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._tree.flattenNodes()) {
        if (!beforeMsgIds.has(n.msgId)) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._tree.flattenNodes().filter((n) => !beforeMsgIds.has(n.msgId));
    return { newVisible, lastPage: page };
  }

  private _releaseWithheld(nodes: TreeNode<TMessage>[]): void {
    for (const n of nodes) {
      this._withheldMsgIds.delete(n.msgId);
    }
    if (nodes.length > 0) {
      this._updateVisibleSnapshot();
      this._emitter.emit('update');
    }
  }

  // -------------------------------------------------------------------------
  // Private: scoped event forwarding
  // -------------------------------------------------------------------------

  private _computeVisibleIds(): string[] {
    return this.flattenNodes().map((n) => n.msgId);
  }

  private _updateVisibleSnapshot(): void {
    this._lastVisibleIds = this._computeVisibleIds();
  }

  private _onTreeUpdate(): void {
    const newIds = this._computeVisibleIds();
    if (this._visibleChanged(newIds)) {
      this._lastVisibleIds = newIds;
      this._emitter.emit('update');
    }
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // Re-emit only if the message corresponds to a visible node
    const headers = getHeaders(msg);
    const msgId = headers[HEADER_MSG_ID];
    if (!msgId) {
      // Non-message events (turn-start, turn-end, cancel) — always forward
      this._emitter.emit('ably-message', msg);
      return;
    }
    if (!this._withheldMsgIds.has(msgId)) {
      this._emitter.emit('ably-message', msg);
    }
  }

  private _onTreeTurn(event: TurnLifecycleEvent): void {
    // Re-emit only if the turn has visible messages
    const visibleTurnIds = new Set<string>();
    for (const n of this.flattenNodes()) {
      const turnId = n.headers[HEADER_TURN_ID];
      if (turnId) visibleTurnIds.add(turnId);
    }
    if (visibleTurnIds.has(event.turnId)) {
      this._emitter.emit('turn', event);
    }
  }

  private _visibleChanged(newIds: string[]): boolean {
    if (newIds.length !== this._lastVisibleIds.length) return true;
    for (const [i, newId] of newIds.entries()) {
      if (newId !== this._lastVisibleIds[i]) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a View that projects a paginated window over a Tree.
 * @param options - The tree, channel, codec, and logger to use.
 * @returns A new {@link DefaultView} instance.
 */
export const createView = <TEvent, TMessage>(options: ViewOptions<TEvent, TMessage>): DefaultView<TEvent, TMessage> =>
  new DefaultView(options);
