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

import { EVENT_TURN_END, EVENT_TURN_START, HEADER_MSG_ID, HEADER_TURN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import type { TreeInternal } from './tree.js';
import type {
  ActiveTurn,
  EventNode,
  PaginatedMessages,
  SendOptions,
  TreeNode,
  TurnLifecycleEvent,
  View,
} from './types.js';

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
 * Internal delegate function provided by the transport for executing sends.
 * The View pre-computes the visible branch history and passes it directly,
 * so the delegate has no back-reference to the View.
 * When `amendments` is provided, the transport includes them in the POST body
 * for the server to publish as cross-turn amendments.
 */
export type SendDelegate<TEvent, TMessage> = (
  input: TMessage | TMessage[],
  options: SendOptions | undefined,
  history: TreeNode<TMessage>[],
  amendments?: EventNode<TEvent>[],
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
  /** Called when the view is closed, allowing the owner to clean up references. */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Branch selection
// ---------------------------------------------------------------------------

/**
 * Tagged union representing why a branch was selected.
 * Stored per group root in the View's `_branchSelections` map.
 */
type BranchSelection =
  /** Explicit navigation via `select()`. */
  | { kind: 'user'; selectedId: string }
  /** This view initiated a fork (edit or regenerate) — auto-selected the result. */
  | { kind: 'auto'; selectedId: string }
  /** An external fork appeared — pinned to the currently-visible sibling to prevent drift. */
  | { kind: 'pinned'; selectedId: string }
  /** This view's `regenerate()` is in flight — select newest when turn's response arrives. */
  | { kind: 'pending'; turnId: string };

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
  private readonly _onClose?: () => void;

  /**
   * View-local branch selections: group root msgId → selection intent.
   * Fork points not present here default to the latest sibling.
   * Replaces the previous numeric-index _selections and _pendingForkSelections
   * with a single tagged-union map that carries the selected msgId (not index)
   * and the reason for the selection.
   */
  private readonly _branchSelections = new Map<string, BranchSelection>();

  /** Spec: AIT-CT11c — msg-ids loaded from history but not yet revealed to the UI. */
  private readonly _withheldMsgIds = new Set<string>();

  /** Snapshot of visible msgIds — used to detect structural changes and for selection pinning. */
  private _lastVisibleIds: string[] = [];

  /** Snapshot of visible message references — used to detect in-place content updates (streaming). */
  private _lastVisibleMessages: TMessage[] = [];

  /** Cached set of turn IDs present on the visible branch — avoids recomputing flattenNodes() on turn events. */
  private _lastVisibleTurnIds = new Set<string>();

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: PaginatedMessages<TMessage> | undefined;

  /** Buffer of withheld nodes, drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: TreeNode<TMessage>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  private _loadingOlder = false;
  private _processingHistory = false;
  private _closed = false;

  constructor(options: ViewOptions<TEvent, TMessage>) {
    this._tree = options.tree;
    this._channel = options.channel;
    this._codec = options.codec;
    this._sendDelegate = options.sendDelegate;
    this._onClose = options.onClose;
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
    const nodes = this._tree.flattenNodes(this._resolveSelections());
    if (this._withheldMsgIds.size === 0) return nodes;
    return nodes.filter((n) => !this._withheldMsgIds.has(n.msgId));
  }

  hasOlder(): boolean {
    return this._withheldBuffer.length > 0 || this._hasMoreHistory;
  }

  async loadOlder(limit = 100): Promise<void> {
    if (this._closed || this._loadingOlder) return;
    this._logger.trace('DefaultView.loadOlder();', { limit });
    this._loadingOlder = true;

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
      // Re-check: close() may be called during the await from another call stack
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may be called during await
      if (this._closed || !nextPage) {
        if (!nextPage) this._hasMoreHistory = false;
        return;
      }

      await this._loadAndReveal(nextPage, limit);
    } catch (error) {
      this._logger.error('DefaultView.loadOlder(); failed', { error });
      throw error;
    } finally {
      this._loadingOlder = false;
    }
  }

  // -------------------------------------------------------------------------
  // Branch navigation
  // -------------------------------------------------------------------------

  // Spec: AIT-CT13c
  select(msgId: string, index: number): void {
    this._logger.trace('DefaultView.select();', { msgId, index });
    const nodes = this._tree.getSiblingNodes(msgId);
    if (nodes.length <= 1) return;
    const groupRootId = this._tree.getGroupRoot(msgId);
    const clamped = Math.max(0, Math.min(index, nodes.length - 1));
    const selected = nodes[clamped];
    if (!selected) return; // unreachable: clamped is always in bounds
    this._branchSelections.set(groupRootId, { kind: 'user', selectedId: selected.msgId });
    this._logger.debug('DefaultView.select();', { msgId, index: clamped, selectedId: selected.msgId });
    this._updateVisibleSnapshot();
    this._emitter.emit('update');
  }

  getSelectedIndex(msgId: string): number {
    this._logger.trace('DefaultView.getSelectedIndex();', { msgId });
    const nodes = this._tree.getSiblingNodes(msgId);
    if (nodes.length <= 1) return 0;
    const groupRootId = this._tree.getGroupRoot(msgId);
    const sel = this._branchSelections.get(groupRootId);
    if (!sel || sel.kind === 'pending') return nodes.length - 1; // default: latest
    const idx = nodes.findIndex((n) => n.msgId === sel.selectedId);
    if (idx === -1) return nodes.length - 1; // fallback if stale
    return idx;
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
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // Pre-compute visible branch history before the delegate call so the
    // transport has no back-reference to the View (one-way dependency).
    const history = this.flattenNodes();
    const result = await this._sendDelegate(input, options, history);

    // Spec: AIT-CT13e
    // Auto-select the new fork in this view when creating a fork.
    if (options?.forkOf) {
      const groupRoot = this._tree.getGroupRoot(options.forkOf);

      if (result.optimisticMsgIds.length > 0) {
        // The delegate optimistically inserted user messages (edit path).
        // Auto-select the last optimistic msgId — this is deterministic and
        // avoids the sibling-count race that exists when inferring from tree state.
        const lastMsgId = result.optimisticMsgIds.at(-1);
        if (lastMsgId) {
          this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: lastMsgId });
          this._updateVisibleSnapshot();
          this._emitter.emit('update');
        }
      } else {
        // No optimistic insert (e.g. regenerate sends no user messages). Defer
        // auto-selection until the server response creates the new sibling.
        // Store the group root (not the raw forkOf) so _pinBranchSelections
        // can match it regardless of which sibling is currently visible.
        this._branchSelections.set(groupRoot, { kind: 'pending', turnId: result.turnId });
        this._logger.debug('DefaultView.send(); deferring fork auto-selection', {
          forkOf: options.forkOf,
          groupRoot,
          turnId: result.turnId,
        });

        // Bound pending entry lifetime to the turn — clean up on turn-end.
        const turnUnsub = this._tree.on('turn', (evt) => {
          if (evt.type !== EVENT_TURN_END || evt.turnId !== result.turnId) return;
          const sel = this._branchSelections.get(groupRoot);
          if (sel?.kind === 'pending' && sel.turnId === result.turnId) {
            this._branchSelections.delete(groupRoot);
          }
          turnUnsub();
          const idx = this._unsubs.indexOf(turnUnsub);
          if (idx !== -1) this._unsubs.splice(idx, 1);
        });
        this._unsubs.push(turnUnsub);
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

  async update(msgId: string, events: TEvent[], options?: SendOptions): Promise<ActiveTurn<TEvent>> {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to update; view is closed', ErrorCode.InvalidArgument, 400);
    }
    this._logger.trace('DefaultView.update();', { msgId, eventCount: events.length });
    const amendments: EventNode<TEvent>[] = [{ msgId, events }];
    return this._sendDelegate([], options, this.flattenNodes(), amendments);
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
    const result = new Map<string, Set<string>>();
    for (const [clientId, turnIds] of allTurns) {
      const filtered = new Set<string>();
      for (const turnId of turnIds) {
        if (this._lastVisibleTurnIds.has(turnId)) filtered.add(turnId);
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
    this._emitter.off();
    this._branchSelections.clear();
    this._withheldMsgIds.clear();
    this._withheldBuffer.length = 0;
    this._onClose?.();
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  private async _loadFirstPage(limit: number): Promise<void> {
    // Snapshot before loading — everything already in the tree stays visible
    const beforeMsgIds = new Set(this._tree.flattenNodes(this._resolveSelections()).map((n) => n.msgId));

    const firstPage = await decodeHistory(this._channel, this._codec, { limit }, this._logger);
    if (this._closed) return;
    const { newVisible, lastPage } = await this._loadUntilVisible(firstPage, limit, beforeMsgIds);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may be called during await
    if (this._closed) return;

    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();

    // Split into withheld (older, kept hidden) and released (newest, shown now).
    // Only add the actually-withheld messages to the set — adding all then
    // releasing would cause a spurious empty-list update if a tree event fires
    // between the two operations.
    const released = newVisible.slice(-limit);
    const withheld = newVisible.slice(0, -limit);
    for (const n of withheld) {
      this._withheldMsgIds.add(n.msgId);
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(released);
  }

  private async _loadAndReveal(page: PaginatedMessages<TMessage>, limit: number): Promise<void> {
    // Everything currently in the tree is "already known"
    const alreadyKnown = new Set(this._tree.flattenNodes(this._resolveSelections()).map((n) => n.msgId));

    const { newVisible, lastPage } = await this._loadUntilVisible(page, limit, alreadyKnown);
    if (this._closed) return;
    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();

    // Release the newest `limit` items; rest stays in buffer.
    // Only add actually-withheld messages to the set — adding all then
    // releasing would cause a spurious empty-list update if a tree event
    // fires between the two operations.
    const batch = newVisible.slice(-limit);
    const withheld = newVisible.slice(0, -limit);
    for (const n of withheld) {
      this._withheldMsgIds.add(n.msgId);
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
  }

  private _processHistoryPage(page: PaginatedMessages<TMessage>): void {
    this._processingHistory = true;
    try {
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
    } finally {
      this._processingHistory = false;
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
      for (const n of this._tree.flattenNodes(this._resolveSelections())) {
        if (!beforeMsgIds.has(n.msgId)) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage || this._closed) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._tree.flattenNodes(this._resolveSelections()).filter((n) => !beforeMsgIds.has(n.msgId));
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

  private _updateVisibleSnapshot(nodes?: TreeNode<TMessage>[]): void {
    const resolved = nodes ?? this.flattenNodes();
    this._lastVisibleIds = resolved.map((n) => n.msgId);
    this._lastVisibleMessages = resolved.map((n) => n.message);
    this._lastVisibleTurnIds = new Set<string>();
    for (const n of resolved) {
      const turnId = n.headers[HEADER_TURN_ID];
      if (turnId) this._lastVisibleTurnIds.add(turnId);
    }
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while processing history pages. During
    // _processHistoryPage, each tree.upsert() fires this handler synchronously
    // — but _withheldMsgIds hasn't been populated yet, so flattenNodes() would
    // return unfiltered history. Without this guard, subscribers briefly see all
    // history messages before the pagination window is applied. The final update
    // is emitted by _releaseWithheld after withholding is set up.
    // Scoped to _processingHistory (not _loadingOlder) so that live streaming
    // updates arriving during the async history fetch are still forwarded.
    if (this._processingHistory) return;

    // Pin selections for previously-visible nodes that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinBranchSelections();
    this._resolvePendingSelections();

    const nodes = this.flattenNodes();
    const newIds = nodes.map((n) => n.msgId);
    const newMessages = nodes.map((n) => n.message);
    if (this._visibleChanged(newIds, newMessages)) {
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  /**
   * Build a resolved selections map from `_branchSelections` for passing
   * to `tree.flattenNodes()`. Pending entries (no sibling yet) are omitted,
   * causing the tree to use the default (latest sibling).
   * @returns Resolved map of groupRoot → selectedMsgId.
   */
  private _resolveSelections(): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [groupRoot, sel] of this._branchSelections) {
      if (sel.kind === 'pending') continue;
      resolved.set(groupRoot, sel.selectedId);
    }
    return resolved;
  }

  /**
   * For each previously-visible message that now has siblings but no
   * explicit selection, pin the selection to that message's msgId.
   * This preserves the current branch when new forks appear from
   * other views or external sources.
   *
   * Exception: if the fork was initiated by this view (tracked as a
   * `pending` BranchSelection), select the newest sibling instead of
   * pinning the old one. This handles regenerate, where no optimistic
   * insert was possible at send time.
   */
  private _pinBranchSelections(): void {
    for (const msgId of this._lastVisibleIds) {
      if (!this._tree.hasSiblings(msgId)) continue;
      const groupRoot = this._tree.getGroupRoot(msgId);
      const existing = this._branchSelections.get(groupRoot);

      // Spec: AIT-CT13e
      // Check if this fork was initiated by this view (e.g. regenerate).
      // If so, select the newest sibling — but only if it belongs to the
      // pending turn. Without this check, a sibling from another view's
      // concurrent fork would be incorrectly auto-selected.
      if (existing?.kind === 'pending') {
        const nodes = this._tree.getSiblingNodes(msgId);
        const newest = nodes.at(-1);
        if (newest && newest.msgId !== msgId) {
          const newestTurnId = newest.headers[HEADER_TURN_ID];
          if (newestTurnId === existing.turnId) {
            this._logger.debug('DefaultView._pinBranchSelections(); auto-selecting pending fork', {
              msgId,
              newestId: newest.msgId,
              turnId: existing.turnId,
            });
            this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: newest.msgId });
          }
        }
        continue;
      }

      // Spec: AIT-CT13f
      // External fork — pin to the currently-visible sibling.
      if (existing) continue; // already have a selection
      this._branchSelections.set(groupRoot, { kind: 'pinned', selectedId: msgId });
    }
  }

  /**
   * Resolve pending selections that are no longer on the visible branch.
   * `_pinBranchSelections` only checks visible nodes, so if the user navigated
   * away before the server response arrived, the pending entry would linger.
   * This pass checks all pending entries against the tree directly.
   */
  private _resolvePendingSelections(): void {
    for (const [groupRoot, sel] of this._branchSelections) {
      if (sel.kind !== 'pending') continue;
      const nodes = this._tree.getSiblingNodes(groupRoot);
      if (nodes.length <= 1) continue;
      const newest = nodes.at(-1);
      if (!newest || newest.msgId === groupRoot) continue;
      const newestTurnId = newest.headers[HEADER_TURN_ID];
      if (newestTurnId === sel.turnId) {
        this._logger.debug('DefaultView._resolvePendingSelections(); resolving off-branch pending', {
          groupRoot,
          newestId: newest.msgId,
          turnId: sel.turnId,
        });
        this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: newest.msgId });
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
    // Check if any messages for this turn are already on the visible branch.
    if (this._lastVisibleTurnIds.has(event.turnId)) {
      this._emitter.emit('turn', event);
      return;
    }

    // For turn-start, use branch metadata to predict visibility before
    // messages arrive. Own turns have optimistic inserts (caught above).
    // Remote turns carry parent/forkOf from the server.
    if (event.type === EVENT_TURN_START && this._isTurnStartVisible(event)) {
      // Track the predicted turnId so the corresponding turn-end is not
      // dropped if it arrives before messages update the snapshot.
      this._lastVisibleTurnIds.add(event.turnId);
      this._emitter.emit('turn', event);
    }
  }

  /**
   * Predict whether a turn-start's messages will be visible on this view's branch
   * using the parent/forkOf metadata from the event.
   * @param event - The turn-start lifecycle event with optional branch metadata.
   * @returns True if the turn's messages are expected to be visible on this view's branch.
   */
  private _isTurnStartVisible(event: TurnLifecycleEvent & { type: typeof EVENT_TURN_START }): boolean {
    const { parent } = event;

    // No parent metadata — can't determine branch, forward as default.
    // This covers root turns (parent omitted) and backward compat.
    if (parent === undefined) return true;

    // Check if the parent is on the visible branch
    return this._lastVisibleIds.includes(parent);
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
