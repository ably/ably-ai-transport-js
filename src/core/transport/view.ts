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
import { collectMessages, messageTailSplitIndex } from './conversation-projection.js';
import type { HistoryHydrator } from './history-hydrator.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type {
  ActiveRun,
  BranchHandle,
  ConversationNode,
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
interface ViewOptions<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The codec used to project messages and mint regenerate inputs. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /**
   * The session's shared history hydrator. `loadOlder` drives it to fold older
   * channel pages into the Tree; it is owned by the session and shared by every
   * view, so the channel is paged once across views.
   */
  hydrator: HistoryHydrator;
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
 * `_branchSelections` map. Not the public-facing {@link BranchHandle}
 * — that's a UI-facing handle returned by `view.branchSelection(id)`.
 */
type BranchSelectionState =
  /** Explicit navigation via `branchSelection().select()`. The selected input-node key. */
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
  /** Explicit navigation via `branchSelection().select()`. The selected reply-run id. */
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
 * One alternative inside a {@link MessageBranchPoint}. The representative is the
 * member's own head message for fork-of and whole-reply regen groups, but the
 * regenerate target (a non-head message) for a non-head regen group - so it is
 * tracked explicitly rather than re-derived from the node's head.
 */
interface BranchMember {
  /**
   * The member node's `nodeKey` (tree.ts): a runId for a reply/regenerator run,
   * a codecMessageId for an input node. Matched by `_resolveSelectedIndex`.
   */
  memberNodeKey: string;
  /** The codec-message-id rendered in this member's branch-arrow slot. */
  representativeCodecMessageId: string;
}

/**
 * A resolved branch point: the group `kind` plus the member alternatives.
 *
 * Terms: "regenerate target" = the message being replaced; "regenerator run" =
 * the run that replaces it; "non-head message" = any message after a run's
 * first (index > 0, includes the tail).
 *
 * The three kinds, by anchor:
 * - `fork-of` — edit-style branch anchored at the user input node; members are
 *   the alternate prompts (input-node sibling group).
 * - `regen` — whole-reply regenerate branch anchored at the assistant slot;
 *   members are the original reply + its regenerator runs (same-input-node
 *   sibling reply runs).
 * - `non-head-regen` — a regenerate that replaced a non-head message inside a
 *   multi-message reply run; members are the owner run (the regenerate target in
 *   place) plus each regenerator run. Not expressible as a same-parent
 *   sibling-run group, so the View resolves and renders it itself (see
 *   `_extractMessages`).
 *
 * `groupRoot` is the selection-map key: the input group root for fork-of, the
 * original reply's group root for regen, and the regenerate target's
 * codec-message-id for non-head-regen.
 */
type MessageBranchPoint =
  | { kind: 'fork-of'; groupRoot: string; members: BranchMember[] }
  | { kind: 'regen'; groupRoot: string; members: BranchMember[] }
  | { kind: 'non-head-regen'; groupRoot: string; members: BranchMember[] };

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
  invocationId: run.invocationId,
  ...run.state,
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
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _hydrator: HistoryHydrator;
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

  /**
   * Non-head regenerate selections, keyed by the regenerate target's
   * codec-message-id. Separate from {@link _regenSelections} because a non-head
   * regenerator parents inside the owner run rather than as a same-parent
   * sibling, so it lives outside the Tree's `visibleNodes` selection space and
   * is resolved at extraction (see `_extractMessages`). Value is the selected
   * member's nodeKey (the owner run id, or a regenerator run id); absent groups
   * default to the newest regenerator.
   */
  private readonly _nonHeadRegenSelections = new Map<string, RegenSelection>();

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

  /** Buffer of withheld nodes (input + reply), drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: ConversationNode<TProjection>[] = [];

  /**
   * Message-level trim on top of the run-level pagination window. Runs are
   * revealed whole (via `_withheldRunIds`/`_withheldBuffer`), so a `loadOlder`
   * may surface more messages than asked; this is the count of OLDEST messages
   * of the visible node chain to hide from `getMessages()` so a page lands on
   * exactly `limit` messages. The boundary run still appears in `runs()` (it's
   * a revealed node); only its oldest messages are trimmed from the flat list.
   * Live messages append at the newest end and are never trimmed.
   */
  private _hiddenMessageCount = 0;

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
    this._codec = options.codec;
    this._hydrator = options.hydrator;
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
    this._lastVisibleMessagePairs = this._extractMessages(this._cachedNodes).slice(this._hiddenMessageCount);
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
   * The regenerator runs that replaced a non-head message of a reply run. They
   * file under the target's predecessor (not the owner run's input node), so the
   * Tree's `visibleNodes` cannot collapse them into the owner's slot; this
   * surfaces them for the View to resolve and render. Head-message (index 0)
   * regenerates are excluded - those are whole-reply sibling runs the Tree
   * already groups.
   * @param targetCodecMessageId - The regenerate target's (non-head) message id.
   * @param predecessorCodecMessageId - The codec-message-id immediately before it in the owner run.
   * @returns The regenerator runs in startSerial order (oldest first).
   */
  private _nonHeadRegenerators(
    targetCodecMessageId: string,
    predecessorCodecMessageId: string,
  ): RunNode<TProjection>[] {
    return this._tree
      .getReplyRuns(predecessorCodecMessageId)
      .filter((r) => r.regeneratesCodecMessageId === targetCodecMessageId)
      .toSorted((a, b) => (a.startSerial ?? '￿').localeCompare(b.startSerial ?? '￿'));
  }

  /**
   * Resolve the selected member of a non-head regenerate group anchored at
   * `targetCodecMessageId`. Members are the owner run `O` (memberNodeKey =
   * `ownerRunId`, the regenerate target in place) followed by each regenerator
   * run. Honours an explicit {@link _nonHeadRegenSelections} entry, else
   * defaults to the latest member (newest regenerator), mirroring the
   * whole-reply regenerate default.
   * @param targetCodecMessageId - The regenerate target's message id (the group anchor).
   * @param ownerRunId - The runId of the run that owns the regenerate target.
   * @param regenerators - The regenerator runs (oldest first) from `_nonHeadRegenerators`.
   * @returns The selected member's node key (`ownerRunId` or a regenerator runId).
   */
  private _selectedNonHeadMember(
    targetCodecMessageId: string,
    ownerRunId: string,
    regenerators: RunNode<TProjection>[],
  ): string {
    const sel = this._nonHeadRegenSelections.get(targetCodecMessageId);
    if (sel && sel.kind !== 'pending') {
      const keys = [ownerRunId, ...regenerators.map((r) => r.runId)];
      if (keys.includes(sel.selectedRunId)) return sel.selectedRunId;
    }
    // Default: latest member = newest regenerator (regenerators is oldest-first).
    return regenerators.at(-1)?.runId ?? ownerRunId;
  }

  /**
   * Flatten visible nodes to messages, collapsing each non-head regenerate into
   * the slot it replaces, via the shared {@link collectMessages}. The View
   * supplies the codec's `getMessages` and resolves a non-head group's
   * regenerators and selected member from its own navigation state.
   * @param nodes - Visible nodes (inputs + reply runs), chronological.
   * @returns The flat message list, each paired with its codec-message-id.
   */
  private _extractMessages(nodes: ConversationNode<TProjection>[]): CodecMessage<TMessage>[] {
    return collectMessages(nodes, (projection) => this._codec.getMessages(projection), {
      regenerators: (target, predecessor) => this._nonHeadRegenerators(target, predecessor),
      selected: (target, ownerRunId, regenerators) => this._selectedNonHeadMember(target, ownerRunId, regenerators),
    });
  }

  hasOlder(): boolean {
    return this._hiddenMessageCount > 0 || this._withheldBuffer.length > 0 || this._hydrator.hasNext();
  }

  /**
   * Reveal `limit` more older codecMessages in this view — fewer only when
   * channel history is exhausted.
   *
   * Internally runs are revealed WHOLE (run-granular withholding), counting
   * codecMessages to decide how many runs to bring in, then the flat list
   * returned by {@link getMessages} is trimmed to exactly `limit` more
   * messages. So a run straddling the boundary still appears in {@link runs}
   * (it's a revealed node) while only its newest messages show in
   * `getMessages`. Live messages append at the newest end and are never
   * trimmed.
   * @param limit - Number of older codecMessages to reveal. Defaults to 10.
   */
  async loadOlder(limit = 10): Promise<void> {
    if (this._closed || this._loadingOlder) return;
    this._loadingOlder = true;
    this._logger.trace('DefaultView.loadOlder();', { limit });

    try {
      // Phase A: the boundary run is already revealed (a previous loadOlder
      // pulled in a whole run that overshot the message limit); reveal more of
      // its trimmed-off oldest messages without fetching or revealing new runs.
      if (this._hiddenMessageCount >= limit) {
        this._hiddenMessageCount -= limit;
        this._recomputeAndEmit();
        return;
      }

      // Phase B: reveal whole older runs covering the remaining message budget,
      // then re-trim so exactly `limit` new messages surface. Runs are revealed
      // whole (node granularity); the trim makes the message count exact.
      const need = limit - this._hiddenMessageCount;
      const before = this._extractMessages(this._computeFlatNodes()).length;
      const revealedSoFar = (): number => this._extractMessages(this._computeFlatNodes()).length - before;

      // Drain the withheld buffer toward `need` (whole older runs, newest-first).
      if (this._withheldBuffer.length > 0) {
        const splitIdx = messageTailSplitIndex(this._withheldBuffer, need, (p) => this._codec.getMessages(p));
        const batch = this._withheldBuffer.splice(splitIdx);
        this._releaseWithheld(batch);
      }

      // If the buffer was empty or fell short of `need` (e.g. it held a
      // zero-message run), fetch channel history for the remainder. The fetch
      // path loops over pages internally until it covers its target or history
      // is exhausted, so a single call here suffices.
      if (revealedSoFar() < need) {
        await this._fetchOlder(need - revealedSoFar());
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() may be set during the await above
        if (this._closed) return;
      }

      const after = this._extractMessages(this._computeFlatNodes()).length;
      // `after - before` whole-run messages were added at the oldest end; show
      // `limit` of them (newest), hiding the overshoot plus what was already
      // trimmed. `<= 0` when history is exhausted before `limit` is reached.
      this._hiddenMessageCount = Math.max(0, this._hiddenMessageCount + (after - before) - limit);
      this._recomputeAndEmit();
    } catch (error) {
      this._logger.error('DefaultView.loadOlder(); failed', { error });
      throw error;
    } finally {
      this._loadingOlder = false;
    }
  }

  /**
   * Fetch older channel history covering at least `target` more codecMessages by
   * driving the shared hydrator, then reveal the newest whole runs it surfaced
   * and withhold the rest. The withheld buffer is assumed already drained by the
   * caller. The hydrator folds each page straight into the Tree and owns cursor
   * exhaustion, so this stops at `target` new visible codecMessages or when the
   * channel is exhausted. No-op once channel history is exhausted.
   * @param target - Minimum additional codecMessages this fetch aims to cover.
   */
  private async _fetchOlder(target: number): Promise<void> {
    if (!this._hydrator.hasNext()) return;

    // Snapshot before folding: every node already in the tree stays visible, so
    // only nodes the hydrator newly surfaces count toward `target`.
    const beforeKeys = new Set(this._treeVisibleNodes().map((n) => nodeKey(n)));
    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._treeVisibleNodes()) {
        if (!beforeKeys.has(nodeKey(n))) count += this._codec.getMessages(n.projection).length;
      }
      return count;
    };

    // Suppress per-message tree events while the hydrator folds: the withheld
    // window isn't set up yet, so subscribers must not briefly see raw history.
    // `_splitReveal` emits the single settled `update` afterwards.
    this._processingHistory = true;
    try {
      await this._hydrator.foldUntil(() => newVisibleCount() >= target);
    } finally {
      this._processingHistory = false;
    }
    if (this._closed) return;

    const newVisible = this._treeVisibleNodes().filter((n) => !beforeKeys.has(nodeKey(n)));
    this._splitReveal(newVisible, target);
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

  branchSelection(codecMessageId: string): BranchHandle<TMessage> {
    // Every handle carries the same `select` verb bound to this anchor; the
    // underlying `_selectSibling` resolves the branch point itself and no-ops
    // when the id anchors no group, so the non-anchor / unknown-id handles get
    // a safe no-op select without special-casing here.
    const select = (index: number): void => {
      this._selectSibling(codecMessageId, index);
    };
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (branch) {
      // Each member contributes its representative message as the branch-arrow
      // slot: for an edit fork that is the alternate user prompt; for a
      // whole-reply regenerate group the variant's first message; for a non-head
      // regenerate group the regenerate target (original) or the regenerator's
      // first message.
      const siblings = branch.members.flatMap((member) => {
        const owner = this._tree.getNodeByCodecMessageId(member.representativeCodecMessageId);
        if (!owner) return [];
        const found = this._codec
          .getMessages(owner.projection)
          .find((m) => m.codecMessageId === member.representativeCodecMessageId);
        return found ? [found.message] : [];
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
          select,
        };
      }
    }

    // Known non-anchor message: the handle's invariant is that
    // `siblings` contains the rendered message itself for any known
    // codec-message-id, so plain bubbles get `siblings.length === 1`
    // (not `0`) and the indexing space matches between read and write.
    // Resolve the owning node kind-blind — a plain user prompt is an input
    // node, an assistant message lives in a reply run; both carry a projection.
    const owner = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (owner) {
      const found = this._codec.getMessages(owner.projection).find((m) => m.codecMessageId === codecMessageId);
      if (found !== undefined) {
        return { hasSiblings: false, siblings: [found.message], index: 0, selected: found.message, select };
      }
    }

    // Unknown id, or the owner Run is known but the codec doesn't surface
    // a message with this id from the projection (e.g. an event-only fold
    // such as a tool result that mutates an assistant in-place without
    // exposing its own TMessage). Treat both as "no rendered message",
    // returning the safe empty handle.
    return { hasSiblings: false, siblings: [], index: 0, selected: undefined, select };
  }

  // Spec: AIT-CT13c, AIT-CT13d
  private _selectSibling(codecMessageId: string, index: number): void {
    this._logger.trace('DefaultView._selectSibling();', { codecMessageId, index });
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (!branch) return;
    const clamped = Math.max(0, Math.min(index, branch.members.length - 1));
    const selected = branch.members[clamped];
    if (!selected) return; // unreachable: clamped is always in bounds
    if (branch.kind === 'fork-of') {
      this._branchSelections.set(branch.groupRoot, { kind: 'user', selectedKey: selected.memberNodeKey });
      this._logger.debug('DefaultView._selectSibling(); fork-of', {
        codecMessageId,
        index: clamped,
        selectedKey: selected.memberNodeKey,
      });
    } else if (branch.kind === 'non-head-regen') {
      // Non-head groups live outside the visibleNodes sibling space — store in
      // the dedicated map the message-extraction substitution reads.
      this._nonHeadRegenSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.memberNodeKey });
      this._logger.debug('DefaultView._selectSibling(); non-head-regen', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.memberNodeKey,
        anchor: branch.groupRoot,
      });
    } else {
      this._regenSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.memberNodeKey });
      this._logger.debug('DefaultView._selectSibling(); regenerate', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.memberNodeKey,
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
  private _resolveSelectedIndex(branch: MessageBranchPoint): number {
    if (branch.kind === 'fork-of') {
      const sel = this._branchSelections.get(branch.groupRoot);
      if (!sel) return branch.members.length - 1;
      const idx = branch.members.findIndex((m) => m.memberNodeKey === sel.selectedKey);
      return idx === -1 ? branch.members.length - 1 : idx;
    }
    const sel =
      branch.kind === 'non-head-regen'
        ? this._nonHeadRegenSelections.get(branch.groupRoot)
        : this._regenSelections.get(branch.groupRoot);
    if (!sel || sel.kind === 'pending') return branch.members.length - 1;
    const idx = branch.members.findIndex((m) => m.memberNodeKey === sel.selectedRunId);
    return idx === -1 ? branch.members.length - 1 : idx;
  }

  /**
   * Resolve the branch point anchored at `codecMessageId`, if any, returning the
   * group `kind` + members + groupRoot so the caller routes to the correct
   * selection map directly (not via a runId dispatch that would mis-route when
   * the owning Run is in both a fork-of and a regen group).
   * @param codecMessageId - The codec-message-id to look up.
   * @returns The resolved branch point, or undefined when `codecMessageId`
   *   anchors no group.
   */
  private _resolveMessageBranchPoint(codecMessageId: string): MessageBranchPoint | undefined {
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (!node) return undefined;

    // Edit-fork branch point: `codecMessageId` is a user INPUT node that has
    // sibling input nodes (alternate prompts via fork-of). The anchor is the
    // input node's own codec-message-id.
    if (node.kind === 'input') {
      const siblings = this._tree.getSiblingNodes(node.codecMessageId);
      if (siblings.length > 1) {
        return {
          kind: 'fork-of',
          groupRoot: this._tree.getGroupRoot(node.codecMessageId),
          members: this._nodeHeadMembers(siblings),
        };
      }
      return undefined;
    }

    // Non-head regenerate branch point: `codecMessageId` is the rendered slot for
    // a regenerate that replaced a non-head message inside a multi-message reply
    // run. Resolved BEFORE the same-parent `regen` group below: several non-head
    // regenerators of one anchor share a parent (the anchor's predecessor), so
    // the Tree files them as their own sibling group excluding the owner run; the
    // non-head resolver instead gathers the owner plus every regenerator into one
    // anchor-keyed group.
    const ownMessages = this._codec.getMessages(node.projection);
    const nonHead = this._resolveNonHeadBranchPoint(node, ownMessages, codecMessageId);
    if (nonHead) return nonHead;

    // Regenerate branch point: `codecMessageId` is owned by a reply run that has
    // sibling reply runs (the original reply + its regenerators, all parented at
    // the same input node). Anchor on the head message of the run so arrows
    // appear once per variant, not on every follow-up message.
    const siblings = this._tree.getSiblingNodes(node.runId);
    if (siblings.length > 1 && ownMessages.at(0)?.codecMessageId === codecMessageId) {
      return {
        kind: 'regen',
        groupRoot: this._tree.getGroupRoot(node.runId),
        members: this._nodeHeadMembers(siblings),
      };
    }

    return undefined;
  }

  /**
   * Resolve a non-head regenerate branch point from a reply-run message, if any.
   * `codecMessageId` is either (a) a non-head message `M` of its owner run with
   * regenerators, or (b) a regenerator run's head; both resolve to the same group
   * anchored at `M` (key matching {@link _nonHeadRegenSelections}).
   * @param node - The reply run owning `codecMessageId`.
   * @param ownMessages - That run's projected messages (already extracted).
   * @param codecMessageId - The slot's codec-message-id (an `M`, or a regenerator head).
   * @returns The non-head branch point, or undefined when `codecMessageId` anchors none.
   */
  private _resolveNonHeadBranchPoint(
    node: RunNode<TProjection>,
    ownMessages: CodecMessage<TMessage>[],
    codecMessageId: string,
  ): MessageBranchPoint | undefined {
    // Case (b): `codecMessageId` is a regenerator run's head. Re-anchor on the
    // message it regenerates and resolve from the owner run's perspective.
    const isHead = ownMessages.at(0)?.codecMessageId === codecMessageId;
    if (isHead && node.regeneratesCodecMessageId !== undefined) {
      const anchorId = node.regeneratesCodecMessageId;
      const owner = this._runByCodecMessageId(anchorId);
      if (owner) {
        const ownerMsgs = this._codec.getMessages(owner.projection);
        const idx = ownerMsgs.findIndex((mm) => mm.codecMessageId === anchorId);
        const predecessor = idx > 0 ? ownerMsgs[idx - 1]?.codecMessageId : undefined;
        if (predecessor !== undefined) {
          return this._buildNonHeadGroup(anchorId, owner.runId, predecessor);
        }
      }
      return undefined;
    }

    // Case (a): `codecMessageId` is a non-head message of its owner run.
    const idx = ownMessages.findIndex((mm) => mm.codecMessageId === codecMessageId);
    const predecessor = idx > 0 ? ownMessages[idx - 1]?.codecMessageId : undefined;
    if (predecessor === undefined) return undefined;
    return this._buildNonHeadGroup(codecMessageId, node.runId, predecessor);
  }

  /**
   * Build the {@link MessageBranchPoint} for a non-head regenerate group, or
   * undefined when the anchor has no regenerators. The owner member's
   * representative is the anchor message (the regenerate target); each
   * regenerator's is its head message.
   * @param anchorCodecMessageId - The regenerate target's (non-head) message id.
   * @param ownerRunId - The runId owning the regenerate target.
   * @param predecessorCodecMessageId - The codec-message-id immediately before the anchor in the owner run.
   * @returns The non-head branch point, or undefined when there are no regenerators.
   */
  private _buildNonHeadGroup(
    anchorCodecMessageId: string,
    ownerRunId: string,
    predecessorCodecMessageId: string,
  ): MessageBranchPoint | undefined {
    const regenerators = this._nonHeadRegenerators(anchorCodecMessageId, predecessorCodecMessageId);
    if (regenerators.length === 0) return undefined;
    const members: BranchMember[] = [{ memberNodeKey: ownerRunId, representativeCodecMessageId: anchorCodecMessageId }];
    for (const r of regenerators) {
      const head = this._codec.getMessages(r.projection).at(0);
      if (head) members.push({ memberNodeKey: r.runId, representativeCodecMessageId: head.codecMessageId });
    }
    return { kind: 'non-head-regen', groupRoot: anchorCodecMessageId, members };
  }

  /**
   * Project nodes to {@link BranchMember}s for fork-of / whole-reply regen
   * groups, where each member's branch-arrow representative is its own head
   * message and its memberNodeKey is its node key.
   * @param nodes - The sibling nodes.
   * @returns One member per node that has a head message.
   */
  private _nodeHeadMembers(nodes: ConversationNode<TProjection>[]): BranchMember[] {
    const members: BranchMember[] = [];
    for (const n of nodes) {
      const head = this._codec.getMessages(n.projection).at(0);
      if (head) members.push({ memberNodeKey: nodeKey(n), representativeCodecMessageId: head.codecMessageId });
    }
    return members;
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
    // is the triggering input's id and IS its node key. Edit forks are input-node
    // sibling groups, so the selection is keyed by the input group root and the
    // selected member is the new input node's key.
    const editedInputKey = result.inputCodecMessageId;
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

    // Non-head regenerate: the anchor is a non-head message of its owner run, so
    // the new run won't be a same-parent sibling — it parents at the anchor's
    // predecessor. Defer in the dedicated non-head map (keyed by the anchor
    // message), not the sibling-group regen map.
    const anchorMsgs = this._codec.getMessages(anchorRun.projection);
    if (anchorMsgs.at(0)?.codecMessageId !== anchorCodecMessageId) {
      this._nonHeadRegenSelections.set(anchorCodecMessageId, {
        kind: 'pending',
        carrierCodecMessageId: result.inputCodecMessageId,
      });
      this._logger.debug('DefaultView._applyRegenerateAutoSelect(); deferring non-head regenerate selection', {
        anchorCodecMessageId,
        carrier: result.inputCodecMessageId,
      });
      this._resolvePendingNonHeadRegenSelections();
      this._recomputeAndEmitIfChanged();
      return;
    }

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
    this._nonHeadRegenSelections.clear();
    this._withheldRunIds.clear();
    this._withheldBuffer.length = 0;
    this._hiddenMessageCount = 0;
    this._onClose?.();
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  /**
   * Reveal the newest whole runs covering `target` codecMessages from
   * `newVisible` and withhold the rest so subsequent `loadOlder` calls can
   * drain them. Reveal granularity is the whole run; the caller trims the flat
   * message list (via `_hiddenMessageCount`) to make the visible message count
   * exact. Called by {@link _fetchOlder}.
   * @param newVisible - Newly observed nodes (inputs + reply runs) from the history fetch, chronological.
   * @param target - Minimum codecMessages the revealed batch must cover.
   */
  private _splitReveal(newVisible: ConversationNode<TProjection>[], target: number): void {
    const splitIdx = messageTailSplitIndex(newVisible, target, (p) => this._codec.getMessages(p));
    const batch = newVisible.slice(splitIdx);
    const withheld = newVisible.slice(0, splitIdx);
    for (const n of withheld) {
      this._withheldRunIds.add(nodeKey(n));
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
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
    // Run-level reveal, message-level trim: drop the oldest `_hiddenMessageCount`
    // messages so a `loadOlder` page lands on exactly `limit` messages even
    // though whole runs were revealed.
    this._lastVisibleMessagePairs = this._extractMessages(resolved).slice(this._hiddenMessageCount);
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while the hydrator folds history pages. Each
    // fold fires this handler synchronously — but _withheldRunIds hasn't been
    // populated yet, so _computeFlatNodes() would return unfiltered history.
    // Without this guard, subscribers briefly see all history Runs before the
    // pagination window is applied. The final update is emitted by
    // _releaseWithheld after withholding is set up.
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
    this._resolvePendingNonHeadRegenSelections();

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
   * `pending` branch selection), select the newest sibling (the awaited Run)
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

  /**
   * Roll `pending` and `auto` non-head regenerate selections forward to the
   * newest regenerator of their anchor message. Mirrors
   * {@link _resolvePendingRegenSelections} for the non-head group, which lives in
   * a separate selection map (anchored by the regenerate target rather than a
   * sibling-group root): a `user` selection pins and is left untouched; a
   * `pending`/`auto` slot adopts the newest regenerator once one lands. The
   * anchor's predecessor — the key the regenerators file under — is recovered
   * from the owning run's projection.
   */
  private _resolvePendingNonHeadRegenSelections(): void {
    for (const [anchorId, sel] of this._nonHeadRegenSelections) {
      if (sel.kind === 'user') continue;
      const owner = this._runByCodecMessageId(anchorId);
      if (!owner) continue;
      const ownerMsgs = this._codec.getMessages(owner.projection);
      const idx = ownerMsgs.findIndex((m) => m.codecMessageId === anchorId);
      const predecessor = idx > 0 ? ownerMsgs[idx - 1]?.codecMessageId : undefined;
      if (predecessor === undefined) continue;
      const newest = this._nonHeadRegenerators(anchorId, predecessor).at(-1);
      if (!newest) continue;
      this._nonHeadRegenSelections.set(anchorId, { kind: 'auto', selectedRunId: newest.runId });
    }
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // The hydrator folds history wires into the Tree and emits them through its
    // `ably-message` channel for the input-event locator's benefit; the View
    // must not surface those (the event is scoped to visible runs, and a folded
    // run isn't revealed yet). `isFolding()` is true only during the hydrator's
    // synchronous per-page fold, so a live message arriving between page fetches
    // — or any time outside a fold — is still forwarded. A visible-set check
    // alone is not enough: `_onTreeRun` adds a history run-start to the visible
    // set mid-fold (its parent sits in an older, not-yet-folded page, so it
    // reads as visible), which would otherwise let that run's folds leak.
    if (this._hydrator.isFolding()) return;

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
    // Suppress history-folded run lifecycle: the hydrator folds older runs into
    // the Tree, and `_isRunStartVisible` reads an as-yet-unresolved parent (it
    // sits in an older, not-yet-folded page) as visible — which would fire a
    // spurious `run` and add the run to the visible set, leaking its folds as
    // `ably-message`. `isFolding()` is true only during the synchronous fold, so
    // a live run-start arriving between page fetches is still added and forwarded.
    if (this._hydrator.isFolding()) return;

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
 * @param options - The tree, codec, hydrator, and logger to use.
 * @returns A new {@link DefaultView} instance.
 */
export const createView = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: ViewOptions<TInput, TOutput, TProjection, TMessage>,
): DefaultView<TInput, TOutput, TProjection, TMessage> => new DefaultView(options);
