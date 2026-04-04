/**
 * DefaultView — a paginated, branch-aware projection over the Tree.
 *
 * Wraps a Tree and manages a pagination window that controls which nodes
 * are visible to the UI. New live messages appear immediately; older messages
 * are revealed progressively via `loadOlder()`.
 *
 * Each View owns its own branch selection state and pagination window,
 * allowing multiple independent Views over the same Tree.
 *
 * Events are scoped to the visible window — 'update' only fires when the
 * visible output changes, 'ably-message' only for messages corresponding to
 * visible nodes, and 'turn' only for turns with visible messages.
 */

import * as Ably from 'ably';

import { HEADER_MSG_ID, HEADER_TURN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import type { TreeInternal } from './tree.js';
import type { ActiveTurn, PaginatedMessages, SendOptions, TreeNode, TurnLifecycleEvent, View } from './types.js';

// ---------------------------------------------------------------------------
// Events map
// ---------------------------------------------------------------------------

interface ViewEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  turn: TurnLifecycleEvent;
}

// ---------------------------------------------------------------------------
// Send delegate
// ---------------------------------------------------------------------------

/**
 * Context provided by the View to the transport's send machinery.
 * Allows the transport to derive parent and history from the calling view's branch.
 */
export interface ViewContext<TMessage> {
  /** Returns the visible nodes for this view's selected branch. */
  flattenNodes: () => TreeNode<TMessage>[];
}

/**
 * Internal delegate function provided by the transport for executing sends.
 * The View pre-computes branch context and passes it to the delegate.
 */
export type SendDelegate<TEvent, TMessage> = (
  input: TMessage | TMessage[],
  options: SendOptions | undefined,
  viewContext: ViewContext<TMessage>,
) => Promise<ActiveTurn<TEvent>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a View. */
export interface ViewOptions<TEvent, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TMessage>;
  /** The Ably channel to load history from. */
  channel: Ably.RealtimeChannel;
  /** The codec for decoding history messages. */
  codec: Codec<TEvent, TMessage>;
  /** Delegate for executing sends through the transport. */
  sendDelegate: SendDelegate<TEvent, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultView<TEvent, TMessage> implements View<TEvent, TMessage> {
  private readonly _tree: TreeInternal<TMessage>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TEvent, TMessage>;
  private readonly _sendDelegate: SendDelegate<TEvent, TMessage>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;

  /**
   * View-local branch selections: group root msgId → selected sibling index.
   * Fork points not present here default to the latest sibling.
   */
  private readonly _selections = new Map<string, number>();

  /** Spec: AIT-CT11c — msg-ids loaded from history but not yet revealed to the UI. */
  private readonly _withheldMsgIds = new Set<string>();

  /** Snapshot of visible msgIds — used to detect structural changes and for selection pinning. */
  private _lastVisibleIds: string[] = [];

  /** Snapshot of visible message references — used to detect in-place content updates (streaming). */
  private _lastVisibleMessages: TMessage[] = [];

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: PaginatedMessages<TMessage> | undefined;

  /** Buffer of withheld nodes, drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: TreeNode<TMessage>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  /**
   * Fork-of msgIds from this view's own send/regenerate calls where the
   * optimistic insert hasn't created a sibling yet (e.g. regenerate sends
   * no user messages). When the server response arrives and creates the new
   * sibling, `_onTreeUpdate` will auto-select it instead of pinning the old branch.
   */
  private readonly _pendingForkSelections = new Set<string>();

  private _closed = false;

  constructor(options: ViewOptions<TEvent, TMessage>) {
    this._tree = options.tree;
    this._channel = options.channel;
    this._codec = options.codec;
    this._sendDelegate = options.sendDelegate;
    this._logger = options.logger.withContext({ component: 'View' });
    this._logger.trace('DefaultView();');
    this._emitter = new EventEmitter<ViewEventsMap>(this._logger);

    // Snapshot initial visible state
    this._updateVisibleSnapshot();

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

  getMessages(): TMessage[] {
    return this.flattenNodes().map((n) => n.message);
  }

  // Spec: AIT-CT9, AIT-CT11c
  flattenNodes(): TreeNode<TMessage>[] {
    const nodes = this._tree.flattenNodes(this._selections);
    if (this._withheldMsgIds.size === 0) return nodes;
    return nodes.filter((n) => !this._withheldMsgIds.has(n.msgId));
  }

  hasOlder(): boolean {
    return this._withheldBuffer.length > 0 || this._hasMoreHistory;
  }

  async loadOlder(limit = 100): Promise<void> {
    if (this._closed) return;
    this._logger.trace('DefaultView.loadOlder();', { limit });

    try {
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
    } catch (error) {
      this._logger.error('DefaultView.loadOlder(); failed', { error });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Branch navigation
  // -------------------------------------------------------------------------

  // Spec: AIT-CT13c
  select(msgId: string, index: number): void {
    this._logger.trace('DefaultView.select();', { msgId, index });
    const group = this._tree.getSiblings(msgId);
    if (group.length <= 1) return;
    const groupRootId = this._tree.getGroupRoot(msgId);
    const clamped = Math.max(0, Math.min(index, group.length - 1));
    this._selections.set(groupRootId, clamped);
    this._logger.debug('DefaultView.select();', { msgId, index: clamped });
    this._updateVisibleSnapshot();
    this._emitter.emit('update');
  }

  getSelectedIndex(msgId: string): number {
    this._logger.trace('DefaultView.getSelectedIndex();', { msgId });
    const group = this._tree.getSiblings(msgId);
    if (group.length <= 1) return 0;
    const groupRootId = this._tree.getGroupRoot(msgId);
    const stored = this._selections.get(groupRootId);
    if (stored !== undefined) return Math.max(0, Math.min(stored, group.length - 1));
    return group.length - 1; // default: latest
  }

  getSiblings(msgId: string): TMessage[] {
    return this._tree.getSiblings(msgId);
  }

  hasSiblings(msgId: string): boolean {
    return this._tree.hasSiblings(msgId);
  }

  getNode(msgId: string): TreeNode<TMessage> | undefined {
    return this._tree.getNode(msgId);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  // Spec: AIT-CT3, AIT-CT4
  async send(input: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> {
    this._logger.trace('DefaultView.send();');

    // Capture sibling count before the delegate so we can detect whether
    // an optimistic insert actually added a new sibling (edit) or not (regenerate).
    const siblingsBefore = options?.forkOf ? this._tree.getSiblings(options.forkOf).length : 0;

    const result = await this._sendDelegate(input, options, { flattenNodes: () => this.flattenNodes() });

    // Spec: AIT-CT13e
    // Auto-select the new fork in this view when creating a fork.
    // The delegate's optimistic insert created the sibling — pin this
    // view to the latest (new) sibling so the user sees their edit/regeneration.
    if (options?.forkOf) {
      const groupRoot = this._tree.getGroupRoot(options.forkOf);
      const siblings = this._tree.getSiblings(options.forkOf);
      if (siblings.length > siblingsBefore) {
        // Optimistic insert added a sibling — select it immediately.
        this._selections.set(groupRoot, siblings.length - 1);
        this._updateVisibleSnapshot();
        this._emitter.emit('update');
      } else {
        // No new sibling yet (e.g. regenerate sends no user messages). Defer
        // auto-selection until the server response creates the new sibling.
        // Store the group root (not the raw forkOf) so _pinVisibleSelections
        // can match it regardless of which sibling is currently visible.
        this._pendingForkSelections.add(groupRoot);
        this._logger.debug('DefaultView.send(); deferring fork auto-selection', { forkOf: options.forkOf, groupRoot });
      }
    }

    return result;
  }

  // Spec: AIT-CT5
  async regenerate(messageId: string, options?: SendOptions): Promise<ActiveTurn<TEvent>> {
    this._logger.trace('DefaultView.regenerate();', { messageId });

    const node = this._tree.getNode(messageId);
    if (!node) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentId = node.parentId;

    return this.send([], {
      ...options,
      body: {
        history: this._getHistoryBefore(messageId),
        ...options?.body,
      },
      forkOf: messageId,
      parent: parentId,
    });
  }

  // Spec: AIT-CT6
  async edit(
    messageId: string,
    newMessages: TMessage | TMessage[],
    options?: SendOptions,
  ): Promise<ActiveTurn<TEvent>> {
    this._logger.trace('DefaultView.edit();', { messageId });

    const node = this._tree.getNode(messageId);
    if (!node) {
      throw new Ably.ErrorInfo(
        `unable to edit; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentId = node.parentId;

    return this.send(newMessages, {
      ...options,
      body: {
        history: this._getHistoryBefore(messageId),
        ...options?.body,
      },
      forkOf: messageId,
      parent: parentId,
    });
  }

  private _getHistoryBefore(messageId: string): TreeNode<TMessage>[] {
    this._logger.trace('DefaultView._getHistoryBefore();', { messageId });
    const all = this.flattenNodes();
    const idx = all.findIndex((n) => n.msgId === messageId);
    if (idx === -1) {
      this._logger.warn('DefaultView._getHistoryBefore(); target not in visible nodes, returning full list', {
        messageId,
      });
      return all;
    }
    return all.slice(0, idx);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  // Spec: AIT-CT17
  getActiveTurnIds(): Map<string, Set<string>> {
    this._logger.trace('DefaultView.getActiveTurnIds();');
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

  // Spec: AIT-CT8a, AIT-CT8b, AIT-CT8e
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
    this._logger.info('DefaultView.close();');
    this._closed = true;
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._selections.clear();
    this._pendingForkSelections.clear();
    this._withheldMsgIds.clear();
    this._withheldBuffer.length = 0;
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  private async _loadFirstPage(limit: number): Promise<void> {
    // Snapshot before loading — everything already in the tree stays visible
    const beforeMsgIds = new Set(this._tree.flattenNodes(this._selections).map((n) => n.msgId));

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
    const alreadyKnown = new Set(this._tree.flattenNodes(this._selections).map((n) => n.msgId));

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
      for (const n of this._tree.flattenNodes(this._selections)) {
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

    const newVisible = this._tree.flattenNodes(this._selections).filter((n) => !beforeMsgIds.has(n.msgId));
    return { newVisible, lastPage: page };
  }

  // Spec: AIT-CT11a
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

  private _computeVisibleNodes(): TreeNode<TMessage>[] {
    return this.flattenNodes();
  }

  private _updateVisibleSnapshot(): void {
    const nodes = this._computeVisibleNodes();
    this._lastVisibleIds = nodes.map((n) => n.msgId);
    this._lastVisibleMessages = nodes.map((n) => n.message);
  }

  private _onTreeUpdate(): void {
    // Pin selections for previously-visible nodes that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinVisibleSelections();

    const nodes = this._computeVisibleNodes();
    const newIds = nodes.map((n) => n.msgId);
    const newMessages = nodes.map((n) => n.message);
    if (this._visibleChanged(newIds, newMessages)) {
      this._lastVisibleIds = newIds;
      this._lastVisibleMessages = newMessages;
      this._emitter.emit('update');
    }
  }

  /**
   * For each previously-visible message that now has siblings but no
   * explicit selection, pin the selection to that message's index.
   * This preserves the current branch when new forks appear from
   * other views or external sources.
   *
   * Exception: if the fork was initiated by this view (tracked in
   * `_pendingForkSelections`), select the newest sibling instead of
   * pinning the old one. This handles regenerate, where no optimistic
   * insert was possible at send time.
   */
  private _pinVisibleSelections(): void {
    for (const msgId of this._lastVisibleIds) {
      if (!this._tree.hasSiblings(msgId)) continue;
      const groupRoot = this._tree.getGroupRoot(msgId);

      // Spec: AIT-CT13e
      // Check if this fork was initiated by this view (e.g. regenerate).
      // If so, select the newest sibling and clear the pending state.
      // The pending set stores the forkOf msgId (the group root), but the
      // visible list may contain a different sibling — so check via groupRoot.
      if (this._pendingForkSelections.has(groupRoot)) {
        const siblings = this._tree.getSiblings(msgId);
        const index = siblings.length - 1;
        this._logger.debug('DefaultView._pinVisibleSelections(); auto-selecting pending fork', { msgId, index });
        this._selections.set(groupRoot, index);
        this._pendingForkSelections.delete(groupRoot);
        continue;
      }

      // Spec: AIT-CT13f
      // External fork — pin to the currently-visible sibling.
      if (this._selections.has(groupRoot)) continue;
      const idx = this._tree.getSiblingIndex(msgId);
      if (idx >= 0) {
        this._selections.set(groupRoot, idx);
      }
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
    // Check that msgId is on the visible branch and not withheld
    if (this._lastVisibleIds.includes(msgId)) {
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

  private _visibleChanged(newIds: string[], newMessages: TMessage[]): boolean {
    if (newIds.length !== this._lastVisibleIds.length) return true;
    for (const [i, newId] of newIds.entries()) {
      if (newId !== this._lastVisibleIds[i]) return true;
    }
    // Also detect in-place content updates (e.g. streaming) via reference comparison
    for (const [i, msg] of newMessages.entries()) {
      if (msg !== this._lastVisibleMessages[i]) return true;
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
