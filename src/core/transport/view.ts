/**
 * DefaultView — a paginated, branch-aware projection over the Tree.
 *
 * Wraps a Tree (RunNode-keyed) and manages a pagination window that controls
 * which Runs are visible to the UI. New live Runs appear immediately; older
 * Runs are revealed progressively via `loadOlder()`.
 *
 * `getMessages()` reads the Tree's visible node chain (input nodes + reply
 * runs, with sibling selection applied) and concatenates each node's
 * `codec.getMessages(node.projection)` to produce the flat
 * `CodecMessage<TMessage>[]` the UI renders.
 *
 * Each View owns its own branch selection state and pagination window,
 * allowing multiple independent Views over the same Tree.
 *
 * Events are scoped to the visible window — 'update' only fires when the
 * visible output changes, 'ably-message' only for messages corresponding to
 * visible Runs, and 'run' only for runs with visible content.
 */

import * as Ably from 'ably';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecMessage, CodecOutputEvent } from '../codec/types.js';
import { applyWireMessage } from './decode-fold.js';
import { loadHistory } from './load-history.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type {
  ActiveRun,
  BranchSelection,
  ConversationNode,
  HistoryPage,
  OutputEvent,
  RunInfo,
  RunLifecycleEvent,
  RunNode,
  SendOptions,
  View,
} from './types.js';

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
 * codec-message-id of its tail (for auto-parent routing) before calling
 * the delegate, so the delegate has no back-reference to the View.
 *
 * Each TInput carries its own routing metadata (`parent` / `target` /
 * `codecMessageId`) via the {@link CodecInputEvent} base; the delegate
 * reads those fields directly without runtime classification.
 *
 * `parentCodecMessageId` is the codec-message-id of the last message in
 * the visible branch (extracted from the tail Run's projection per codec
 * convention), or `undefined` for an empty conversation. The session
 * uses it as the auto-parent for fresh user messages.
 */
export type SendDelegate<TInput extends CodecInputEvent> = (
  input: TInput[],
  options: SendOptions | undefined,
  parentCodecMessageId: string | undefined,
) => Promise<ActiveRun>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a View. */
export interface ViewOptions<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The Ably channel to load history from. */
  channel: Ably.RealtimeChannel;
  /** The codec for decoding history messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** Delegate for executing sends through the session. */
  sendDelegate: SendDelegate<TInput>;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Called when the view is closed, allowing the owner to clean up references. */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Branch selection
// ---------------------------------------------------------------------------

/**
 * Internal tagged union representing why a branch was selected for an
 * edit-fork group. Stored per group-root runId in the View's
 * `_branchSelections` map. Not the public-facing {@link BranchSelection}
 * — that's a UI-facing bundle returned by `view.branchSelection(id)`.
 */
type BranchSelectionState =
  /** Explicit navigation via `selectSibling()`. The selected input-node key. */
  | { kind: 'user'; selectedKey: string }
  /** This view initiated an edit fork — auto-selected the new input node. */
  | { kind: 'auto'; selectedKey: string }
  /** An external fork appeared — pinned to the currently-visible sibling to prevent drift. */
  | { kind: 'pinned'; selectedKey: string };

/**
 * Selection state for a regenerate group. Keyed by the anchor codec-message-id (the
 * assistant codec-message-id being regenerated). Distinct from {@link BranchSelectionState}
 * because regenerate groups are message-level (group members share an
 * anchor codec-message-id), not edit forks of the user prompt.
 *
 * Unlike fork-of groups, regenerate groups do not "pin to current visible"
 * when a new member appears externally — the default for a regenerate
 * slot is always the latest member, so an external regenerator auto-rolls
 * forward unless the user has explicitly selected an earlier member.
 */
type RegenSelection =
  /** Explicit navigation via `selectSibling()`. The selected reply-run id. */
  | { kind: 'user'; selectedRunId: string }
  /** This view initiated a regenerate — auto-selected the new reply run when it arrived. */
  | { kind: 'auto'; selectedRunId: string }
  /**
   * This view's `regenerate()` is in flight. Keyed (in `_regenSelections`) by
   * the regenerate group's root; `carrierCodecMessageId` is the regenerate
   * carrier event's id, used to recognise the new reply run when it appears.
   */
  | { kind: 'pending'; carrierCodecMessageId: string };

/**
 * A resolved branch point: the group `kind` plus the sibling nodes that make
 * up the alternatives. `fork-of` is an edit-style branch anchored at the user
 * input node; `regen` is a regenerate-style branch anchored at the assistant
 * slot. `groupRoot` is the group's key (input group root for fork-of, the
 * original reply's group root for regen).
 */
type MessageBranchPoint<TProjection> =
  | { kind: 'fork-of'; groupRoot: string; siblings: ConversationNode<TProjection>[] }
  | { kind: 'regen'; groupRoot: string; siblings: ConversationNode<TProjection>[] };

// ---------------------------------------------------------------------------
// Send-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the two input shapes `View.send` accepts (a single TInput
 * or an array) into the array shape the SendDelegate consumes.
 * @param input - The raw input from `View.send`.
 * @returns The normalised input array.
 */
const _normaliseSend = <TInput extends CodecInputEvent>(input: TInput | TInput[]): TInput[] =>
  Array.isArray(input) ? input : [input];

// ---------------------------------------------------------------------------
// Fetch tuning
// ---------------------------------------------------------------------------

/**
 * Multiplier applied to the user-supplied Run-unit `loadOlder(limit)`
 * when issuing the first `loadHistory` page request. `loadHistory`
 * counts complete domain *messages* per page, not Runs; a typical Run
 * produces ~2 messages (user + assistant). Asking for `limit * factor`
 * messages on the first page reduces extra round-trips when the actual
 * messages-per-Run ratio is around the factor. `_loadUntilVisible`
 * still loops on the Run count regardless, so this is purely a
 * fetch-efficiency hint.
 */
const _RUN_TO_MESSAGE_FETCH_FACTOR = 3;

/**
 * Project a Tree `RunNode` down to the View-facing `RunInfo` shape:
 * drop the codec projection and the structural fields that callers
 * reach via `session.tree` when they need them.
 * @param run - The tree's RunNode.
 * @returns A projection-free RunInfo.
 */
const _toRunInfo = <TProjection>(run: RunNode<TProjection>): RunInfo => ({
  runId: run.runId,
  clientId: run.clientId,
  status: run.status,
  invocationId: run.invocationId,
});

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultView<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements View<TInput, TMessage> {
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _sendDelegate: SendDelegate<TInput>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;
  private readonly _onClose?: () => void;

  /**
   * View-local branch selections: group-root runId → selection intent.
   * Fork points not present here default to the latest sibling.
   */
  private readonly _branchSelections = new Map<string, BranchSelectionState>();

  /**
   * View-local regenerate-group selections: anchor codec-message-id (the assistant
   * codec-message-id being regenerated) → selection intent. Distinct from
   * {@link _branchSelections} because a regenerate group is a set of
   * same-parent reply runs — message-level alternatives at a single
   * conversation slot, not edit forks of the prompt. Groups not present here default to the latest
   * member (the most recent regenerator, or the original if no regen has
   * landed).
   */
  private readonly _regenSelections = new Map<string, RegenSelection>();

  /** Spec: AIT-CT11c — runIds loaded from history but not yet revealed to the UI. */
  private readonly _withheldRunIds = new Set<string>();

  /** Snapshot of visible node keys — used to detect structural changes and for selection pinning. */
  private _lastVisibleNodeKeys: string[] = [];

  /**
   * Snapshot of visible projection references — used to detect in-place
   * projection updates (streaming). One entry per visible Run.
   */
  private _lastVisibleProjections: TProjection[] = [];

  /**
   * Snapshot of the visible flat message chain with codec-message-ids —
   * exposed verbatim via `getMessages()` and the internal correlation
   * source for parent/branch routing.
   */
  private _lastVisibleMessagePairs: CodecMessage<TMessage>[] = [];

  /** Cached visible node-key Set — for O(1) lookup in event scoping. */
  private _lastVisibleNodeKeySet = new Set<string>();

  /** Whether there are more history pages to fetch from the channel. */
  private _hasMoreHistory = false;

  /** Internal state for continuing history pagination. */
  private _lastHistoryPage: HistoryPage | undefined;

  /** Buffer of withheld nodes (input + reply), drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: ConversationNode<TProjection>[] = [];

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  /**
   * Cached result of the last flat-nodes computation. Drives the visible
   * message snapshot exposed via `getMessages()`; refreshed by
   * `_computeFlatNodes()` on structural changes, selection changes,
   * and history reveal.
   */
  private _cachedNodes: ConversationNode<TProjection>[] = [];

  private _loadingOlder = false;
  private _processingHistory = false;
  private _closed = false;

  constructor(options: ViewOptions<TInput, TOutput, TProjection, TMessage>) {
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
      this._tree.on('output', (event) => {
        this._onTreeOutput(event);
      }),
    );
  }

  /**
   * Handle decoded outputs folded into a Run (streaming delta). If the run
   * is on the visible chain, recompute the flat message list and emit
   * `update`.
   * @param event - The output event from the Tree.
   */
  private _onTreeOutput(event: OutputEvent<TOutput>): void {
    if (this._processingHistory) return;
    // The fold target may be a reply run (event.runId) or a user input node
    // (event.runId undefined — the agent mints run-ids, so an input fold has
    // none). Gate on whichever key the visible set holds.
    const folded =
      (event.runId !== undefined && this._lastVisibleNodeKeySet.has(event.runId)) ||
      (event.inputCodecMessageId !== undefined && this._lastVisibleNodeKeySet.has(event.inputCodecMessageId));
    if (!folded) return;

    // The Tree emits `output` once per inbound message fold (with empty
    // `events` for inputs-only folds), so it fires whenever a visible Run's
    // projection changed and we always re-emit. The Reducer contract permits
    // in-place mutation, which means we cannot use projection-ref or
    // TMessage-ref equality to detect change: a streaming chunk legitimately
    // mutates the same UIMessage object, and a ref-equality short-circuit
    // would suppress every update. React state setters at the subscriber
    // boundary already dedup by array reference, so a redundant emit is a
    // no-op for unchanged hook consumers.
    this._lastVisibleProjections = this._cachedNodes.map((n) => n.projection);
    this._lastVisibleMessagePairs = this._extractMessages(this._cachedNodes);
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  getMessages(): CodecMessage<TMessage>[] {
    return this._lastVisibleMessagePairs;
  }

  runs(): RunInfo[] {
    // `_cachedNodes` is the visible node chain (inputs + reply runs) with
    // pagination and sibling selection already applied. RunInfo is reply-run
    // shaped, so filter to runs before projecting.
    return this._cachedNodes
      .filter((node): node is RunNode<TProjection> => node.kind === 'run')
      .map((node) => _toRunInfo(node));
  }

  /**
   * Compute the fresh visible node chain. The Tree's `visibleNodes` already
   * applies kind-blind reachability and sibling selection (edit versions /
   * regenerate runs collapse to the selected member), so the View only layers
   * its pagination window on top: drop nodes whose key is currently withheld.
   * @returns A fresh array of visible nodes (inputs + reply runs).
   */
  private _computeFlatNodes(): ConversationNode<TProjection>[] {
    const treeNodes = this._treeVisibleNodes();
    if (this._withheldRunIds.size === 0) return treeNodes;
    return treeNodes.filter((node) => !this._withheldRunIds.has(nodeKey(node)));
  }

  /**
   * Recompute the visible node chain, refresh the cache + snapshot, and emit
   * `update` unconditionally. Use after a mutation that always changes the
   * visible output (e.g. an explicit selection or a withheld-batch reveal).
   */
  private _recomputeAndEmit(): void {
    this._cachedNodes = this._computeFlatNodes();
    this._updateVisibleSnapshot(this._cachedNodes);
    this._emitter.emit('update');
  }

  /**
   * Recompute the visible node chain and, only if it differs from the current
   * snapshot, refresh the cache + snapshot and emit `update`. Use after a
   * mutation that may or may not move the visible window (e.g. a structural
   * tree update, or a deferred regenerate promotion that may already match).
   */
  private _recomputeAndEmitIfChanged(): void {
    const nodes = this._computeFlatNodes();
    if (this._visibleChanged(nodes)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }
  }

  /**
   * Resolve the reply Run that owns a codec-message-id, narrowing the Tree's
   * node union to a {@link RunNode}. A user-input codec-message-id resolves to
   * an input node and yields `undefined` here — callers that must handle input
   * nodes use {@link _tree.getNodeByCodecMessageId} directly.
   * @param codecMessageId - The codec-message-id to resolve.
   * @returns The owning RunNode, or undefined if absent or not a reply Run.
   */
  private _runByCodecMessageId(codecMessageId: string): RunNode<TProjection> | undefined {
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    return node?.kind === 'run' ? node : undefined;
  }

  /**
   * Extract the flat TMessage[] from a visible node chain.
   *
   * In the two-node model the Tree's `visibleNodes` has already selected one
   * member per sibling group (the chosen edit version, the chosen regenerate
   * run), so a regenerate is just a sibling reply run that appears in place of
   * the original. Each visible node contributes its own messages in projection
   * order; the flat list is their concatenation.
   *
   * Deferred caveat: a mid-reply regenerate that replaces a non-head message
   * inside a multi-message reply run is not expressible as a sibling run in
   * this model and is not handled here (see the `regenerate-of-multi-message`
   * golden test).
   * @param nodes - The visible nodes (inputs + reply runs) in chronological order.
   * @returns The flat message list, each message paired with its codec-message-id.
   */
  private _extractMessages(nodes: ConversationNode<TProjection>[]): CodecMessage<TMessage>[] {
    const messages: CodecMessage<TMessage>[] = [];
    for (const node of nodes) {
      for (const m of this._codec.getMessages(node.projection)) {
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

      await this._revealFromPage(nextPage, limit);
    } catch (error) {
      this._logger.error('DefaultView.loadOlder(); failed', { error });
      throw error;
    } finally {
      this._loadingOlder = false;
    }
  }

  // -------------------------------------------------------------------------
  // Run lookup
  // -------------------------------------------------------------------------

  runOf(codecMessageId: string): RunInfo | undefined {
    this._logger.trace('DefaultView.runOf();', { codecMessageId });
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (!node) return undefined;
    if (node.kind === 'run') return _toRunInfo(node);
    // Input node: resolve to its selected reply run (undefined if none started).
    const reply = this._selectedReplyRun(node.codecMessageId);
    return reply ? _toRunInfo(reply) : undefined;
  }

  /**
   * Resolve the reply run currently selected for an input node, honouring the
   * View's regenerate selection. Falls back to the latest reply run when no
   * selection has been recorded; undefined when no reply run has started.
   * @param inputCodecMessageId - The input node's codec-message-id.
   * @returns The selected reply RunNode, or undefined.
   */
  private _selectedReplyRun(inputCodecMessageId: string): RunNode<TProjection> | undefined {
    const replies = this._tree.getReplyRuns(inputCodecMessageId);
    if (replies.length === 0) return undefined;
    if (replies.length === 1) return replies[0];
    // Multiple reply runs = a regenerate group. Honour the View's selection
    // (keyed by group root) else default to the latest.
    const groupRoot = this._tree.getGroupRoot(replies[0]?.runId ?? '');
    const sel = this._regenSelections.get(groupRoot);
    const selectedKey = sel && sel.kind !== 'pending' ? sel.selectedRunId : undefined;
    if (selectedKey !== undefined) {
      const chosen = replies.find((r) => r.runId === selectedKey);
      if (chosen) return chosen;
    }
    // Latest by startSerial; getReplyRuns is set-ordered, so sort defensively.
    return replies.toSorted((a, b) => (a.startSerial ?? '￿').localeCompare(b.startSerial ?? '￿')).at(-1);
  }

  run(runId: string): RunInfo | undefined {
    this._logger.trace('DefaultView.run();', { runId });
    const run = this._tree.getRunNode(runId);
    return run ? _toRunInfo(run) : undefined;
  }

  // -------------------------------------------------------------------------
  // Branch navigation (msg-anchored)
  // -------------------------------------------------------------------------

  // Spec: AIT-CT13c, AIT-CT13d — branch points are codec-message-id
  // anchored. The View resolves the anchor (the user prompt for edits,
  // the assistant slot for regens) and routes the selection to the
  // appropriate internal selection map. Tree-level introspection
  // (RunNode access, runId-keyed queries) remains on the {@link Tree}.

  branchSelection(codecMessageId: string): BranchSelection<TMessage> {
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (branch) {
      // Each sibling contributes its head message as the branch-arrow slot:
      // for an edit fork that is the alternate user prompt; for a regenerate
      // group it is the variant's first (anchor-equivalent) message.
      const siblings = branch.siblings.flatMap((s) => {
        const first = this._codec.getMessages(s.projection).at(0);
        return first ? [first.message] : [];
      });

      if (siblings.length > 0) {
        const index = this._resolveSelectedIndex(branch);
        const clamped = Math.max(0, Math.min(index, siblings.length - 1));
        const selected = siblings[clamped];
        return {
          hasSiblings: siblings.length > 1,
          siblings,
          index: clamped,
          selected,
        };
      }
    }

    // Known non-anchor message: the bundle's invariant is that
    // `siblings` contains the rendered message itself for any known
    // codec-message-id, so plain bubbles get `siblings.length === 1`
    // (not `0`) and the indexing space matches between read and write.
    // Resolve the owning node kind-blind — a plain user prompt is an input
    // node, an assistant message lives in a reply run; both carry a projection.
    const owner = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (owner) {
      const found = this._codec.getMessages(owner.projection).find((m) => m.codecMessageId === codecMessageId);
      if (found !== undefined) {
        return { hasSiblings: false, siblings: [found.message], index: 0, selected: found.message };
      }
    }

    // Unknown id, or the owner Run is known but the codec doesn't surface
    // a message with this id from the projection (e.g. an event-only fold
    // such as a tool result that mutates an assistant in-place without
    // exposing its own TMessage). Treat both as "no rendered message",
    // returning the safe empty bundle.
    return { hasSiblings: false, siblings: [], index: 0, selected: undefined };
  }

  // Spec: AIT-CT13c, AIT-CT13d
  selectSibling(codecMessageId: string, index: number): void {
    this._logger.trace('DefaultView.selectSibling();', { codecMessageId, index });
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (!branch) return;
    const clamped = Math.max(0, Math.min(index, branch.siblings.length - 1));
    const selected = branch.siblings[clamped];
    if (!selected) return; // unreachable: clamped is always in bounds
    if (branch.kind === 'fork-of') {
      this._branchSelections.set(branch.groupRoot, { kind: 'user', selectedKey: nodeKey(selected) });
      this._logger.debug('DefaultView.selectSibling(); fork-of', {
        codecMessageId,
        index: clamped,
        selectedKey: nodeKey(selected),
      });
    } else {
      this._regenSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: nodeKey(selected) });
      this._logger.debug('DefaultView.selectSibling(); regenerate', {
        codecMessageId,
        index: clamped,
        selectedRunId: nodeKey(selected),
        groupRoot: branch.groupRoot,
      });
    }
    this._recomputeAndEmit();
  }

  /**
   * Resolve the currently selected sibling's index inside a branch group.
   * Pending selections fall back to the latest sibling. The caller clamps
   * the returned index against any post-extraction filtering.
   * @param branch - Resolved branch-point descriptor from `_resolveMessageBranchPoint`.
   * @returns The selected sibling's index within `branch.siblings`.
   */
  private _resolveSelectedIndex(branch: MessageBranchPoint<TProjection>): number {
    if (branch.kind === 'fork-of') {
      const sel = this._branchSelections.get(branch.groupRoot);
      if (!sel) return branch.siblings.length - 1;
      const idx = branch.siblings.findIndex((n) => nodeKey(n) === sel.selectedKey);
      return idx === -1 ? branch.siblings.length - 1 : idx;
    }
    const sel = this._regenSelections.get(branch.groupRoot);
    if (!sel || sel.kind === 'pending') return branch.siblings.length - 1;
    const idx = branch.siblings.findIndex((n) => nodeKey(n) === sel.selectedRunId);
    return idx === -1 ? branch.siblings.length - 1 : idx;
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
  private _resolveMessageBranchPoint(codecMessageId: string): MessageBranchPoint<TProjection> | undefined {
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (!node) return undefined;

    // Edit-fork branch point: `codecMessageId` is a user INPUT node that has
    // sibling input nodes (alternate prompts via fork-of). The anchor is the
    // input node's own codec-message-id.
    if (node.kind === 'input') {
      const siblings = this._tree.getSiblingNodes(node.codecMessageId);
      if (siblings.length > 1) {
        return { kind: 'fork-of', groupRoot: this._tree.getGroupRoot(node.codecMessageId), siblings };
      }
      return undefined;
    }

    // Regenerate branch point: `codecMessageId` is owned by a reply run that has
    // sibling reply runs (the original reply + its regenerators, all parented at
    // the same input node). Anchor on the head message of the run so arrows
    // appear once per variant, not on every follow-up message.
    const siblings = this._tree.getSiblingNodes(node.runId);
    if (siblings.length > 1) {
      const firstMsg = this._codec.getMessages(node.projection).at(0);
      if (firstMsg?.codecMessageId === codecMessageId) {
        return { kind: 'regen', groupRoot: this._tree.getGroupRoot(node.runId), siblings };
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  // Spec: AIT-CT3, AIT-CT4
  async send(input: TInput | TInput[], options?: SendOptions): Promise<ActiveRun> {
    this._logger.trace('DefaultView.send();');
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; view is closed', ErrorCode.InvalidArgument, 400);
    }

    const normalised = _normaliseSend<TInput>(input);

    // The codec-message-id of the visible branch tail — the delegate uses it
    // for auto-parent routing on fresh user messages.
    const parentCodecMessageId = this._lastVisibleMessagePairs.at(-1)?.codecMessageId;

    const result = await this._sendDelegate(normalised, options, parentCodecMessageId);
    this._applyForkAutoSelect(result, options);
    return result;
  }

  /**
   * Auto-select / pin branch selections after a forking send.
   * @param result - The ActiveRun returned by the delegate.
   * @param options - The SendOptions passed by the caller.
   */
  private _applyForkAutoSelect(result: ActiveRun, options: SendOptions | undefined): void {
    // Spec: AIT-CT13e
    if (!options?.forkOf) return;

    // An edit inserts a NEW user input node optimistically; its codec-message-id
    // is the (only) optimistic id and IS its node key. Edit forks are input-node
    // sibling groups, so the selection is keyed by the input group root and the
    // selected member is the new input node's key.
    const editedInputKey = result.optimisticCodecMessageIds.at(0);
    if (editedInputKey === undefined) return;
    const groupRoot = this._tree.getGroupRoot(editedInputKey);

    this._branchSelections.set(groupRoot, { kind: 'auto', selectedKey: editedInputKey });
    this._recomputeAndEmit();
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
  private _applyRegenerateAutoSelect(result: ActiveRun, anchorCodecMessageId: string): void {
    // A regenerate produces a new reply run parented at the SAME input node as
    // the original reply (the regenerate group). The agent mints the run-id, so
    // we cannot pin by it synchronously. Resolve the group root from the
    // original reply run owning the anchor, and pin a pending selection keyed by
    // that group root, carrying the regenerate carrier's codec-message-id
    // (`result.inputCodecMessageId`) so we can promote when the new reply run lands.
    const anchorRun = this._runByCodecMessageId(anchorCodecMessageId);
    if (!anchorRun) return;
    const groupRoot = this._tree.getGroupRoot(anchorRun.runId);

    this._regenSelections.set(groupRoot, {
      kind: 'pending',
      carrierCodecMessageId: result.inputCodecMessageId,
    });
    this._logger.debug('DefaultView._applyRegenerateAutoSelect(); deferring regenerate selection', {
      anchorCodecMessageId,
      groupRoot,
      carrier: result.inputCodecMessageId,
    });

    // The new reply run may already be in the tree (run-start raced ahead of the
    // sendDelegate resolution). Promote now and recompute so the visible set
    // catches up without waiting for the next structural change.
    this._resolvePendingRegenSelections();
    this._recomputeAndEmitIfChanged();
  }

  // Spec: AIT-CT5, AIT-CT13d
  async regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun> {
    this._logger.trace('DefaultView.regenerate();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to regenerate; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // `messageId` is the assistant being regenerated. The new Run is a
    // continuation of the regenerated message's Run, not a fork: the
    // message-level replacement (new assistant supersedes the original)
    // happens at projection extraction time. We still resolve the parent
    // user prompt so the new assistant's wire `parent` is correct,
    // and we send the truncated history (through the parent inclusive)
    // so the LLM re-answers the right message.
    const targetRun = this._runByCodecMessageId(messageId);
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
    // already-regenerated assistant, the new alternative SHOULD belong
    // to the SAME branch point as the previous regen — but ONLY when
    // the target is the position-equivalent of the group anchor (the
    // head message of the regenerator Run). For a trailing follow-up
    // message inside a regenerator Run (e.g. the LLM text after the
    // regenerated tool call), the user expects the regen to anchor at
    // the specific message they clicked, not roll up to the group root.
    // Rebasing trailing regens to the group root produces a confusing
    // "N+1 / N+1" counter on the tool-call bubble and runs the whole
    // turn from scratch instead of just regenerating the text.
    let regenAnchorMsgId = messageId;
    if (targetRun.regeneratesCodecMessageId !== undefined) {
      const firstMsg = this._codec.getMessages(targetRun.projection).at(0);
      if (firstMsg?.codecMessageId === messageId) {
        regenAnchorMsgId = targetRun.regeneratesCodecMessageId;
      }
    }

    const sendOptions: SendOptions = {
      ...options,
      parent: parentCodecMessageId,
    };

    // Mint a regenerate input via the codec. The codec's well-known
    // `Regenerate` carries `target: regenAnchorMsgId` and `parent:
    // parentCodecMessageId`; the session reads those fields off the input
    // directly when building transport headers (`fork-of` and
    // `parent`). The agent's input-event lookup catches the wire signal;
    // no tree-upsert / projection fold runs locally.
    const regenerate = this._codec.createRegenerate(regenAnchorMsgId, parentCodecMessageId);
    const result = await this._sendDelegate([regenerate], sendOptions, parentCodecMessageId);
    this._applyRegenerateAutoSelect(result, regenAnchorMsgId);
    return result;
  }

  // Spec: AIT-CT6
  async edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ActiveRun> {
    this._logger.trace('DefaultView.edit();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to edit; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // The edit target is a user prompt — a run-less INPUT node — so resolve
    // it kind-blind, not via the reply-run-only lookup.
    const targetNode = this._tree.getNodeByCodecMessageId(messageId);
    if (!targetNode) {
      throw new Ably.ErrorInfo(
        `unable to edit; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentCodecMessageId = this._findParentMsgId(targetNode, messageId);

    return this.send(inputs, {
      ...options,
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
   * @param targetNode - The node (input node or reply run) that owns `targetMsgId`.
   * @param targetMsgId - The codec-message-id to find the parent of.
   * @returns The parent codec-message-id, or undefined if no predecessor exists.
   */
  private _findParentMsgId(targetNode: ConversationNode<TProjection>, targetMsgId: string): string | undefined {
    const visible = this._lastVisibleMessagePairs;
    const visIdx = visible.findIndex((m) => m.codecMessageId === targetMsgId);
    if (visIdx > 0) {
      return visible[visIdx - 1]?.codecMessageId;
    }
    if (visIdx === 0) return undefined;

    const messages = this._codec.getMessages(targetNode.projection);
    const idx = messages.findIndex((m) => m.codecMessageId === targetMsgId);
    if (idx > 0) {
      return messages[idx - 1]?.codecMessageId;
    }
    if (idx === 0 && targetNode.parentCodecMessageId !== undefined) {
      // The structural predecessor is the node owning parentCodecMessageId
      // (an input node, or a prior reply run). Its tail message is the parent.
      const parentNode = this._tree.getNodeByCodecMessageId(targetNode.parentCodecMessageId);
      if (parentNode) {
        return this._codec.getMessages(parentNode.projection).at(-1)?.codecMessageId;
      }
    }
    return undefined;
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
    // loadHistory's limit counts complete domain messages per page (not
    // Runs); see `_RUN_TO_MESSAGE_FETCH_FACTOR` for the scaling rationale.
    const messageLimit = limit * _RUN_TO_MESSAGE_FETCH_FACTOR;
    const firstPage = await loadHistory(this._channel, { limit: messageLimit }, this._logger);
    if (this._closed) return;
    await this._revealFromPage(firstPage, limit);
  }

  /**
   * Walk channel history from `page` until at least `limit` new Runs are
   * observed (or the channel is exhausted), then reveal the newest batch and
   * withhold the rest. Snapshots the already-visible nodes up front so only
   * newly-observed Runs count toward `limit`. No-op if the view closed during
   * the page walk.
   * @param page - The decoded history page to start from.
   * @param limit - Max Runs to reveal in this batch.
   */
  private async _revealFromPage(page: HistoryPage, limit: number): Promise<void> {
    // Snapshot before loading: every node already in the tree stays visible.
    const beforeRunIds = new Set(this._treeVisibleNodes().map((n) => nodeKey(n)));

    const { newVisible, lastPage } = await this._loadUntilVisible(page, limit, beforeRunIds);
    if (this._closed) return;
    this._lastHistoryPage = lastPage;
    this._hasMoreHistory = lastPage.hasNext();
    this._splitReveal(newVisible, limit);
  }

  /**
   * Reveal the newest `limit` Runs from `newVisible` and withhold the rest
   * so subsequent `loadOlder` calls can drain them. Called by
   * {@link _revealFromPage} to enforce the Run-unit pagination contract.
   * @param newVisible - Newly observed Runs from the history fetch.
   * @param limit - Max Runs to reveal in this batch.
   */
  private _splitReveal(newVisible: ConversationNode<TProjection>[], limit: number): void {
    // Reveal granularity is the reply RUN; an input node travels with the reply
    // run it precedes. Walk newest-first, counting reply runs toward `limit`,
    // and split the union list at the resulting boundary so an input + its reply
    // are revealed or withheld together.
    let runs = 0;
    let splitIdx = newVisible.length; // index of first revealed node
    for (let i = newVisible.length - 1; i >= 0; i--) {
      const node = newVisible[i];
      if (node?.kind === 'run') {
        if (runs === limit) break;
        runs++;
      }
      splitIdx = i;
    }
    const batch = newVisible.slice(splitIdx);
    const withheld = newVisible.slice(0, splitIdx);
    for (const n of withheld) {
      this._withheldRunIds.add(nodeKey(n));
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
  }

  /**
   * Replay a history page's raw messages into the Tree. Dispatches by Ably
   * message name to run-lifecycle vs. regular wire messages, mirroring the
   * live `client-session._handleMessage` decode loop. Uses a fresh decoder
   * since the session's live decoder maintains its own stream-tracker state.
   * @param page - The history page returned by `loadHistory`.
   */
  private _processHistoryPage(page: HistoryPage): void {
    this._processingHistory = true;
    try {
      // Reconstruct the tree via the shared decode-fold engine — the same path
      // the client's live loop uses, so history replay can't drift from it.
      const decoder = this._codec.createDecoder();
      for (const rawMsg of page.rawMessages) {
        applyWireMessage(this._tree, decoder, rawMsg);
      }

      // Emit ably-message in a batch AFTER the whole page is applied, so a
      // subscriber resolving the owning Run sees the fully-rebuilt tree.
      for (const msg of page.rawMessages) {
        this._tree.emitAblyMessage(msg);
      }
    } finally {
      this._processingHistory = false;
    }
  }

  private async _loadUntilVisible(
    firstPage: HistoryPage,
    target: number,
    beforeRunIds: Set<string>,
  ): Promise<{ newVisible: ConversationNode<TProjection>[]; lastPage: HistoryPage }> {
    this._processHistoryPage(firstPage);
    let page = firstPage;

    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._treeVisibleNodes()) {
        // Pagination counts reply RUNS toward the target (an input node travels
        // with the reply run it precedes — see `_splitReveal`).
        if (n.kind === 'run' && !beforeRunIds.has(nodeKey(n))) count++;
      }
      return count;
    };

    while (newVisibleCount() < target && page.hasNext()) {
      const nextPage = await page.next();
      if (!nextPage || this._closed) break;
      this._processHistoryPage(nextPage);
      page = nextPage;
    }

    const newVisible = this._treeVisibleNodes().filter((n) => !beforeRunIds.has(nodeKey(n)));
    return { newVisible, lastPage: page };
  }

  // Spec: AIT-CT11a
  private _releaseWithheld(nodes: ConversationNode<TProjection>[]): void {
    for (const n of nodes) {
      this._withheldRunIds.delete(nodeKey(n));
    }
    if (nodes.length > 0) {
      this._recomputeAndEmit();
    }
  }

  // -------------------------------------------------------------------------
  // Private: scoped event forwarding
  // -------------------------------------------------------------------------

  private _updateVisibleSnapshot(nodes?: ConversationNode<TProjection>[]): void {
    const resolved = nodes ?? this._cachedNodes;
    // Identity key = nodeKey (runId for reply runs, codecMessageId for inputs),
    // so the visible set scopes events for both kinds and input-node parents.
    this._lastVisibleNodeKeys = resolved.map((n) => nodeKey(n));
    this._lastVisibleNodeKeySet = new Set(this._lastVisibleNodeKeys);
    this._lastVisibleProjections = resolved.map((n) => n.projection);
    this._lastVisibleMessagePairs = this._extractMessages(resolved);
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while processing history pages. During
    // _processHistoryPage, each tree.applyMessage() fires this handler
    // synchronously — but _withheldRunIds hasn't been populated yet, so
    // _computeFlatNodes() would return unfiltered history. Without this guard,
    // subscribers briefly see all history Runs before the pagination window
    // is applied. The final update is emitted by _releaseWithheld after
    // withholding is set up.
    if (this._processingHistory) return;

    // The Tree emits `update` only on structural change (new/removed Run,
    // sort-reorder, startSerial promotion, run-start backfill), so every
    // update reaching here warrants a full re-walk. Content-only folds flow
    // through `output` (_onTreeOutput) instead.

    // Pin selections for previously-visible Runs that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinBranchSelections();
    this._resolvePendingRegenSelections();

    this._recomputeAndEmitIfChanged();
  }

  /**
   * Build the unified selection map the Tree's `visibleNodes` consumes:
   * `groupRootKey -> selectedKey`, covering both edit forks (input-node groups,
   * keyed by the input group root) and regenerate groups (reply-run groups,
   * keyed by the original reply's group root). Pending entries (no chosen
   * member yet) are omitted so the Tree falls back to the latest sibling.
   * @returns The merged group-root → selected-key map.
   */
  private _resolveSelections(): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const [groupRoot, sel] of this._branchSelections) {
      resolved.set(groupRoot, sel.selectedKey);
    }
    for (const [groupRoot, sel] of this._regenSelections) {
      if (sel.kind === 'pending') continue;
      resolved.set(groupRoot, sel.selectedRunId);
    }
    return resolved;
  }

  /**
   * The Tree's visible node chain under this view's current selections — the
   * reachable, sibling-resolved nodes before the View's pagination window is
   * applied.
   * @returns The selection-resolved visible node chain.
   */
  private _treeVisibleNodes(): ConversationNode<TProjection>[] {
    return this._tree.visibleNodes(this._resolveSelections());
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
    for (const key of this._lastVisibleNodeKeys) {
      const node = this._tree.getNode(key);
      // Edit forks are INPUT-node sibling groups; only input nodes pin here.
      // Regenerate (reply-run) groups roll forward via _resolvePendingRegenSelections.
      if (node?.kind !== 'input') continue;
      const siblings = this._tree.getSiblingNodes(key);
      if (siblings.length <= 1) continue;
      const groupRoot = this._tree.getGroupRoot(key);
      const existing = this._branchSelections.get(groupRoot);

      // Spec: AIT-CT13f — external edit fork: pin to the currently-visible
      // sibling so a fork from another view doesn't drift this view's branch.
      if (existing) continue;
      this._branchSelections.set(groupRoot, { kind: 'pinned', selectedKey: key });
    }
  }

  /**
   * Roll `pending` and `auto` regenerate selections forward to the newest
   * group member. A regenerate slot defaults to the latest member, so each
   * new regenerator (this view's awaited run, or an external one) auto-rolls
   * the slot forward — UNLESS the user explicitly selected an earlier member
   * (`user`), which pins and is left untouched. The agent mints the run-id, so
   * we can't match the awaited run by id — once the group grows we adopt the
   * newest as the selected member.
   */
  private _resolvePendingRegenSelections(): void {
    for (const [groupRoot, sel] of this._regenSelections) {
      if (sel.kind === 'user') continue;
      const group = this._tree.getSiblingNodes(groupRoot).filter((n): n is RunNode<TProjection> => n.kind === 'run');
      if (group.length <= 1) continue;
      const newest = group.at(-1);
      if (!newest) continue;
      this._regenSelections.set(groupRoot, { kind: 'auto', selectedRunId: newest.runId });
    }
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // Re-emit only if the message corresponds to a visible Run
    const headers = getTransportHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    const runId = headers[HEADER_RUN_ID];

    if (!codecMessageId && !runId) {
      // Lifecycle / control events with no run/message identity (cancel, error)
      // are always forwarded.
      this._emitter.emit('ably-message', msg);
      return;
    }

    if (runId && this._lastVisibleNodeKeySet.has(runId)) {
      this._emitter.emit('ably-message', msg);
    }
  }

  private _onTreeRun(event: RunLifecycleEvent): void {
    // Check if the run is already on the visible branch.
    if (this._lastVisibleNodeKeySet.has(event.runId)) {
      this._emitter.emit('run', event);
      return;
    }

    // For run-start, use branch metadata to predict visibility before
    // messages arrive. Own runs have optimistic inserts (caught above).
    // Remote runs carry parent/forkOf from the agent.
    if (event.type === 'start' && this._isRunStartVisible(event)) {
      this._lastVisibleNodeKeySet.add(event.runId);
      this._emitter.emit('run', event);
    }
  }

  /**
   * Predict whether a run-start's messages will be visible on this view's
   * branch using the parent/forkOf metadata from the event.
   * @param event - The run-start lifecycle event.
   * @returns True if the run is expected to be visible on this view's branch.
   */
  private _isRunStartVisible(event: RunLifecycleEvent & { type: 'start' }): boolean {
    const { parent } = event;

    // No parent metadata — can't determine branch, forward as default.
    if (parent === undefined) return true;

    // The wire `parent` is a codec-message-id (the prior message). Resolve it
    // kind-blind to its owning NODE — an input node (the user prompt this run
    // replies to) or a prior reply run — and check that node's key against the
    // visible set. Input-node keys are populated into the set by
    // _updateVisibleSnapshot.
    const parentNode = this._tree.getNodeByCodecMessageId(parent);
    if (!parentNode) return true; // unknown parent: forward conservatively
    return this._lastVisibleNodeKeySet.has(nodeKey(parentNode));
  }

  private _visibleChanged(newNodes: ConversationNode<TProjection>[]): boolean {
    if (newNodes.length !== this._lastVisibleNodeKeys.length) return true;
    for (const [i, node] of newNodes.entries()) {
      if (nodeKey(node) !== this._lastVisibleNodeKeys[i]) return true;
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
export const createView = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: ViewOptions<TInput, TOutput, TProjection, TMessage>,
): DefaultView<TInput, TOutput, TProjection, TMessage> => new DefaultView(options);
