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
 * visible nodes, and 'run' only for runs with visible messages.
 */

import * as Ably from 'ably';

import { EVENT_RUN_END, EVENT_RUN_START, HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import type { TreeInternal } from './tree.js';
import type { ActiveRun, HistoryPage, MessageNode, RunLifecycleEvent, SendOptions, View } from './types.js';

// ---------------------------------------------------------------------------
// Events map
// ---------------------------------------------------------------------------

interface ViewEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
}

// ---------------------------------------------------------------------------
// Send delegate
// ---------------------------------------------------------------------------

/**
 * Internal delegate function provided by the session for executing sends.
 * The View pre-computes the visible branch history and passes it directly,
 * so the delegate has no back-reference to the View.
 *
 * `input` is the normalised richer shape — each entry pairs a TEvent
 * with an optional `domainMessageId` override. The View boundary
 * (`View.sendEvent`) normalises raw `TEvent` / `TEvent[]` inputs into
 * this shape so the delegate always sees the same structure.
 *
 * When `domainMessageId` is set on an entry, the SDK uses that value as
 * the wire `x-ably-codec-message-id` (and the optimistic fold's `meta.messageId`)
 * for that event instead of minting a fresh `crypto.randomUUID()`. Used
 * by chat-transport to publish continuation tool resolutions onto an
 * existing assistant's tree key.
 */
export type SendDelegate<TEvent, TMessage> = (
  input: { event: TEvent; domainMessageId?: string }[],
  options: SendOptions | undefined,
  history: MessageNode<TMessage>[],
) => Promise<ActiveRun<TEvent>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a View. */
export interface ViewOptions<TEvent, TProjection, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TMessage>;
  /** The Ably channel to load history from. */
  channel: Ably.RealtimeChannel;
  /** The codec for decoding history messages. */
  codec: Codec<TEvent, TProjection, TMessage>;
  /** Delegate for executing sends through the session. */
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
  /** This view's `regenerate()` is in flight — select newest when run's response arrives. */
  | { kind: 'pending'; runId: string };

// ---------------------------------------------------------------------------
// Send-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the three input shapes `View.sendEvent` accepts into the
 * single richer shape the SendDelegate consumes:
 * - `TEvent` (single event) → `[{ event }]`
 * - `TEvent[]` (array of raw events) → `events.map(e => ({ event: e }))`
 * - `Array<{ event, domainMessageId? }>` (richer shape) → passed through
 *
 * Discriminator: an array whose first element is a non-null object
 * carrying an `event` property is the richer shape. TEvents themselves
 * use a `type` discriminator and don't carry `event`.
 * @param input - The raw input from `View.sendEvent`.
 * @returns The richer per-entry shape.
 */
const _normaliseSendInput = <TEvent>(
  input: TEvent | TEvent[] | { event: TEvent; domainMessageId?: string }[],
): { event: TEvent; domainMessageId?: string }[] => {
  if (!Array.isArray(input)) {
    return [{ event: input }];
  }
  if (input.length === 0) return [];
  const first = input[0];
  if (typeof first === 'object' && first !== null && 'event' in first) {
    // CAST: discriminator above proves the array is the richer shape.
    return input as { event: TEvent; domainMessageId?: string }[];
  }
  // CAST: discriminator above proves the array is TEvent[].
  return (input as TEvent[]).map((event) => ({ event }));
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultView<TEvent, TProjection, TMessage> implements View<TEvent, TProjection, TMessage> {
  private readonly _tree: TreeInternal<TMessage>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TEvent, TProjection, TMessage>;
  private readonly _sendDelegate: SendDelegate<TEvent, TMessage>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;
  private readonly _onClose?: () => void;

  /**
   * View-local branch selections: group root codecMessageId → selection intent.
   * Fork points not present here default to the latest sibling.
   * Replaces the previous numeric-index _selections and _pendingForkSelections
   * with a single tagged-union map that carries the selected codecMessageId (not index)
   * and the reason for the selection.
   */
  private readonly _branchSelections = new Map<string, BranchSelection>();

  /** Spec: AIT-CT11c — codec-message-ids loaded from history but not yet revealed to the UI. */
  private readonly _withheldCodecMessageIds = new Set<string>();

  /** Snapshot of visible codecMessageIds — used to detect structural changes and for selection pinning. */
  private _lastVisibleIds: string[] = [];

  /** Snapshot of visible message references — used to detect in-place content updates (streaming). */
  private _lastVisibleMessages: TMessage[] = [];

  /** Cached set of run IDs present on the visible branch — avoids recomputing flattenNodes() on run events. */
  private _lastVisibleRunIds = new Set<string>();

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: HistoryPage<TMessage> | undefined;

  /** Buffer of withheld nodes, drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: MessageNode<TMessage>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  /**
   * Cached result of the last flattenNodes computation. Public `flattenNodes()`
   * returns this in O(1); internal callers use `_computeFlatNodes()` when a
   * fresh tree walk is needed (structural changes, selection changes, history reveal).
   */
  private _cachedNodes: MessageNode<TMessage>[] = [];

  /** Last seen tree structural version - used to distinguish content-only from structural updates. */
  private _lastStructuralVersion = -1;

  private _loadingOlder = false;
  private _processingHistory = false;
  private _closed = false;

  constructor(options: ViewOptions<TEvent, TProjection, TMessage>) {
    this._tree = options.tree;
    this._channel = options.channel;
    this._codec = options.codec;
    this._sendDelegate = options.sendDelegate;
    this._onClose = options.onClose;
    this._logger = options.logger.withContext({ component: 'View' });
    this._logger.trace('DefaultView();');
    this._emitter = new EventEmitter<ViewEventsMap>(this._logger);

    // Compute initial cache and snapshot visible state
    this._cachedNodes = this._computeFlatNodes();
    this._lastStructuralVersion = this._tree.structuralVersion;
    this._updateVisibleSnapshot(this._cachedNodes);

    // Subscribe to tree events and re-emit scoped versions
    this._unsubs.push(
      this._tree.on('update', () => {
        this._onTreeUpdate();
      }),
      this._tree.on('ably-message', (msg) => {
        this._onTreeAblyMessage(msg);
      }),
      this._tree.on('run', (event) => {
        this._onTreeRun(event);
      }),
      this._tree.on('invocation-winner-changed', () => {
        this._onTreeWinningChange();
      }),
    );
  }

  /**
   * Re-filter the visible window when a run's winning invocation changes.
   * Bypasses the structural-version short-circuit because invocation-winner-changed
   * does not bump structuralVersion (the underlying nodes are the same;
   * only their visibility under the latest-serial rule changed).
   */
  private _onTreeWinningChange(): void {
    if (this._processingHistory) return;
    const nodes = this._computeFlatNodes();
    const newIds = nodes.map((n) => n.codecMessageId);
    const newMessages = nodes.map((n) => n.message);
    if (this._visibleChanged(newIds, newMessages)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  getMessages(): TMessage[] {
    return this.flattenNodes().map((n) => n.message);
  }

  // Spec: AIT-CT9, AIT-CT11c
  flattenNodes(): MessageNode<TMessage>[] {
    return this._cachedNodes;
  }

  /**
   * Walk the tree and compute a fresh visible node list, applying branch
   * selections, withheld-message filtering, and the latest-serial-wins
   * defensive rule for invocation retries. Use this instead of the public
   * `flattenNodes()` when the cache may be stale (structural changes,
   * selection changes, history reveal, winner change).
   * @returns A fresh array of visible nodes.
   */
  private _computeFlatNodes(): MessageNode<TMessage>[] {
    const nodes = this._tree.flattenNodes(this._resolveSelections());
    return nodes.filter((n) => {
      if (this._withheldCodecMessageIds.has(n.codecMessageId)) return false;
      return !this._isLosingInvocationNode(n);
    });
  }

  /**
   * Whether a node belongs to a losing invocation under its run-id.
   *
   * Defensive rule: within a run-id, the winning invocation is the one whose
   * user-message has the highest Ably serial (tracked by Tree). Messages with
   * a serial *before* the winning user-message's serial are losers and should
   * be hidden from the view. Optimistic (null-serial) nodes are kept — they
   * are the just-sent items not yet acked.
   * @param node - The message node to evaluate.
   * @returns True if the node's serial precedes the winning invocation's serial.
   */
  private _isLosingInvocationNode(node: MessageNode<TMessage>): boolean {
    const runId = node.headers[HEADER_RUN_ID];
    if (!runId) return false;
    const winner = this._tree.getWinningInvocation(runId);
    if (!winner) return false;
    if (!node.serial) return false;
    return node.serial < winner.serial;
  }

  hasOlder(): boolean {
    return this._withheldBuffer.length > 0 || this._hasMoreHistory;
  }

  async loadOlder(limit = 100): Promise<void> {
    if (this._closed || this._loadingOlder) return;
    this._loadingOlder = true;
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
  select(codecMessageId: string, index: number): void {
    this._logger.trace('DefaultView.select();', { codecMessageId, index });
    const nodes = this._tree.getSiblingNodes(codecMessageId);
    if (nodes.length <= 1) return;
    const groupRootId = this._tree.getGroupRoot(codecMessageId);
    const clamped = Math.max(0, Math.min(index, nodes.length - 1));
    const selected = nodes[clamped];
    if (!selected) return; // unreachable: clamped is always in bounds
    this._branchSelections.set(groupRootId, { kind: 'user', selectedId: selected.codecMessageId });
    this._logger.debug('DefaultView.select();', {
      codecMessageId,
      index: clamped,
      selectedId: selected.codecMessageId,
    });
    this._cachedNodes = this._computeFlatNodes();
    this._updateVisibleSnapshot(this._cachedNodes);
    this._emitter.emit('update');
  }

  getSelectedIndex(codecMessageId: string): number {
    this._logger.trace('DefaultView.getSelectedIndex();', { codecMessageId });
    const nodes = this._tree.getSiblingNodes(codecMessageId);
    if (nodes.length <= 1) return 0;
    const groupRootId = this._tree.getGroupRoot(codecMessageId);
    const sel = this._branchSelections.get(groupRootId);
    if (!sel || sel.kind === 'pending') return nodes.length - 1; // default: latest
    const idx = nodes.findIndex((n) => n.codecMessageId === sel.selectedId);
    if (idx === -1) return nodes.length - 1; // fallback if stale
    return idx;
  }

  getSiblings(codecMessageId: string): TMessage[] {
    return this._tree.getSiblings(codecMessageId);
  }

  hasSiblings(codecMessageId: string): boolean {
    return this._tree.hasSiblings(codecMessageId);
  }

  getNode(codecMessageId: string): MessageNode<TMessage> | undefined {
    return this._tree.getNode(codecMessageId);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  async sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.sendMessage();');
    const list = Array.isArray(messages) ? messages : [messages];
    const events = list.map((m) => this._codec.userMessageEvent(m));
    return this.sendEvent(events, options);
  }

  // Spec: AIT-CT3, AIT-CT4
  async sendEvent(
    input: TEvent | TEvent[] | { event: TEvent; domainMessageId?: string }[],
    options?: SendOptions,
  ): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.sendEvent();');
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // Normalise to the richer per-entry shape — a single delegate
    // signature handles all three input forms.
    const normalised = _normaliseSendInput<TEvent>(input);

    // Pre-compute visible branch history before the delegate call so the
    // session has no back-reference to the View (one-way dependency).
    const history = this.flattenNodes();
    const result = await this._sendDelegate(normalised, options, history);
    this._applyForkAutoSelect(result, options);
    return result;
  }

  /**
   * Auto-select / pin branch selections after a forking send.
   * @param result - The ActiveRun returned by the delegate.
   * @param options - The SendOptions passed by the caller.
   */
  private _applyForkAutoSelect(result: ActiveRun<TEvent>, options: SendOptions | undefined): void {
    // Spec: AIT-CT13e
    if (!options?.forkOf) return;

    const groupRoot = this._tree.getGroupRoot(options.forkOf);

    if (result.optimisticCodecMessageIds.length > 0) {
      // The delegate optimistically inserted user messages (edit path).
      // Auto-select the last optimistic codecMessageId — this is deterministic and
      // avoids the sibling-count race that exists when inferring from tree state.
      const lastCodecMessageId = result.optimisticCodecMessageIds.at(-1);
      if (lastCodecMessageId) {
        this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: lastCodecMessageId });
        this._cachedNodes = this._computeFlatNodes();
        this._updateVisibleSnapshot(this._cachedNodes);
        this._emitter.emit('update');
      }
      return;
    }

    // No optimistic insert (e.g. regenerate reuses the existing user
    // codec-message-id, so no new node appears upfront). Defer auto-selection until
    // the server response creates the new assistant sibling. Store the
    // group root (not the raw forkOf) so _pinBranchSelections can match
    // regardless of which sibling is currently visible.
    this._branchSelections.set(groupRoot, { kind: 'pending', runId: result.runId });
    this._logger.debug('DefaultView._applyForkAutoSelect(); deferring fork auto-selection', {
      forkOf: options.forkOf,
      groupRoot,
      runId: result.runId,
    });

    // Bound pending entry lifetime to the run — clean up on run-end.
    const runUnsub = this._tree.on('run', (evt) => {
      if (evt.type !== EVENT_RUN_END || evt.runId !== result.runId) return;
      const sel = this._branchSelections.get(groupRoot);
      if (sel?.kind === 'pending' && sel.runId === result.runId) {
        this._branchSelections.delete(groupRoot);
      }
      runUnsub();
      const idx = this._unsubs.indexOf(runUnsub);
      if (idx !== -1) this._unsubs.splice(idx, 1);
    });
    this._unsubs.push(runUnsub);
  }

  // Spec: AIT-CT5
  async regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.regenerate();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to regenerate; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // `messageId` is the assistant being regenerated. The new assistant
    // streams as a sibling under the same parent user — A1 and A2 group
    // under U1 via the tree's existing forkOf machinery — and U1 is
    // never re-published.
    const targetNode = this._tree.getNode(messageId);
    if (!targetNode) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentNode = targetNode.parentId ? this._tree.getNode(targetNode.parentId) : undefined;
    if (!parentNode) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; parent user message not found for ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // History runs through U1 inclusive — the LLM receives the user
    // message it should re-answer. U1 is NOT republished on the wire;
    // the body carries it directly.
    const history = this._getHistoryThrough(parentNode.codecMessageId);

    const sendOptions: SendOptions = {
      ...options,
      body: {
        history: history.map((n) => n.message),
        ...options?.body,
      },
      forkOf: targetNode.codecMessageId,
      parent: parentNode.codecMessageId,
    };

    // Mint a regenerate event via the codec. The event is classified
    // as `kind: 'regenerate'` so `_internalSend` publishes the wire
    // (with `x-ably-fork-of: A1`, `x-ably-parent: U1` on transport
    // headers) without creating a tree node or folding the projection.
    // The agent's prompt-lookup catches the regenerate event by
    // `eventId` and reads the routing headers off the inbound wire
    // message.
    const regenerateEvent = this._codec.createRegenerateEvent(targetNode.codecMessageId, parentNode.codecMessageId);
    const result = await this._sendDelegate([{ event: regenerateEvent }], sendOptions, history);
    this._applyForkAutoSelect(result, sendOptions);
    return result;
  }

  private _getHistoryThrough(messageId: string): MessageNode<TMessage>[] {
    this._logger.trace('DefaultView._getHistoryThrough();', { messageId });
    const all = this.flattenNodes();
    const idx = all.findIndex((n) => n.codecMessageId === messageId);
    if (idx === -1) {
      this._logger.warn('DefaultView._getHistoryThrough(); target not in visible nodes, returning full list', {
        messageId,
      });
      return all;
    }
    return all.slice(0, idx + 1);
  }

  // Spec: AIT-CT6
  async edit(messageId: string, newEvents: TEvent | TEvent[], options?: SendOptions): Promise<ActiveRun<TEvent>> {
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

    return this.sendEvent(newEvents, {
      ...options,
      body: {
        history: this._getHistoryBefore(messageId).map((n) => n.message),
        ...options?.body,
      },
      forkOf: messageId,
      parent: parentId,
    });
  }

  private _getHistoryBefore(messageId: string): MessageNode<TMessage>[] {
    this._logger.trace('DefaultView._getHistoryBefore();', { messageId });
    const all = this.flattenNodes();
    const idx = all.findIndex((n) => n.codecMessageId === messageId);
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
  getActiveRunIds(): Map<string, Set<string>> {
    this._logger.trace('DefaultView.getActiveRunIds();');
    const allRuns = this._tree.getActiveRunIds();
    if (this._withheldCodecMessageIds.size === 0) return allRuns;

    // Filter to runs that have at least one visible message
    const result = new Map<string, Set<string>>();
    for (const [clientId, runIds] of allRuns) {
      const filtered = new Set<string>();
      for (const runId of runIds) {
        if (this._lastVisibleRunIds.has(runId)) filtered.add(runId);
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
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run',
    handler: (() => void) | ((msg: Ably.InboundMessage) => void) | ((event: RunLifecycleEvent) => void),
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
    this._loadingOlder = false;
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._emitter.off();
    this._branchSelections.clear();
    this._withheldCodecMessageIds.clear();
    this._withheldBuffer.length = 0;
    this._onClose?.();
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  private async _loadFirstPage(limit: number): Promise<void> {
    // Snapshot before loading — everything already in the tree stays visible
    const beforeCodecMessageIds = new Set(
      this._tree.flattenNodes(this._resolveSelections()).map((n) => n.codecMessageId),
    );

    const firstPage = await decodeHistory(this._channel, this._codec, { limit }, this._logger);
    if (this._closed) return;
    const { newVisible, lastPage } = await this._loadUntilVisible(firstPage, limit, beforeCodecMessageIds);
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
      this._withheldCodecMessageIds.add(n.codecMessageId);
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(released);
  }

  private async _loadAndReveal(page: HistoryPage<TMessage>, limit: number): Promise<void> {
    // Everything currently in the tree is "already known"
    const alreadyKnown = new Set(this._tree.flattenNodes(this._resolveSelections()).map((n) => n.codecMessageId));

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
      this._withheldCodecMessageIds.add(n.codecMessageId);
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
  }

  private _processHistoryPage(page: HistoryPage<TMessage>): void {
    this._processingHistory = true;
    try {
      for (const item of page.items) {
        const codecMessageId = item.headers[HEADER_CODEC_MESSAGE_ID];
        if (!codecMessageId) continue;
        this._tree.upsert(codecMessageId, item.message, item.headers, item.serial);
      }

      for (const msg of page.rawMessages) {
        this._tree.emitAblyMessage(msg);
      }
    } finally {
      this._processingHistory = false;
    }
  }

  private async _loadUntilVisible(
    firstPage: HistoryPage<TMessage>,
    target: number,
    beforeCodecMessageIds: Set<string>,
  ): Promise<{ newVisible: MessageNode<TMessage>[]; lastPage: HistoryPage<TMessage> }> {
    this._processHistoryPage(firstPage);
    let page = firstPage;

    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._tree.flattenNodes(this._resolveSelections())) {
        if (!beforeCodecMessageIds.has(n.codecMessageId)) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage || this._closed) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._tree
      .flattenNodes(this._resolveSelections())
      .filter((n) => !beforeCodecMessageIds.has(n.codecMessageId));
    return { newVisible, lastPage: page };
  }

  // Spec: AIT-CT11a
  private _releaseWithheld(nodes: MessageNode<TMessage>[]): void {
    for (const n of nodes) {
      this._withheldCodecMessageIds.delete(n.codecMessageId);
    }
    if (nodes.length > 0) {
      this._cachedNodes = this._computeFlatNodes();
      this._updateVisibleSnapshot(this._cachedNodes);
      this._emitter.emit('update');
    }
  }

  // -------------------------------------------------------------------------
  // Private: scoped event forwarding
  // -------------------------------------------------------------------------

  private _updateVisibleSnapshot(nodes?: MessageNode<TMessage>[]): void {
    const resolved = nodes ?? this.flattenNodes();
    this._lastVisibleIds = resolved.map((n) => n.codecMessageId);
    this._lastVisibleMessages = resolved.map((n) => n.message);
    this._lastVisibleRunIds = new Set<string>();
    for (const n of resolved) {
      const runId = n.headers[HEADER_RUN_ID];
      if (runId) this._lastVisibleRunIds.add(runId);
    }
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while processing history pages. During
    // _processHistoryPage, each tree.upsert() fires this handler synchronously
    // — but _withheldCodecMessageIds hasn't been populated yet, so flattenNodes() would
    // return unfiltered history. Without this guard, subscribers briefly see all
    // history messages before the pagination window is applied. The final update
    // is emitted by _releaseWithheld after withholding is set up.
    // Scoped to _processingHistory (not _loadingOlder) so that live streaming
    // updates arriving during the async history fetch are still forwarded.
    if (this._processingHistory) return;

    const currentVersion = this._tree.structuralVersion;

    // Content-only fast path: the tree structure hasn't changed (no new
    // nodes, deletions, or serial reorders), so the cached node list is
    // still structurally valid. The tree mutated an existing node's
    // .message in place - check if any visible message reference changed.
    // JS single-threaded: structuralVersion cannot change between the
    // check and the response within this synchronous handler invocation.
    if (currentVersion === this._lastStructuralVersion) {
      const changed = this._cachedNodes.some((node, i) => node.message !== this._lastVisibleMessages[i]);
      if (changed) {
        this._lastVisibleMessages = this._cachedNodes.map((n) => n.message);
        this._cachedNodes = [...this._cachedNodes];
        this._emitter.emit('update');
      }
      return;
    }

    // Structural update: full re-walk required.
    this._lastStructuralVersion = currentVersion;

    // Pin selections for previously-visible nodes that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinBranchSelections();
    this._resolvePendingSelections();

    const nodes = this._computeFlatNodes();
    const newIds = nodes.map((n) => n.codecMessageId);
    const newMessages = nodes.map((n) => n.message);
    if (this._visibleChanged(newIds, newMessages)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  /**
   * Build a resolved selections map from `_branchSelections` for passing
   * to `tree.flattenNodes()`. Pending entries (no sibling yet) are omitted,
   * causing the tree to use the default (latest sibling).
   * @returns Resolved map of groupRoot → selectedCodecMessageId.
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
   * explicit selection, pin the selection to that message's codecMessageId.
   * This preserves the current branch when new forks appear from
   * other views or external sources.
   *
   * Exception: if the fork was initiated by this view (tracked as a
   * `pending` BranchSelection), select the newest sibling instead of
   * pinning the old one. This handles regenerate, where no optimistic
   * insert was possible at send time.
   */
  private _pinBranchSelections(): void {
    for (const codecMessageId of this._lastVisibleIds) {
      if (!this._tree.hasSiblings(codecMessageId)) continue;
      const groupRoot = this._tree.getGroupRoot(codecMessageId);
      const existing = this._branchSelections.get(groupRoot);

      // Spec: AIT-CT13e
      // Check if this fork was initiated by this view (e.g. regenerate).
      // If so, select the newest sibling — but only if it belongs to the
      // pending run. Without this check, a sibling from another view's
      // concurrent fork would be incorrectly auto-selected.
      if (existing?.kind === 'pending') {
        const nodes = this._tree.getSiblingNodes(codecMessageId);
        const newest = nodes.at(-1);
        if (newest && newest.codecMessageId !== codecMessageId) {
          const newestRunId = newest.headers[HEADER_RUN_ID];
          if (newestRunId === existing.runId) {
            this._logger.debug('DefaultView._pinBranchSelections(); auto-selecting pending fork', {
              codecMessageId,
              newestId: newest.codecMessageId,
              runId: existing.runId,
            });
            this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: newest.codecMessageId });
          }
        }
        continue;
      }

      // Spec: AIT-CT13f
      // External fork — pin to the currently-visible sibling.
      if (existing) continue; // already have a selection
      this._branchSelections.set(groupRoot, { kind: 'pinned', selectedId: codecMessageId });
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
      if (!newest || newest.codecMessageId === groupRoot) continue;
      const newestRunId = newest.headers[HEADER_RUN_ID];
      if (newestRunId === sel.runId) {
        this._logger.debug('DefaultView._resolvePendingSelections(); resolving off-branch pending', {
          groupRoot,
          newestId: newest.codecMessageId,
          runId: sel.runId,
        });
        this._branchSelections.set(groupRoot, { kind: 'auto', selectedId: newest.codecMessageId });
      }
    }
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // Re-emit only if the message corresponds to a visible node
    const headers = getHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    if (!codecMessageId) {
      // Non-message events (run-start, run-end, cancel) — always forward
      this._emitter.emit('ably-message', msg);
      return;
    }
    // Check that codecMessageId is on the visible branch and not withheld
    if (this._lastVisibleIds.includes(codecMessageId)) {
      this._emitter.emit('ably-message', msg);
    }
  }

  private _onTreeRun(event: RunLifecycleEvent): void {
    // Check if any messages for this run are already on the visible branch.
    if (this._lastVisibleRunIds.has(event.runId)) {
      this._emitter.emit('run', event);
      return;
    }

    // For run-start, use branch metadata to predict visibility before
    // messages arrive. Own runs have optimistic inserts (caught above).
    // Remote runs carry parent/forkOf from the server.
    if (event.type === EVENT_RUN_START && this._isRunStartVisible(event)) {
      // Track the predicted runId so the corresponding run-end is not
      // dropped if it arrives before messages update the snapshot.
      this._lastVisibleRunIds.add(event.runId);
      this._emitter.emit('run', event);
    }
  }

  /**
   * Predict whether a run-start's messages will be visible on this view's branch
   * using the parent/forkOf metadata from the event.
   * @param event - The run-start lifecycle event with optional branch metadata.
   * @returns True if the run's messages are expected to be visible on this view's branch.
   */
  private _isRunStartVisible(event: RunLifecycleEvent & { type: typeof EVENT_RUN_START }): boolean {
    const { parent } = event;

    // No parent metadata — can't determine branch, forward as default.
    // This covers root runs (parent omitted) and backward compat.
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
export const createView = <TEvent, TProjection, TMessage>(
  options: ViewOptions<TEvent, TProjection, TMessage>,
): DefaultView<TEvent, TProjection, TMessage> => new DefaultView(options);
