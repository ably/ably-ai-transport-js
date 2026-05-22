/**
 * DefaultView — a paginated, branch-aware projection over the Tree.
 *
 * Wraps a Tree (RunNode-keyed) and manages a pagination window that controls
 * which Runs are visible to the UI. New live Runs appear immediately; older
 * Runs are revealed progressively via `loadOlder()`.
 *
 * `getMessages()` walks the visible Run chain (newest to root via parentRunId)
 * and concatenates each Run's `codec.getMessages(run.projection)` to produce
 * the flat TMessage[] the UI renders.
 *
 * Each View owns its own branch selection state and pagination window,
 * allowing multiple independent Views over the same Tree.
 *
 * Events are scoped to the visible window — 'update' only fires when the
 * visible output changes, 'ably-message' only for messages corresponding to
 * visible Runs, and 'run' only for runs with visible content.
 */

import * as Ably from 'ably';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import type { TreeInternal } from './tree.js';
import type { ActiveRun, HistoryPage, RunEndReason, RunLifecycleEvent, RunNode, SendOptions, View } from './types.js';

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
 * The View pre-computes the visible branch's flat message list and the
 * codec-message-id of its tail (for auto-parent routing) before calling the delegate,
 * so the delegate has no back-reference to the View.
 *
 * `input` is the normalised richer shape — each entry pairs a TEvent
 * with an optional `domainMessageId` override. The View boundary
 * (`View.sendEvent`) normalises raw `TEvent` / `TEvent[]` inputs into
 * this shape so the delegate always sees the same structure.
 *
 * `parentCodecMessageId` is the codec-message-id of the last message in the visible branch
 * (extracted from the tail Run's projection per codec convention), or
 * `undefined` for an empty conversation. The session uses it as the
 * auto-parent for fresh user messages.
 */
export type SendDelegate<TEvent, TMessage> = (
  input: { event: TEvent; domainMessageId?: string }[],
  options: SendOptions | undefined,
  history: TMessage[],
  parentCodecMessageId: string | undefined,
) => Promise<ActiveRun<TEvent>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a View. */
export interface ViewOptions<TEvent, TProjection, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TEvent, TProjection>;
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
 * Stored per group-root runId in the View's `_branchSelections` map.
 */
type BranchSelection =
  /** Explicit navigation via `select()`. */
  | { kind: 'user'; selectedRunId: string }
  /** This view initiated a fork (edit) — auto-selected the result. */
  | { kind: 'auto'; selectedRunId: string }
  /** An external fork appeared — pinned to the currently-visible sibling to prevent drift. */
  | { kind: 'pinned'; selectedRunId: string }
  /** This view's `edit()` is in flight — select newest when run's response arrives. */
  | { kind: 'pending'; runId: string };

/**
 * Selection state for a regenerate group. Keyed by the anchor codec-message-id (the
 * assistant codec-message-id being regenerated). Distinct from {@link BranchSelection}
 * because regenerate groups are message-level (group members share an
 * anchor codec-message-id rather than a parentRunId), not Run-level forks.
 *
 * Unlike fork-of groups, regenerate groups do not "pin to current visible"
 * when a new member appears externally — the default for a regenerate
 * slot is always the latest member, so an external regenerator auto-rolls
 * forward unless the user has explicitly selected an earlier member.
 */
type RegenSelection =
  /** Explicit navigation via `select()`. */
  | { kind: 'user'; selectedRunId: string }
  /** This view initiated a regenerate — auto-selected the new Run when it arrived. */
  | { kind: 'auto'; selectedRunId: string }
  /** This view's `regenerate()` is in flight — promote to `auto` when the run's first content folds. */
  | { kind: 'pending'; runId: string };

// ---------------------------------------------------------------------------
// Send-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the three input shapes `View.sendEvent` accepts into the
 * single richer shape the SendDelegate consumes.
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
// Fetch tuning
// ---------------------------------------------------------------------------

/**
 * Multiplier applied to the user-supplied Run-unit `loadOlder(limit)`
 * when issuing the first `decodeHistory` page request. `decodeHistory`
 * counts complete domain *messages* per page, not Runs; a typical Run
 * produces ~2 messages (user + assistant). Asking for `limit * factor`
 * messages on the first page reduces extra round-trips when the actual
 * messages-per-Run ratio is around the factor. `_loadUntilVisible`
 * still loops on the Run count regardless, so this is purely a
 * fetch-efficiency hint.
 */
const _RUN_TO_MESSAGE_FETCH_FACTOR = 3;

// ---------------------------------------------------------------------------
// Helper: extract a TMessage's id via codec convention
// ---------------------------------------------------------------------------

/**
 * Codec convention: each TMessage's `id` field carries the wire `x-ably-codec-message-id`.
 * Used by the View to resolve a domain codec-message-id from a projection-extracted
 * message. This violates the rule that the core treats TMessage as opaque
 * — see AIT-801 alongside the existing peek sites in client-session
 * and agent-session.
 * @param message - A TMessage from `codec.getMessages(projection)`.
 * @returns The codec-message-id if the codec convention holds, otherwise undefined.
 */
const _readMessageId = (message: unknown): string | undefined =>
  // CAST: codec convention; see JSDoc above and AIT-801.
  (message as { id?: string }).id;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultView<TEvent, TProjection, TMessage> implements View<TEvent, TProjection, TMessage> {
  private readonly _tree: TreeInternal<TEvent, TProjection>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TEvent, TProjection, TMessage>;
  private readonly _sendDelegate: SendDelegate<TEvent, TMessage>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;
  private readonly _onClose?: () => void;

  /**
   * View-local branch selections: group-root runId → selection intent.
   * Fork points not present here default to the latest sibling.
   */
  private readonly _branchSelections = new Map<string, BranchSelection>();

  /**
   * View-local regenerate-group selections: anchor codec-message-id (the assistant
   * codec-message-id being regenerated) → selection intent. Distinct from
   * {@link _branchSelections} because regenerate groups don't share a
   * parentRunId — they're message-level alternatives at a single
   * conversation slot. Groups not present here default to the latest
   * member (the most recent regenerator, or the original if no regen has
   * landed).
   */
  private readonly _regenSelections = new Map<string, RegenSelection>();

  /** Spec: AIT-CT11c — runIds loaded from history but not yet revealed to the UI. */
  private readonly _withheldRunIds = new Set<string>();

  /** Snapshot of visible runIds — used to detect structural changes and for selection pinning. */
  private _lastVisibleRunIds: string[] = [];

  /**
   * Snapshot of visible projection references — used to detect in-place
   * projection updates (streaming). One entry per visible Run.
   */
  private _lastVisibleProjections: TProjection[] = [];

  /** Snapshot of visible flat messages — exposed via getMessages(). */
  private _lastVisibleMessages: TMessage[] = [];

  /** Cached visible-runIds Set — for O(1) lookup in event scoping. */
  private _lastVisibleRunIdSet = new Set<string>();

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: HistoryPage<TMessage> | undefined;

  /** Buffer of withheld Runs, drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: RunNode<TProjection>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  /**
   * Cached result of the last flattenNodes computation. Public `flattenNodes()`
   * returns this in O(1); internal callers use `_computeFlatNodes()` when a
   * fresh tree walk is needed (structural changes, selection changes, history reveal).
   */
  private _cachedNodes: RunNode<TProjection>[] = [];

  /** Last seen tree structural version - distinguishes content-only from structural updates. */
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
      this._tree.on('run-projection-updated', (event) => {
        this._onTreeProjectionUpdated(event);
      }),
      this._tree.on('invocation-winner-changed', () => {
        this._onTreeWinningChange();
      }),
    );
  }

  /**
   * Re-filter the visible window when a run's winning invocation changes.
   * Bypasses the structural-version short-circuit because invocation-winner-changed
   * does not bump structuralVersion (the underlying Run identities are the same;
   * only their projections may have shifted under the latest-serial rule).
   */
  private _onTreeWinningChange(): void {
    if (this._processingHistory) return;
    const nodes = this._computeFlatNodes();
    if (this._visibleChanged(nodes)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  /**
   * Handle a per-Run projection update (streaming delta). If the run is on
   * the visible chain, recompute the flat message list and emit `update`.
   * @param event - The projection-updated event from the Tree.
   * @param event.runId - The runId whose projection was updated.
   */
  private _onTreeProjectionUpdated(event: { runId: string }): void {
    if (this._processingHistory) return;
    if (!this._lastVisibleRunIdSet.has(event.runId)) return;

    // The Run identity list hasn't changed (no structural mutation), but the
    // visible projection at this index has new content. Recompute the flat
    // message list and emit.
    const messages = this._extractMessages(this._cachedNodes);
    const projections = this._cachedNodes.map((n) => n.projection);

    // Reference equality short-circuit: fires on every streaming chunk, so
    // suppressing no-op emits keeps the render loop O(visible_messages)
    // instead of O(total_subscribers * visible_messages). The Reducer
    // contract allows `fold` to mutate the projection in place, so a real
    // streaming delta produces the same projection reference but a new
    // TMessage at some index — caught by `messagesChanged`. A reducer that
    // returns the same projection AND the same TMessage references is a
    // no-op fold (e.g. idempotent re-fold past the high-water-mark serial).
    const projectionChanged = projections.some((p, i) => p !== this._lastVisibleProjections[i]);
    const messagesChanged =
      messages.length !== this._lastVisibleMessages.length ||
      messages.some((m, i) => m !== this._lastVisibleMessages[i]);

    if (!projectionChanged && !messagesChanged) return;

    this._lastVisibleProjections = projections;
    this._lastVisibleMessages = messages;
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  getMessages(): TMessage[] {
    return this._lastVisibleMessages;
  }

  // Spec: AIT-CT9, AIT-CT11c
  flattenNodes(): RunNode<TProjection>[] {
    return this._cachedNodes;
  }

  /**
   * Walk the tree and compute a fresh visible Run list, applying branch
   * selections, the withheld filter, and the regenerate-group filter.
   * @returns A fresh array of visible Runs.
   */
  private _computeFlatNodes(): RunNode<TProjection>[] {
    const treeNodes = this._tree.flattenNodes(this._resolveSelections());
    const visible: RunNode<TProjection>[] = [];
    for (const node of treeNodes) {
      if (this._withheldRunIds.has(node.runId)) continue;
      if (this._isRegenHiddenByGroupSelection(node)) continue;
      visible.push(node);
    }
    return visible;
  }

  /**
   * Whether `node` is hidden because its regenerate group has selected a
   * different member. Regenerator Runs that aren't the selected member
   * are filtered out of the visible chain; the owner Run (the one that
   * holds the regenerated codec-message-id) is always visible — only the
   * regenerated message itself is dropped by {@link _extractMessages}.
   * @param node - A Run from `tree.flattenNodes`.
   * @returns True if the View's regen selection excludes this Run.
   */
  private _isRegenHiddenByGroupSelection(node: RunNode<TProjection>): boolean {
    const regenTarget = node.regeneratesCodecMessageId;
    if (regenTarget === undefined) return false;
    const selectedRunId = this._resolveRegenSelection(regenTarget);
    return selectedRunId !== undefined && selectedRunId !== node.runId;
  }

  /**
   * Resolve the runId currently selected for the regenerate group anchored
   * at `anchorCodecMessageId`. Pending selections (no member yet on the chain)
   * fall back to the latest member; explicit / auto / pinned use their
   * stored target.
   * @param anchorCodecMessageId - The codec-message-id that anchors the group.
   * @returns The selected member's runId, or undefined if no selection
   *   has been recorded (caller treats undefined as "latest").
   */
  private _resolveRegenSelection(anchorCodecMessageId: string): string | undefined {
    const sel = this._regenSelections.get(anchorCodecMessageId);
    if (sel === undefined) return this._latestRegenMemberRunId(anchorCodecMessageId);
    if (sel.kind === 'pending') return this._latestRegenMemberRunId(anchorCodecMessageId);
    return sel.selectedRunId;
  }

  /**
   * The latest member runId for the regenerate group anchored at
   * `anchorCodecMessageId`. Returns undefined when the group has zero or one
   * members (one-member groups behave as if no regenerate happened —
   * the owner Run is the only visible member).
   * @param anchorCodecMessageId - The codec-message-id that anchors the group.
   * @returns The latest member's runId, or undefined for empty/single groups.
   */
  private _latestRegenMemberRunId(anchorCodecMessageId: string): string | undefined {
    const group = this._tree.getRegenerateGroupByMsgId(anchorCodecMessageId);
    if (group.length <= 1) return undefined;
    return group.at(-1)?.runId;
  }

  /**
   * Extract the flat TMessage[] from a visible Run chain by concatenating
   * each Run's `codec.getMessages(projection)` in chronological order,
   * then dropping any message whose codec-message-id has been regenerated by a
   * later visible Run (message-level replacement).
   * @param nodes - The visible Runs in chronological order.
   * @returns The flat message list across all Runs.
   */
  private _extractMessages(nodes: RunNode<TProjection>[]): TMessage[] {
    // Collect the codec-message-ids that will be replaced by a later visible
    // regenerator. Only regenerators visible after the regenerated codec-message-id
    // contribute — if the regenerator is hidden by group selection it
    // never reaches this collection.
    const replacedMsgIds = new Set<string>();
    for (const node of nodes) {
      if (node.regeneratesCodecMessageId !== undefined) {
        replacedMsgIds.add(node.regeneratesCodecMessageId);
      }
    }

    const messages: TMessage[] = [];
    for (const node of nodes) {
      for (const m of this._codec.getMessages(node.projection)) {
        const id = _readMessageId(m);
        if (id !== undefined && replacedMsgIds.has(id)) continue;
        messages.push(m);
      }
    }
    return messages;
  }

  hasOlder(): boolean {
    return this._withheldBuffer.length > 0 || this._hasMoreHistory;
  }

  /**
   * Reveal up to `limit` older Runs in this view.
   *
   * The pagination unit is the **Run**, not the message. A single Run
   * typically materialises into multiple messages (e.g. user + assistant
   * pair) so revealing `limit` Runs may add several messages to the flat
   * list returned by {@link getMessages}. Channel pages don't align to
   * Run boundaries, so {@link _loadUntilVisible} keeps fetching channel
   * pages until at least `limit` Runs are buffered (or the channel is
   * exhausted).
   * @param limit - Maximum number of older Runs to reveal. Defaults to 100.
   */
  async loadOlder(limit = 100): Promise<void> {
    if (this._closed || this._loadingOlder) return;
    this._loadingOlder = true;
    this._logger.trace('DefaultView.loadOlder();', { limit });

    try {
      // Drain withheld buffer first (older Runs, released newest-first).
      // Each Run in the buffer counts as one toward the limit.
      if (this._withheldBuffer.length > 0) {
        const batch = this._withheldBuffer.splice(-limit, limit);
        this._releaseWithheld(batch);
        return;
      }

      // Buffer exhausted - load from channel history.
      if (!this._hasMoreHistory && !this._lastHistoryPage) {
        await this._loadFirstPage(limit);
        return;
      }

      if (!this._hasMoreHistory) return;

      if (!this._lastHistoryPage?.hasNext()) {
        this._hasMoreHistory = false;
        return;
      }

      const nextPage = await this._lastHistoryPage.next();
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

  // Spec: AIT-CT13c, AIT-CT13d
  select(runId: string, index: number): void {
    this._logger.trace('DefaultView.select();', { runId, index });

    // Try fork-of group first; fall back to regenerate group.
    const forkNodes = this._tree.getSiblingRuns(runId);
    if (forkNodes.length > 1) {
      const groupRoot = this._tree.getGroupRoot(runId);
      const clamped = Math.max(0, Math.min(index, forkNodes.length - 1));
      const selected = forkNodes[clamped];
      if (!selected) return; // unreachable
      this._branchSelections.set(groupRoot, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.select(); fork-of', { runId, index: clamped, selectedRunId: selected.runId });
      this._cachedNodes = this._computeFlatNodes();
      this._updateVisibleSnapshot(this._cachedNodes);
      this._emitter.emit('update');
      return;
    }

    const regenGroup = this._tree.getRegenerateGroup(runId);
    if (regenGroup && regenGroup.runs.length > 1) {
      const clamped = Math.max(0, Math.min(index, regenGroup.runs.length - 1));
      const selected = regenGroup.runs[clamped];
      if (!selected) return; // unreachable
      this._regenSelections.set(regenGroup.anchorCodecMessageId, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.select(); regenerate', {
        runId,
        index: clamped,
        selectedRunId: selected.runId,
        anchorCodecMessageId: regenGroup.anchorCodecMessageId,
      });
      this._cachedNodes = this._computeFlatNodes();
      this._updateVisibleSnapshot(this._cachedNodes);
      this._emitter.emit('update');
    }
  }

  getSelectedIndex(runId: string): number {
    this._logger.trace('DefaultView.getSelectedIndex();', { runId });
    const forkNodes = this._tree.getSiblingRuns(runId);
    if (forkNodes.length > 1) {
      const groupRoot = this._tree.getGroupRoot(runId);
      const sel = this._branchSelections.get(groupRoot);
      if (!sel || sel.kind === 'pending') return forkNodes.length - 1;
      const idx = forkNodes.findIndex((n) => n.runId === sel.selectedRunId);
      return idx === -1 ? forkNodes.length - 1 : idx;
    }
    const regenGroup = this._tree.getRegenerateGroup(runId);
    if (regenGroup && regenGroup.runs.length > 1) {
      const sel = this._regenSelections.get(regenGroup.anchorCodecMessageId);
      if (!sel || sel.kind === 'pending') return regenGroup.runs.length - 1;
      const idx = regenGroup.runs.findIndex((n) => n.runId === sel.selectedRunId);
      return idx === -1 ? regenGroup.runs.length - 1 : idx;
    }
    return 0;
  }

  getSiblingRuns(runId: string): RunNode<TProjection>[] {
    const forkNodes = this._tree.getSiblingRuns(runId);
    if (forkNodes.length > 1) return forkNodes;
    const regenGroup = this._tree.getRegenerateGroup(runId);
    if (regenGroup && regenGroup.runs.length > 1) return regenGroup.runs;
    return forkNodes;
  }

  hasSiblingRuns(runId: string): boolean {
    if (this._tree.hasSiblingRuns(runId)) return true;
    const regenGroup = this._tree.getRegenerateGroup(runId);
    return regenGroup !== undefined && regenGroup.runs.length > 1;
  }

  // Spec: AIT-CT13c, AIT-CT13d — msg-anchored branch-point API
  // (companion to runId-based hasSiblingRuns/getSiblingRuns/select). The
  // RFC anchors branch points at codec-message-ids (event-id for edits, codec-message-id for
  // regens); these methods return per-bubble nav data so the UI doesn't
  // surface arrows on bubbles whose codec-message-id is not the actual anchor.

  hasMessageSiblings(codecMessageId: string): boolean {
    return this._resolveMessageBranchPoint(codecMessageId) !== undefined;
  }

  getMessageSiblings(codecMessageId: string): RunNode<TProjection>[] {
    return this._resolveMessageBranchPoint(codecMessageId)?.siblings ?? [];
  }

  getSelectedMessageSiblingIndex(codecMessageId: string): number {
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (!branch) return 0;
    if (branch.kind === 'fork-of') {
      const sel = this._branchSelections.get(branch.groupRoot);
      if (!sel || sel.kind === 'pending') return branch.siblings.length - 1;
      const idx = branch.siblings.findIndex((n) => n.runId === sel.selectedRunId);
      return idx === -1 ? branch.siblings.length - 1 : idx;
    }
    const sel = this._regenSelections.get(branch.anchorCodecMessageId);
    if (!sel || sel.kind === 'pending') return branch.siblings.length - 1;
    const idx = branch.siblings.findIndex((n) => n.runId === sel.selectedRunId);
    return idx === -1 ? branch.siblings.length - 1 : idx;
  }

  selectMessageSibling(codecMessageId: string, index: number): void {
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (!branch) return;
    const clamped = Math.max(0, Math.min(index, branch.siblings.length - 1));
    const selected = branch.siblings[clamped];
    if (!selected) return; // unreachable: clamped is always in bounds
    if (branch.kind === 'fork-of') {
      this._branchSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.selectMessageSibling(); fork-of', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.runId,
      });
    } else {
      this._regenSelections.set(branch.anchorCodecMessageId, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.selectMessageSibling(); regenerate', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.runId,
        anchorCodecMessageId: branch.anchorCodecMessageId,
      });
    }
    this._cachedNodes = this._computeFlatNodes();
    this._updateVisibleSnapshot(this._cachedNodes);
    this._emitter.emit('update');
  }

  /**
   * Resolve the branch point anchored at `codecMessageId`, if any.
   *
   * Returns the resolved group `kind` along with the sibling list so the
   * caller can update the correct selection map without re-entering the
   * runId-based `select()` dispatch (which biases to fork-of first and
   * would mis-route a regen-anchor codec-message-id when the owning Run is in
   * BOTH groups — e.g. R1 owns both a user prompt that got edited and
   * an assistant that got regenerated).
   *
   * Two anchor cases:
   * - **fork-of** — `codecMessageId` is the first message of a Run in a fork-of
   *   sibling group (edit-style branch point anchored at the user prompt).
   * - **regen** — `codecMessageId` is the regen-anchor itself (in the owner Run)
   *   or content of a regenerator Run (regen-style branch point anchored
   *   at the assistant slot).
   * @param codecMessageId - The codec-message-id to look up.
   * @returns The kind + sibling list + group key (runId for fork-of,
   *   anchor codec-message-id for regen), or undefined when `codecMessageId` is not an
   *   anchor in either group type.
   */
  private _resolveMessageBranchPoint(
    codecMessageId: string,
  ):
    | { kind: 'fork-of'; groupRoot: string; siblings: RunNode<TProjection>[] }
    | { kind: 'regen'; anchorCodecMessageId: string; siblings: RunNode<TProjection>[] }
    | undefined {
    const run = this._tree.getRunByCodecMessageId(codecMessageId);
    if (!run) return undefined;

    // Fork-of branch point: the first message of an edit Run is the
    // anchor (the user prompt the fork resolves at). The codec is the
    // source of truth for message order within a Run's projection.
    const forkSiblings = this._tree.getSiblingRuns(run.runId);
    if (forkSiblings.length > 1) {
      const firstMsg = this._codec.getMessages(run.projection).at(0);
      if (firstMsg && _readMessageId(firstMsg) === codecMessageId) {
        return { kind: 'fork-of', groupRoot: this._tree.getGroupRoot(run.runId), siblings: forkSiblings };
      }
    }

    // Regen branch point: codec-message-id is either the regen anchor itself (in
    // the owner Run) or content of a regenerator Run.
    const regenGroup = this._tree.getRegenerateGroup(run.runId);
    if (regenGroup && regenGroup.runs.length > 1) {
      if (codecMessageId === regenGroup.anchorCodecMessageId) {
        return { kind: 'regen', anchorCodecMessageId: regenGroup.anchorCodecMessageId, siblings: regenGroup.runs };
      }
      const ownerRun = this._tree.getRunByCodecMessageId(regenGroup.anchorCodecMessageId);
      if (ownerRun && run.runId !== ownerRun.runId) {
        return { kind: 'regen', anchorCodecMessageId: regenGroup.anchorCodecMessageId, siblings: regenGroup.runs };
      }
    }

    return undefined;
  }

  getRunNode(runId: string): RunNode<TProjection> | undefined {
    return this._tree.getRunNode(runId);
  }

  getRunByCodecMessageId(codecMessageId: string): RunNode<TProjection> | undefined {
    return this._tree.getRunByCodecMessageId(codecMessageId);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  async sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.sendMessage();');
    const list = Array.isArray(messages) ? messages : [messages];
    // Caller-supplied TMessage.id flows through as the wire HEADER_CODEC_MESSAGE_ID so
    // the codec convention `TMessage.id == wire codec-message-id` holds end-to-end
    // (decoded UIMessage.id matches the original, agent-side projection
    // doesn't get rebound to a fresh UUID).
    const items = list.map((m) => {
      const domainMessageId = _readMessageId(m);
      return domainMessageId !== undefined && domainMessageId !== ''
        ? { event: this._codec.userMessageEvent(m), domainMessageId }
        : { event: this._codec.userMessageEvent(m) };
    });
    return this.sendEvent(items, options);
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

    const normalised = _normaliseSendInput<TEvent>(input);

    // Pre-compute the visible branch's flat message list and the codec-message-id of
    // its tail. The delegate uses both: history for the HTTP POST body,
    // parentCodecMessageId for auto-parent routing on fresh user messages.
    const history = this.getMessages();
    const parentCodecMessageId = history.length > 0 ? _readMessageId(history.at(-1)) : undefined;

    const result = await this._sendDelegate(normalised, options, history, parentCodecMessageId);
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

    // Resolve the fork-target codec-message-id to its owning runId; pin/auto-select
    // operates at Run granularity.
    const forkTargetRun = this._tree.getRunByCodecMessageId(options.forkOf);
    if (!forkTargetRun) return;
    const groupRoot = this._tree.getGroupRoot(forkTargetRun.runId);

    if (result.optimisticCodecMessageIds.length > 0) {
      // The delegate optimistically inserted a user-message Run (edit path).
      // Auto-select the new sibling Run by its runId.
      this._branchSelections.set(groupRoot, { kind: 'auto', selectedRunId: result.runId });
      this._cachedNodes = this._computeFlatNodes();
      this._updateVisibleSnapshot(this._cachedNodes);
      this._emitter.emit('update');
      return;
    }

    // No optimistic insert (e.g. regenerate publishes wire-only). Defer
    // auto-selection until the new Run's first message arrives. Store the
    // group root so _pinBranchSelections can match regardless of which
    // sibling is currently visible.
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

  /**
   * Auto-select / pin the regenerate group anchored at `anchorCodecMessageId` so
   * the new Run's content appears as soon as the agent's run-start lands.
   *
   * `View.regenerate()` calls this with the assistant codec-message-id being
   * regenerated. The Run doesn't exist yet on the channel (the regenerate
   * wire is wire-only); the selection is recorded as `pending` and
   * promoted to `auto` by `_pinRegenSelections` once the corresponding
   * Run is created in the tree.
   * @param result - The ActiveRun returned by the delegate (run-id is the new regenerator's).
   * @param anchorCodecMessageId - The codec-message-id of the assistant being regenerated.
   */
  private _applyRegenerateAutoSelect(result: ActiveRun<TEvent>, anchorCodecMessageId: string): void {
    this._regenSelections.set(anchorCodecMessageId, { kind: 'pending', runId: result.runId });
    this._logger.debug('DefaultView._applyRegenerateAutoSelect(); deferring regenerate selection', {
      anchorCodecMessageId,
      runId: result.runId,
    });

    // Bound pending entry lifetime to the run — clean up on run-end.
    const runUnsub = this._tree.on('run', (evt) => {
      if (evt.type !== EVENT_RUN_END || evt.runId !== result.runId) return;
      const sel = this._regenSelections.get(anchorCodecMessageId);
      if (sel?.kind === 'pending' && sel.runId === result.runId) {
        this._regenSelections.delete(anchorCodecMessageId);
      }
      runUnsub();
      const idx = this._unsubs.indexOf(runUnsub);
      if (idx !== -1) this._unsubs.splice(idx, 1);
    });
    this._unsubs.push(runUnsub);
  }

  // Spec: AIT-CT5, AIT-CT13d
  async regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.regenerate();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to regenerate; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // `messageId` is the assistant being regenerated. The new Run is a
    // continuation of the regenerated message's Run, not a fork: the
    // message-level replacement (new assistant supersedes the original)
    // happens at projection extraction time. We still resolve the parent
    // user prompt so the new assistant's wire `x-ably-parent` is correct,
    // and we send the truncated history (through the parent inclusive)
    // so the LLM re-answers the right message.
    const targetRun = this._tree.getRunByCodecMessageId(messageId);
    if (!targetRun) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentCodecMessageId = this._findParentMsgId(targetRun, messageId);
    if (!parentCodecMessageId) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; parent user message not found for ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // Canonical regen anchor: when the user clicks Regenerate on an
    // already-regenerated assistant, the new alternative belongs to the
    // SAME branch point as the previous regen, not a nested point. The
    // anchor is the regen group's owner codec-message-id (the "original assistant"
    // at this conversation slot). Anchoring every regen at the same
    // codec-message-id grows a single group of alternatives ("N / N+1") instead
    // of producing nested two-member groups.
    const regenAnchorMsgId = targetRun.regeneratesCodecMessageId ?? messageId;

    const history = this._getHistoryThrough(parentCodecMessageId);

    const sendOptions: SendOptions = {
      ...options,
      body: {
        history,
        ...options?.body,
      },
      parent: parentCodecMessageId,
    };

    // Mint a regenerate event via the codec; classified as
    // `kind: 'regenerate'` with `regenerates: regenAnchorMsgId`. The
    // session publishes wire-only with `x-ably-msg-regenerate` /
    // `x-ably-parent` transport headers. The agent's prompt-lookup
    // catches it; no tree-upsert / projection fold runs locally.
    const regenerateEvent = this._codec.createRegenerateEvent(regenAnchorMsgId, parentCodecMessageId);
    const result = await this._sendDelegate([{ event: regenerateEvent }], sendOptions, history, parentCodecMessageId);
    this._applyRegenerateAutoSelect(result, regenAnchorMsgId);
    return result;
  }

  // Spec: AIT-CT6
  async edit(messageId: string, newEvents: TEvent | TEvent[], options?: SendOptions): Promise<ActiveRun<TEvent>> {
    this._logger.trace('DefaultView.edit();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to edit; view is closed', ErrorCode.InvalidArgument, 400);
    }

    const targetRun = this._tree.getRunByCodecMessageId(messageId);
    if (!targetRun) {
      throw new Ably.ErrorInfo(
        `unable to edit; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentCodecMessageId = this._findParentMsgId(targetRun, messageId);
    const history = this._getHistoryBefore(messageId);

    return this.sendEvent(newEvents, {
      ...options,
      body: {
        history,
        ...options?.body,
      },
      forkOf: messageId,
      parent: parentCodecMessageId,
    });
  }

  /**
   * Find the codec-message-id of the message immediately preceding `targetMsgId` in
   * the visible conversation.
   *
   * Consults the View's visible message chain first so message-level
   * replacements (regenerate) are respected: regenerating an
   * already-regenerated assistant lands the predecessor on the user
   * prompt the regen is responding to, NOT on the hidden original
   * assistant that occupies the same conversation slot. Falls back to a
   * projection-walk for the rare case where `targetMsgId` isn't on the
   * visible chain (e.g. caller is operating on a Run that's selection-
   * hidden by the current branch).
   * @param targetRun - The Run that owns `targetMsgId`.
   * @param targetMsgId - The codec-message-id to find the parent of.
   * @returns The parent codec-message-id, or undefined if no predecessor exists.
   */
  private _findParentMsgId(targetRun: RunNode<TProjection>, targetMsgId: string): string | undefined {
    const visible = this.getMessages();
    const visIdx = visible.findIndex((m) => _readMessageId(m) === targetMsgId);
    if (visIdx > 0) {
      const prev = visible[visIdx - 1];
      const id = prev ? _readMessageId(prev) : undefined;
      if (id !== undefined) return id;
    }
    if (visIdx === 0) return undefined;

    const messages = this._codec.getMessages(targetRun.projection);
    const idx = messages.findIndex((m) => _readMessageId(m) === targetMsgId);
    if (idx > 0) {
      const prev = messages[idx - 1];
      return prev ? _readMessageId(prev) : undefined;
    }
    if (idx === 0 && targetRun.parentRunId) {
      const parentRun = this._tree.getRunNode(targetRun.parentRunId);
      if (parentRun) {
        const parentMessages = this._codec.getMessages(parentRun.projection);
        const tail = parentMessages.at(-1);
        return tail ? _readMessageId(tail) : undefined;
      }
    }
    return undefined;
  }

  /**
   * Return the visible flat message list truncated to messages strictly
   * before `messageId`. Used for edit (history excludes the edited message).
   * @param messageId - The codec-message-id to slice the visible message list at.
   * @returns The flat message list strictly before `messageId`.
   */
  private _getHistoryBefore(messageId: string): TMessage[] {
    const all = this.getMessages();
    const idx = all.findIndex((m) => _readMessageId(m) === messageId);
    if (idx === -1) {
      this._logger.warn('DefaultView._getHistoryBefore(); target not in visible messages, returning full list', {
        messageId,
      });
      return all;
    }
    return all.slice(0, idx);
  }

  /**
   * Return the visible flat message list truncated through `messageId`
   * (inclusive). Used for regenerate (LLM gets the prompt back).
   * @param messageId - The codec-message-id to include as the last entry.
   * @returns The flat message list through `messageId` inclusive.
   */
  private _getHistoryThrough(messageId: string): TMessage[] {
    const all = this.getMessages();
    const idx = all.findIndex((m) => _readMessageId(m) === messageId);
    if (idx === -1) {
      this._logger.warn('DefaultView._getHistoryThrough(); target not in visible messages, returning full list', {
        messageId,
      });
      return all;
    }
    return all.slice(0, idx + 1);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  // Spec: AIT-CT17
  getActiveRunIds(): Map<string, Set<string>> {
    this._logger.trace('DefaultView.getActiveRunIds();');
    const allRuns = this._tree.getActiveRunIds();
    if (this._withheldRunIds.size === 0) return allRuns;

    // Filter to runs that are on the visible branch
    const result = new Map<string, Set<string>>();
    for (const [clientId, runIds] of allRuns) {
      const filtered = new Set<string>();
      for (const runId of runIds) {
        if (this._lastVisibleRunIdSet.has(runId)) filtered.add(runId);
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

  close(): void {
    if (this._closed) return;
    this._logger.info('DefaultView.close();');
    this._closed = true;
    this._loadingOlder = false;
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._emitter.off();
    this._branchSelections.clear();
    this._regenSelections.clear();
    this._withheldRunIds.clear();
    this._withheldBuffer.length = 0;
    this._onClose?.();
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  private async _loadFirstPage(limit: number): Promise<void> {
    // Snapshot before loading: every Run already in the tree stays visible.
    const beforeRunIds = new Set(this._tree.flattenNodes(this._resolveSelections()).map((n) => n.runId));

    // decodeHistory's limit counts complete domain messages per page (not
    // Runs); see `_RUN_TO_MESSAGE_FETCH_FACTOR` for the scaling rationale.
    const messageLimit = limit * _RUN_TO_MESSAGE_FETCH_FACTOR;
    const firstPage = await decodeHistory(this._channel, this._codec, { limit: messageLimit }, this._logger);
    if (this._closed) return;
    const { newVisible, lastPage } = await this._loadUntilVisible(firstPage, limit, beforeRunIds);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may be called during await
    if (this._closed) return;

    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();
    this._splitReveal(newVisible, limit);
  }

  private async _loadAndReveal(page: HistoryPage<TMessage>, limit: number): Promise<void> {
    const alreadyKnown = new Set(this._tree.flattenNodes(this._resolveSelections()).map((n) => n.runId));

    const { newVisible, lastPage } = await this._loadUntilVisible(page, limit, alreadyKnown);
    if (this._closed) return;
    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();
    this._splitReveal(newVisible, limit);
  }

  /**
   * Reveal the newest `limit` Runs from `newVisible` and withhold the rest
   * so subsequent `loadOlder` calls can drain them. Shared between
   * {@link _loadFirstPage} and {@link _loadAndReveal} so both follow the
   * same Run-unit pagination contract.
   * @param newVisible - Newly observed Runs from the history fetch.
   * @param limit - Max Runs to reveal in this batch.
   */
  private _splitReveal(newVisible: RunNode<TProjection>[], limit: number): void {
    const batch = newVisible.slice(-limit);
    const withheld = newVisible.slice(0, -limit);
    for (const n of withheld) {
      this._withheldRunIds.add(n.runId);
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
  }

  /**
   * Replay a history page's raw messages into the Tree. Dispatches by Ably
   * message name to run-lifecycle vs. regular wire messages, mirroring the
   * live `client-session._handleMessage` decode loop. Uses a fresh decoder
   * since the session's live decoder maintains its own stream-tracker state.
   * @param page - The history page returned by `decodeHistory`.
   */
  private _processHistoryPage(page: HistoryPage<TMessage>): void {
    this._processingHistory = true;
    try {
      const decoder = this._codec.createDecoder();
      for (const rawMsg of page.rawMessages) {
        const headers = getHeaders(rawMsg);
        const serial = rawMsg.serial;

        if (rawMsg.name === EVENT_RUN_START) {
          const runId = headers[HEADER_RUN_ID];
          if (runId) {
            const parentRaw = headers['x-ably-parent'];
            const forkOf = headers['x-ably-fork-of'];
            const regenerates = headers['x-ably-msg-regenerate'];
            const isContinuation = headers['x-ably-run-continue'] === 'true';
            this._tree.applyRunLifecycle(
              {
                type: EVENT_RUN_START,
                runId,
                clientId: headers['x-ably-run-client-id'] ?? '',
                invocationId: headers[HEADER_INVOCATION_ID] ?? '',
                ...(parentRaw !== undefined && { parent: parentRaw }),
                ...(forkOf !== undefined && { forkOf }),
                ...(regenerates !== undefined && { regenerates }),
                ...(isContinuation && { isContinuation: true }),
              },
              serial,
            );
          }
          continue;
        }

        if (rawMsg.name === EVENT_RUN_END) {
          const runId = headers[HEADER_RUN_ID];
          if (runId) {
            // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
            const reason = (headers['x-ably-run-reason'] ?? 'complete') as RunEndReason;
            this._tree.applyRunLifecycle(
              {
                type: EVENT_RUN_END,
                runId,
                clientId: headers['x-ably-run-client-id'] ?? '',
                reason,
              },
              serial,
            );
          }
          continue;
        }

        const events = decoder.decode(rawMsg);
        if (headers[HEADER_RUN_ID]) {
          this._tree.applyMessage(events, headers, serial);
        }
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
    beforeRunIds: Set<string>,
  ): Promise<{ newVisible: RunNode<TProjection>[]; lastPage: HistoryPage<TMessage> }> {
    this._processHistoryPage(firstPage);
    let page = firstPage;

    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._tree.flattenNodes(this._resolveSelections())) {
        if (!beforeRunIds.has(n.runId)) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage || this._closed) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._tree.flattenNodes(this._resolveSelections()).filter((n) => !beforeRunIds.has(n.runId));
    return { newVisible, lastPage: page };
  }

  // Spec: AIT-CT11a
  private _releaseWithheld(nodes: RunNode<TProjection>[]): void {
    for (const n of nodes) {
      this._withheldRunIds.delete(n.runId);
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

  private _updateVisibleSnapshot(nodes?: RunNode<TProjection>[]): void {
    const resolved = nodes ?? this._cachedNodes;
    this._lastVisibleRunIds = resolved.map((n) => n.runId);
    this._lastVisibleRunIdSet = new Set(this._lastVisibleRunIds);
    this._lastVisibleProjections = resolved.map((n) => n.projection);
    this._lastVisibleMessages = this._extractMessages(resolved);
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while processing history pages. During
    // _processHistoryPage, each tree.applyMessage() fires this handler
    // synchronously — but _withheldRunIds hasn't been populated yet, so
    // flattenNodes() would return unfiltered history. Without this guard,
    // subscribers briefly see all history Runs before the pagination window
    // is applied. The final update is emitted by _releaseWithheld after
    // withholding is set up.
    if (this._processingHistory) return;

    const currentVersion = this._tree.structuralVersion;

    // Content-only fast path: the tree structure hasn't changed (no new
    // Runs, deletions, or sort-reorders). Streaming projection updates
    // come through 'run-projection-updated' separately, so 'update' with
    // no structural change is rare — but possible (e.g. status fill on
    // run-end). Skip.
    if (currentVersion === this._lastStructuralVersion) {
      return;
    }

    // Structural update: full re-walk required.
    this._lastStructuralVersion = currentVersion;

    // Pin selections for previously-visible Runs that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinBranchSelections();
    this._resolvePendingSelections();
    this._resolvePendingRegenSelections();

    const nodes = this._computeFlatNodes();
    if (this._visibleChanged(nodes)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  /**
   * Build a resolved selections map from `_branchSelections` for passing to
   * `tree.flattenNodes()`. Pending entries (no sibling yet) are omitted,
   * causing the tree to use the default (latest sibling).
   * @returns Resolved map of groupRoot-runId → selectedRunId.
   */
  private _resolveSelections(): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [groupRoot, sel] of this._branchSelections) {
      if (sel.kind === 'pending') continue;
      resolved.set(groupRoot, sel.selectedRunId);
    }
    return resolved;
  }

  /**
   * For each previously-visible Run that now has siblings but no explicit
   * selection, pin the selection to that Run's runId. This preserves the
   * current branch when new forks appear from other views or external
   * sources.
   *
   * Exception: if the fork was initiated by this view (tracked as a
   * `pending` BranchSelection), select the newest sibling (the awaited Run)
   * instead of pinning the old one.
   */
  private _pinBranchSelections(): void {
    for (const runId of this._lastVisibleRunIds) {
      if (!this._tree.hasSiblingRuns(runId)) continue;
      const groupRoot = this._tree.getGroupRoot(runId);
      const existing = this._branchSelections.get(groupRoot);

      // Spec: AIT-CT13e
      if (existing?.kind === 'pending') {
        const nodes = this._tree.getSiblingRuns(runId);
        const newest = nodes.at(-1);
        if (newest && newest.runId !== runId && newest.runId === existing.runId) {
          this._logger.debug('DefaultView._pinBranchSelections(); auto-selecting pending fork', {
            runId,
            newestRunId: newest.runId,
          });
          this._branchSelections.set(groupRoot, { kind: 'auto', selectedRunId: newest.runId });
        }
        continue;
      }

      // Spec: AIT-CT13f
      // External fork — pin to the currently-visible sibling.
      if (existing) continue;
      this._branchSelections.set(groupRoot, { kind: 'pinned', selectedRunId: runId });
    }
  }

  /**
   * Promote `pending` regenerate selections to `auto` once the awaited Run
   * exists in the tree. Pending entries originate in
   * {@link _applyRegenerateAutoSelect}; this pass scans them and snaps to
   * the newest group member when the awaited runId becomes the latest.
   */
  private _resolvePendingRegenSelections(): void {
    for (const [anchorCodecMessageId, sel] of this._regenSelections) {
      if (sel.kind !== 'pending') continue;
      const group = this._tree.getRegenerateGroupByMsgId(anchorCodecMessageId);
      if (group.length <= 1) continue;
      const newest = group.at(-1);
      if (!newest) continue;
      if (newest.runId !== sel.runId) continue;
      this._regenSelections.set(anchorCodecMessageId, { kind: 'auto', selectedRunId: newest.runId });
    }
  }

  /**
   * Resolve pending selections that are no longer on the visible branch.
   * `_pinBranchSelections` only checks visible Runs, so if the user navigated
   * away before the server response arrived, the pending entry would linger.
   * This pass checks all pending entries against the tree directly.
   */
  private _resolvePendingSelections(): void {
    for (const [groupRoot, sel] of this._branchSelections) {
      if (sel.kind !== 'pending') continue;
      const nodes = this._tree.getSiblingRuns(groupRoot);
      if (nodes.length <= 1) continue;
      const newest = nodes.at(-1);
      if (!newest || newest.runId === groupRoot) continue;
      if (newest.runId === sel.runId) {
        this._logger.debug('DefaultView._resolvePendingSelections(); resolving off-branch pending', {
          groupRoot,
          newestRunId: newest.runId,
        });
        this._branchSelections.set(groupRoot, { kind: 'auto', selectedRunId: newest.runId });
      }
    }
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // Re-emit only if the message corresponds to a visible Run
    const headers = getHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    const runId = headers[HEADER_RUN_ID];

    if (!codecMessageId && !runId) {
      // Lifecycle / control events with no run/message identity (cancel, error)
      // are always forwarded.
      this._emitter.emit('ably-message', msg);
      return;
    }

    if (runId && this._lastVisibleRunIdSet.has(runId)) {
      this._emitter.emit('ably-message', msg);
    }
  }

  private _onTreeRun(event: RunLifecycleEvent): void {
    // Check if the run is already on the visible branch.
    if (this._lastVisibleRunIdSet.has(event.runId)) {
      this._emitter.emit('run', event);
      return;
    }

    // For run-start, use branch metadata to predict visibility before
    // messages arrive. Own runs have optimistic inserts (caught above).
    // Remote runs carry parent/forkOf from the agent.
    if (event.type === EVENT_RUN_START && this._isRunStartVisible(event)) {
      this._lastVisibleRunIdSet.add(event.runId);
      this._emitter.emit('run', event);
    }
  }

  /**
   * Predict whether a run-start's messages will be visible on this view's
   * branch using the parent/forkOf metadata from the event.
   * @param event - The run-start lifecycle event.
   * @returns True if the run is expected to be visible on this view's branch.
   */
  private _isRunStartVisible(event: RunLifecycleEvent & { type: typeof EVENT_RUN_START }): boolean {
    const { parent } = event;

    // No parent metadata — can't determine branch, forward as default.
    if (parent === undefined) return true;

    // The wire `parent` is a codec-message-id (the prior message). Resolve to its
    // owning runId, then check visibility.
    const parentRun = this._tree.getRunByCodecMessageId(parent);
    if (!parentRun) return true; // unknown parent: forward conservatively
    return this._lastVisibleRunIdSet.has(parentRun.runId);
  }

  private _visibleChanged(newNodes: RunNode<TProjection>[]): boolean {
    if (newNodes.length !== this._lastVisibleRunIds.length) return true;
    for (const [i, node] of newNodes.entries()) {
      if (node.runId !== this._lastVisibleRunIds[i]) return true;
      if (node.projection !== this._lastVisibleProjections[i]) return true;
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
