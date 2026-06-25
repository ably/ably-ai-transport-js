/**
 * BranchSource — the branch strategy a View projects over.
 *
 * A {@link View} owns the invariant machinery (pagination window, event
 * scoping, the read surface); a BranchSource supplies the parts that vary by
 * branch strategy:
 *
 *  - **which nodes are on the branch** — {@link BranchSource.visibleNodes}
 *  - **how that branch flattens to messages** — {@link BranchSource.extractMessages}
 *    (both go through the shared `collectMessages`, differing only in the
 *    non-head-regenerate resolver)
 *  - **which reply run an input resolves to** — {@link BranchSource.selectedReplyRun}
 *  - **post-update reconciliation** — {@link BranchSource.onVisibleNodesChanged}
 *
 * {@link NavigableBranchSource} is the client strategy: it navigates the whole
 * branching tree via per-view sibling/regenerate selection state (resolving the
 * branch from those selections, with a selection-map-driven non-head-regenerate
 * resolver), and additionally owns the branch-navigation surface
 * (`branchSelection`, selection recording, fork/regenerate auto-select) the
 * client's write path drives — none of which is part of the read-only
 * `BranchSource` contract. The agent's `LeafBranchSource` is the other strategy:
 * a single leaf-pinned branch (a parent walk) backing `run.view`, sharing this
 * same read contract.
 */

import type { Logger } from '../../logger.js';
import type { Codec, CodecInputEvent, CodecMessage, CodecOutputEvent } from '../codec/types.js';
import { collectMessages } from './conversation-projection.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type { ActiveRun, BranchHandle, ConversationNode, RunNode, SendOptions } from './types.js';

// ---------------------------------------------------------------------------
// BranchSource contract
// ---------------------------------------------------------------------------

/**
 * The branch strategy a {@link View} reads through. Implemented by
 * {@link NavigableBranchSource} (the client's whole-tree navigation) and the
 * agent's `LeafBranchSource` (a single leaf-pinned branch backing `run.view`).
 * The View owns pagination and events; the source owns "what is the branch and
 * how does it flatten".
 */
export interface BranchSource<TProjection, TMessage> {
  /**
   * The branch's node chain (input nodes + reply runs, chronological), already
   * sibling-resolved, BEFORE the View applies its pagination window.
   * @returns The resolved visible node chain.
   */
  visibleNodes(): ConversationNode<TProjection>[];

  /**
   * Flatten a node chain to the flat message list the View renders, collapsing
   * non-head regenerates into the slot they replace (via the shared
   * `collectMessages`, with this source's resolver).
   * @param nodes - Visible nodes (inputs + reply runs), chronological.
   * @returns The flat message list, each paired with its codec-message-id.
   */
  extractMessages(nodes: ConversationNode<TProjection>[]): CodecMessage<TMessage>[];

  /**
   * The reply run an input node currently resolves to (for `runOf`), honouring
   * this source's selection where it has one. Undefined when no reply run has
   * started for the input.
   * @param inputCodecMessageId - The input node's codec-message-id.
   * @returns The selected reply RunNode, or undefined.
   */
  selectedReplyRun(inputCodecMessageId: string): RunNode<TProjection> | undefined;

  /**
   * Maintenance hook the View calls on a structural tree update, BEFORE it
   * recomputes the visible window. Lets the source reconcile its selection state
   * against the new tree (the client pins external forks and rolls pending
   * regenerate selections forward; a source with no selection state does nothing).
   * @param prevVisibleNodeKeys - The node keys that were visible before this update.
   */
  onVisibleNodesChanged(prevVisibleNodeKeys: string[]): void;
}

// ---------------------------------------------------------------------------
// Branch selection state (client navigation)
// ---------------------------------------------------------------------------

/**
 * Internal tagged union representing why a branch was selected for an
 * edit-fork group. Stored per group-root runId in the source's
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
 *   sibling-run group, so the source resolves and renders it itself (see
 *   {@link NavigableBranchSource.extractMessages}).
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
// Options
// ---------------------------------------------------------------------------

/** Constructor dependencies for {@link NavigableBranchSource}. */
export interface NavigableBranchSourceOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The tree to navigate. */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// NavigableBranchSource — the client's whole-tree branch navigation
// ---------------------------------------------------------------------------

/**
 * The client branch strategy: navigates the whole branching tree via per-view
 * sibling/regenerate selection state, and exposes the navigation surface the
 * client's write path drives. Implements the read-only {@link BranchSource}
 * contract a {@link View} consumes, plus the navigation methods a `ClientView`
 * calls.
 */
export class NavigableBranchSource<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements BranchSource<TProjection, TMessage> {
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger;

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
   * is resolved at extraction (see {@link extractMessages}). Value is the selected
   * member's nodeKey (the owner run id, or a regenerator run id); absent groups
   * default to the newest regenerator.
   */
  private readonly _nonHeadRegenSelections = new Map<string, RegenSelection>();

  constructor(options: NavigableBranchSourceOptions<TInput, TOutput, TProjection, TMessage>) {
    this._tree = options.tree;
    this._codec = options.codec;
    this._logger = options.logger.withContext({ component: 'NavigableBranchSource' });
  }

  // -------------------------------------------------------------------------
  // BranchSource contract
  // -------------------------------------------------------------------------

  visibleNodes(): ConversationNode<TProjection>[] {
    return this._tree.visibleNodes(this._resolveSelections());
  }

  extractMessages(nodes: ConversationNode<TProjection>[]): CodecMessage<TMessage>[] {
    return collectMessages(nodes, (projection) => this._codec.getMessages(projection), {
      regenerators: (target, predecessor) => this._nonHeadRegenerators(target, predecessor),
      selected: (target, ownerRunId, regenerators) => this._selectedNonHeadMember(target, ownerRunId, regenerators),
    });
  }

  selectedReplyRun(inputCodecMessageId: string): RunNode<TProjection> | undefined {
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

  onVisibleNodesChanged(prevVisibleNodeKeys: string[]): void {
    // Pin selections for previously-visible Runs that now have siblings.
    // This prevents new forks (from other views' edits/regenerates) from
    // shifting this view to a branch the user didn't navigate to.
    this._pinBranchSelections(prevVisibleNodeKeys);
    this._resolvePendingRegenSelections();
    this._resolvePendingNonHeadRegenSelections();
  }

  /** Clear all selection state. Called when the owning view closes. */
  clear(): void {
    this._branchSelections.clear();
    this._regenSelections.clear();
    this._nonHeadRegenSelections.clear();
  }

  // -------------------------------------------------------------------------
  // Branch navigation (msg-anchored) — consumed by the client write path
  // -------------------------------------------------------------------------

  // Spec: AIT-CT13c, AIT-CT13d — branch points are codec-message-id
  // anchored. The source resolves the anchor (the user prompt for edits,
  // the assistant slot for regens) and routes the selection to the
  // appropriate internal selection map. Tree-level introspection
  // (RunNode access, runId-keyed queries) remains on the {@link Tree}.

  /**
   * Resolve the {@link BranchHandle} anchored at `codecMessageId`, attaching the
   * caller-supplied `select` verb. The handle's read state (siblings, index,
   * selected) is resolved here; `select` is owned by the view so it can trigger
   * a recompute after recording the selection via {@link recordSelection}.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @param select - The navigation verb to embed in the returned handle.
   * @returns The resolved branch handle.
   */
  branchSelection(codecMessageId: string, select: (index: number) => void): BranchHandle<TMessage> {
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

  /**
   * Record an explicit sibling selection at the branch point anchored at
   * `codecMessageId`. Routes to the correct selection map by branch kind.
   * Returns whether a selection was recorded — `false` (a no-op) when
   * `codecMessageId` anchors no group, so the view can skip recomputing.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @param index - The index of the sibling to select.
   * @returns True when a selection was recorded.
   */
  // Spec: AIT-CT13c, AIT-CT13d
  recordSelection(codecMessageId: string, index: number): boolean {
    this._logger.trace('NavigableBranchSource.recordSelection();', { codecMessageId, index });
    const branch = this._resolveMessageBranchPoint(codecMessageId);
    if (!branch) return false;
    const clamped = Math.max(0, Math.min(index, branch.members.length - 1));
    const selected = branch.members[clamped];
    if (!selected) return false; // unreachable: clamped is always in bounds
    if (branch.kind === 'fork-of') {
      this._branchSelections.set(branch.groupRoot, { kind: 'user', selectedKey: selected.memberNodeKey });
      this._logger.debug('NavigableBranchSource.recordSelection(); fork-of', {
        codecMessageId,
        index: clamped,
        selectedKey: selected.memberNodeKey,
      });
    } else if (branch.kind === 'non-head-regen') {
      // Non-head groups live outside the visibleNodes sibling space — store in
      // the dedicated map the message-extraction substitution reads.
      this._nonHeadRegenSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.memberNodeKey });
      this._logger.debug('NavigableBranchSource.recordSelection(); non-head-regen', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.memberNodeKey,
        anchor: branch.groupRoot,
      });
    } else {
      this._regenSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.memberNodeKey });
      this._logger.debug('NavigableBranchSource.recordSelection(); regenerate', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.memberNodeKey,
        groupRoot: branch.groupRoot,
      });
    }
    return true;
  }

  /**
   * Auto-select branch selections after a forking send. Returns whether a
   * selection was set — `false` when the send was not a fork, so the view can
   * skip recomputing.
   * @param result - The ActiveRun returned by the delegate.
   * @param options - The SendOptions passed by the caller.
   * @returns True when a fork selection was set.
   */
  applyForkAutoSelect(result: ActiveRun, options: SendOptions | undefined): boolean {
    // Spec: AIT-CT13e
    if (!options?.forkOf) return false;

    // An edit inserts a NEW user input node optimistically; its codec-message-id
    // is the triggering input's id and IS its node key. Edit forks are input-node
    // sibling groups, so the selection is keyed by the input group root and the
    // selected member is the new input node's key.
    const editedInputKey = result.inputCodecMessageId;
    const groupRoot = this._tree.getGroupRoot(editedInputKey);

    this._branchSelections.set(groupRoot, { kind: 'auto', selectedKey: editedInputKey });
    return true;
  }

  /**
   * Defer the regenerate group anchored at `anchorCodecMessageId` to the new
   * Run, promoting it as soon as the run lands in the tree. Returns whether a
   * pending selection was recorded — `false` when the anchor isn't owned by a
   * reply run, so the view can skip recomputing.
   *
   * `ClientView.regenerate()` calls this with the assistant codec-message-id
   * being regenerated. The Run doesn't exist yet on the channel (the regenerate
   * wire is wire-only); the selection is recorded as `pending` and promoted to
   * `auto` by the resolve-pending pass once the corresponding Run is created.
   * @param result - The ActiveRun returned by the delegate (run-id is the new regenerator's).
   * @param anchorCodecMessageId - The codec-message-id of the assistant being regenerated.
   * @returns True when a pending selection was recorded.
   */
  applyRegenerateAutoSelect(result: ActiveRun, anchorCodecMessageId: string): boolean {
    // A regenerate produces a new reply run parented at the SAME input node as
    // the original reply (the regenerate group). The agent mints the run-id, so
    // we cannot pin by it synchronously. Resolve the group root from the
    // original reply run owning the anchor, and pin a pending selection keyed by
    // that group root, carrying the regenerate carrier's codec-message-id
    // (`result.inputCodecMessageId`) so we can promote when the new reply run lands.
    const anchorRun = this._runByCodecMessageId(anchorCodecMessageId);
    if (!anchorRun) return false;

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
      this._logger.debug('NavigableBranchSource.applyRegenerateAutoSelect(); deferring non-head regenerate selection', {
        anchorCodecMessageId,
        carrier: result.inputCodecMessageId,
      });
      this._resolvePendingNonHeadRegenSelections();
      return true;
    }

    const groupRoot = this._tree.getGroupRoot(anchorRun.runId);

    this._regenSelections.set(groupRoot, {
      kind: 'pending',
      carrierCodecMessageId: result.inputCodecMessageId,
    });
    this._logger.debug('NavigableBranchSource.applyRegenerateAutoSelect(); deferring regenerate selection', {
      anchorCodecMessageId,
      groupRoot,
      carrier: result.inputCodecMessageId,
    });

    // The new reply run may already be in the tree (run-start raced ahead of the
    // sendDelegate resolution). Promote now so the visible set catches up without
    // waiting for the next structural change.
    this._resolvePendingRegenSelections();
    return true;
  }

  // -------------------------------------------------------------------------
  // Private: selection resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the reply Run that owns a codec-message-id, narrowing the Tree's
   * node union to a {@link RunNode}. A user-input codec-message-id resolves to
   * an input node and yields `undefined` here.
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
   * surfaces them for the source to resolve and render. Head-message (index 0)
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
   * For each previously-visible Run that now has siblings but no explicit
   * selection, pin the selection to that Run's runId. This preserves the
   * current branch when new forks appear from other views or external
   * sources.
   *
   * Exception: if the fork was initiated by this view (tracked as a
   * `pending` branch selection), select the newest sibling (the awaited Run)
   * instead of pinning the old one.
   * @param prevVisibleNodeKeys - The node keys visible before the tree update.
   */
  private _pinBranchSelections(prevVisibleNodeKeys: string[]): void {
    for (const key of prevVisibleNodeKeys) {
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

  /**
   * Resolve the currently selected sibling's index inside a branch group.
   * Pending selections fall back to the latest sibling. The caller clamps
   * the returned index against any post-extraction filtering.
   * @param branch - Resolved branch-point descriptor from `_resolveMessageBranchPoint`.
   * @returns The selected sibling's index within `branch.members`.
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
}
