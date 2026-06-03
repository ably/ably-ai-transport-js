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
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { decodeHistory } from './decode-history.js';
import { parseRunLifecycle } from './headers.js';
import type { TreeInternal } from './tree.js';
import type {
  ActiveRun,
  BranchSelection,
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
  /** Explicit navigation via `selectSibling()`. */
  | { kind: 'user'; selectedRunId: string }
  /** This view initiated a fork (edit) — auto-selected the result. */
  | { kind: 'auto'; selectedRunId: string }
  /** An external fork appeared — pinned to the currently-visible sibling to prevent drift. */
  | { kind: 'pinned'; selectedRunId: string }
  /** This view's `edit()` is in flight — select newest when run's response arrives. */
  | { kind: 'pending'; runId: string };

/**
 * Selection state for a regenerate group. Keyed by the anchor codec-message-id (the
 * assistant codec-message-id being regenerated). Distinct from {@link BranchSelectionState}
 * because regenerate groups are message-level (group members share an
 * anchor codec-message-id rather than a parentRunId), not Run-level forks.
 *
 * Unlike fork-of groups, regenerate groups do not "pin to current visible"
 * when a new member appears externally — the default for a regenerate
 * slot is always the latest member, so an external regenerator auto-rolls
 * forward unless the user has explicitly selected an earlier member.
 */
type RegenSelection =
  /** Explicit navigation via `selectSibling()`. */
  | { kind: 'user'; selectedRunId: string }
  /** This view initiated a regenerate — auto-selected the new Run when it arrived. */
  | { kind: 'auto'; selectedRunId: string }
  /** This view's `regenerate()` is in flight — promote to `auto` when the run's first content folds. */
  | { kind: 'pending'; runId: string };

// ---------------------------------------------------------------------------
// Send-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the two input shapes `View.sendInput` accepts (a single TInput
 * or an array) into the array shape the SendDelegate consumes.
 * @param input - The raw input from `View.sendInput`.
 * @returns The normalised input array.
 */
const _normaliseSendInput = <TInput extends CodecInputEvent>(input: TInput | TInput[]): TInput[] =>
  Array.isArray(input) ? input : [input];

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
 * Codec convention: each TMessage's `id` field carries the wire `codec-message-id`.
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
   * Cached result of the last flat-nodes computation. Drives the visible
   * message snapshot exposed via `getMessages()`; refreshed by
   * `_computeFlatNodes()` on structural changes, selection changes,
   * and history reveal.
   */
  private _cachedNodes: RunNode<TProjection>[] = [];

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
    if (!this._lastVisibleRunIdSet.has(event.runId)) return;

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
    this._lastVisibleMessages = this._extractMessages(this._cachedNodes);
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  getMessages(): TMessage[] {
    return this._lastVisibleMessages;
  }

  runs(): RunInfo[] {
    // `_cachedNodes` is the visible Run list with pagination, branch
    // selection, and regenerate substitution already applied — it's
    // refreshed by `_updateVisibleSnapshot()` after every relevant event.
    // Reading from it directly avoids a redundant tree walk.
    return this._cachedNodes.map((node) => _toRunInfo(node));
  }

  /**
   * Walk the tree and compute a fresh visible Run list, applying branch
   * selections, the withheld filter, and the regenerate-group filter.
   * @returns A fresh array of visible Runs.
   */
  private _computeFlatNodes(): RunNode<TProjection>[] {
    const treeNodes = this._tree.runs(this._resolveSelections());

    // Anchor codec-message-ids that a visible regenerator will substitute
    // out of the chain. A follow-up Run rooted at one of these messages
    // (e.g. a user prompt that replied to the original assistant before
    // the user regenerated it) belongs to the now-replaced timeline and
    // must drop with it. Build the set up front so a single pass can
    // both apply the regen filter and the anchor-shadow filter together.
    const substitutedAnchors = new Set<string>();
    for (const node of treeNodes) {
      if (node.regeneratesCodecMessageId === undefined) continue;
      if (this._isRegenHiddenByGroupSelection(node)) continue;
      substitutedAnchors.add(node.regeneratesCodecMessageId);
    }

    const candidates: RunNode<TProjection>[] = [];
    // `tree.runs()` reachability respects fork-of selections only — it has
    // no view of regen-group selection or pagination withholding. A Run
    // parented at a message inside a regen-hidden owner (e.g. a follow-up
    // turn whose user prompt lives in the regenerator's projection) needs
    // to drop out alongside its parent. Track which Runs the View keeps
    // and re-check parent reachability against that set.
    const visibleRunIds = new Set<string>();
    for (const node of treeNodes) {
      if (this._withheldRunIds.has(node.runId)) continue;
      if (this._isRegenHiddenByGroupSelection(node)) continue;
      if (node.parentRunId !== undefined && !visibleRunIds.has(node.parentRunId)) continue;
      // Drop follow-up Runs whose parent msg is being regen-substituted.
      // Regenerators themselves are exempt — their `parentCodecMessageId`
      // is the same user prompt the substituted msg replied to, not the
      // substituted msg itself.
      if (
        node.regeneratesCodecMessageId === undefined &&
        node.parentCodecMessageId !== undefined &&
        substitutedAnchors.has(node.parentCodecMessageId)
      ) {
        continue;
      }
      visibleRunIds.add(node.runId);
      candidates.push(node);
    }

    // Shadow filter: a regenerator whose anchor msg-id is in the
    // truncated tail of its owner Run (because another regenerator
    // targets an *earlier* position in the same owner) belongs to a
    // timeline that's no longer in the visible chain. Drop it.
    //
    // Example: R1 = [u1, TC1, TT1]. R2 regenerates TT1; R3 regenerates
    // TC1. Selecting R3 truncates R1 at TC1 (index 1) — TT1 is no
    // longer in the chain, so R2's anchor is moot and R2's content
    // (TT1') shouldn't leak in between u1 and R3's content.
    const earliestTruncationByOwner = new Map<string, number>();
    for (const node of candidates) {
      if (node.regeneratesCodecMessageId === undefined) continue;
      const anchorIdx = this._anchorIndexInOwner(node.regeneratesCodecMessageId);
      if (anchorIdx === undefined) continue;
      const ownerRunId = anchorIdx.ownerRunId;
      const existing = earliestTruncationByOwner.get(ownerRunId);
      if (existing === undefined || anchorIdx.index < existing) {
        earliestTruncationByOwner.set(ownerRunId, anchorIdx.index);
      }
    }

    const visible: RunNode<TProjection>[] = [];
    for (const node of candidates) {
      if (node.regeneratesCodecMessageId !== undefined) {
        const anchorIdx = this._anchorIndexInOwner(node.regeneratesCodecMessageId);
        if (anchorIdx !== undefined) {
          const earliest = earliestTruncationByOwner.get(anchorIdx.ownerRunId);
          if (earliest !== undefined && anchorIdx.index > earliest) {
            continue;
          }
        }
      }
      visible.push(node);
    }
    return visible;
  }

  /**
   * Locate `anchorMsgId` inside its owning Run's projection.
   * @param anchorMsgId - The msg-id to look up.
   * @returns The owner runId and the message's index in that Run's
   *   projection, or `undefined` when the msg-id has no owner.
   */
  private _anchorIndexInOwner(anchorMsgId: string): { ownerRunId: string; index: number } | undefined {
    const ownerRun = this._tree.getRunByCodecMessageId(anchorMsgId);
    if (!ownerRun) return undefined;
    const messages = this._codec.getMessages(ownerRun.projection);
    const index = messages.findIndex((m) => _readMessageId(m) === anchorMsgId);
    if (index === -1) return undefined;
    return { ownerRunId: ownerRun.runId, index };
  }

  /**
   * Whether `node` is hidden because its regenerate group has selected a
   * different member. Regenerator Runs that aren't the selected member
   * are filtered out of the visible chain; the owner Run (the one that
   * holds the regenerated codec-message-id) is always visible — only the
   * regenerated message itself is dropped by {@link _extractMessages}.
   * @param node - A Run from `tree.runs`.
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
   * Extract the flat TMessage[] from a visible Run chain.
   *
   * Each owner Run's messages are emitted in projection order, with two
   * substitutions applied as we walk:
   *
   * 1. When a message's codec-message-id is the anchor of a visible
   *    regenerator Run, the regenerator's content is emitted **in
   *    place of the anchor** — at the anchor's position, not at the
   *    end of the visible chain. The owner Run's remaining
   *    (post-anchor) messages are skipped: they belong to the
   *    timeline that was replaced; their counterparts live inside
   *    the regenerator (which we just emitted).
   * 2. The recursion holds inside the regenerator too — if its own
   *    content contains an anchor of another visible regenerator
   *    (nested regen), we recurse and substitute again.
   *
   * Regenerator Runs are visited from their owners; we skip them at
   * the top level so they're emitted exactly once.
   *
   * Without (1), a regenerator whose owner is followed by later Runs
   * (e.g. `R1 = [u1, a1], R2 (parent=a1) = [u2, a2], R3 (regen of a1)
   * = [a1']`) renders as `[u1, u2, a2, a1']` instead of the natural
   * `[u1, a1', u2, a2]`, because the Run sort order is by
   * `startSerial` and R3 is the newest.
   * @param nodes - The visible Runs in chronological order.
   * @returns The flat message list with regenerator substitutions applied.
   */
  private _extractMessages(nodes: RunNode<TProjection>[]): TMessage[] {
    const regeneratorByAnchor = new Map<string, RunNode<TProjection>>();
    const regeneratorRunIds = new Set<string>();
    for (const node of nodes) {
      if (node.regeneratesCodecMessageId !== undefined) {
        regeneratorByAnchor.set(node.regeneratesCodecMessageId, node);
        regeneratorRunIds.add(node.runId);
      }
    }

    const messages: TMessage[] = [];
    const emitted = new Set<string>();
    const emitFromRun = (run: RunNode<TProjection>): void => {
      if (emitted.has(run.runId)) return;
      emitted.add(run.runId);
      for (const m of this._codec.getMessages(run.projection)) {
        const id = _readMessageId(m);
        if (id !== undefined) {
          const substitute = regeneratorByAnchor.get(id);
          if (substitute && substitute.runId !== run.runId) {
            emitFromRun(substitute);
            return;
          }
        }
        messages.push(m);
      }
    };

    for (const node of nodes) {
      if (regeneratorRunIds.has(node.runId)) continue;
      emitFromRun(node);
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
  // Run lookup
  // -------------------------------------------------------------------------

  runOf(codecMessageId: string): RunInfo | undefined {
    this._logger.trace('DefaultView.runOf();', { codecMessageId });
    const run = this._tree.getRunByCodecMessageId(codecMessageId);
    return run ? _toRunInfo(run) : undefined;
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
      const siblings =
        branch.kind === 'fork-of'
          ? branch.siblings.flatMap((s) => {
              const first = this._codec.getMessages(s.projection).at(0);
              return first ? [first] : [];
            })
          : branch.siblings.flatMap((s) => {
              const msgs = this._codec.getMessages(s.projection);
              const anchored = msgs.find((m) => _readMessageId(m) === branch.anchorCodecMessageId);
              if (anchored) return [anchored];
              const first = msgs.at(0);
              return first ? [first] : [];
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
    const owner = this._tree.getRunByCodecMessageId(codecMessageId);
    if (owner) {
      const message = this._codec.getMessages(owner.projection).find((m) => _readMessageId(m) === codecMessageId);
      if (message !== undefined) {
        return { hasSiblings: false, siblings: [message], index: 0, selected: message };
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
      this._branchSelections.set(branch.groupRoot, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.selectSibling(); fork-of', {
        codecMessageId,
        index: clamped,
        selectedRunId: selected.runId,
      });
    } else {
      this._regenSelections.set(branch.anchorCodecMessageId, { kind: 'user', selectedRunId: selected.runId });
      this._logger.debug('DefaultView.selectSibling(); regenerate', {
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
   * Resolve the currently selected sibling's index inside a branch group.
   * Pending selections fall back to the latest sibling. The caller clamps
   * the returned index against any post-extraction filtering.
   * @param branch - Resolved branch-point descriptor from `_resolveMessageBranchPoint`.
   * @returns The selected sibling's index within `branch.siblings`.
   */
  private _resolveSelectedIndex(
    branch:
      | { kind: 'fork-of'; groupRoot: string; siblings: RunNode<TProjection>[] }
      | { kind: 'regen'; anchorCodecMessageId: string; siblings: RunNode<TProjection>[] },
  ): number {
    const sel =
      branch.kind === 'fork-of'
        ? this._branchSelections.get(branch.groupRoot)
        : this._regenSelections.get(branch.anchorCodecMessageId);
    if (!sel || sel.kind === 'pending') return branch.siblings.length - 1;
    const idx = branch.siblings.findIndex((n) => n.runId === sel.selectedRunId);
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

    // Regen branch point: codec-message-id is either the regen anchor
    // itself (in the owner Run) or the *first* content message of a
    // regenerator Run — the position-equivalent of the anchor in that
    // variant. Subsequent messages in a regenerator Run are follow-up
    // content (e.g. the LLM's text response after the regenerated tool
    // call) and are not branch anchors themselves; surfacing arrows on
    // them would show "2 / 2" on every message of the regenerated variant.
    //
    // Look up the group anchored at `codecMessageId` directly. The
    // owner-Run may anchor multiple distinct regen groups (e.g. R1
    // contains both a tool-call assistant and a follow-up text, each
    // regenerated by a separate Run); resolving the group via
    // `getRegenerateGroup(runId)` is ambiguous in that case because it
    // returns only one of them.
    const directGroup = this._tree.getRegenerateGroupByMsgId(codecMessageId);
    if (directGroup.length > 1) {
      return { kind: 'regen', anchorCodecMessageId: codecMessageId, siblings: directGroup };
    }

    // Otherwise, if `codecMessageId` is the head message of a regenerator
    // Run, its anchor is the position-equivalent in the owner Run.
    if (run.regeneratesCodecMessageId !== undefined) {
      const firstMsg = this._codec.getMessages(run.projection).at(0);
      if (firstMsg && _readMessageId(firstMsg) === codecMessageId) {
        const siblings = this._tree.getRegenerateGroupByMsgId(run.regeneratesCodecMessageId);
        if (siblings.length > 1) {
          return { kind: 'regen', anchorCodecMessageId: run.regeneratesCodecMessageId, siblings };
        }
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  async sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun> {
    this._logger.trace('DefaultView.sendMessage();');
    const list = Array.isArray(messages) ? messages : [messages];
    // Caller-supplied TMessage.id flows through as the wire HEADER_CODEC_MESSAGE_ID so
    // the codec convention `TMessage.id == wire codec-message-id` holds end-to-end
    // (decoded UIMessage.id matches the original, agent-side projection
    // doesn't get rebound to a fresh UUID).
    const items: TInput[] = list.map((m) => {
      const codecMessageId = _readMessageId(m);
      const base = this._codec.createUserMessage(m);
      // CAST: UserMessage<TMessage> is the well-known input variant
      // produced by `codec.createUserMessage`; TInput is the codec's full
      // input union, of which UserMessage<TMessage> is one member.
      // The cast through `unknown` is needed because TS can't see the
      // membership through the generic boundary.
      return codecMessageId !== undefined && codecMessageId !== ''
        ? ({ ...base, codecMessageId } as unknown as TInput)
        : (base as unknown as TInput);
    });
    return this.sendInput(items, options);
  }

  // Spec: AIT-CT3, AIT-CT4
  async sendInput(input: TInput | TInput[], options?: SendOptions): Promise<ActiveRun> {
    this._logger.trace('DefaultView.sendInput();');
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; view is closed', ErrorCode.InvalidArgument, 400);
    }

    const normalised = _normaliseSendInput<TInput>(input);

    // Pre-compute the visible branch's flat message list and the codec-message-id of
    // its tail. The delegate uses both: history for the HTTP POST body,
    // parentCodecMessageId for auto-parent routing on fresh user messages.
    const history = this.getMessages();
    const parentCodecMessageId = history.length > 0 ? _readMessageId(history.at(-1)) : undefined;

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
      if (evt.type !== 'end' || evt.runId !== result.runId) return;
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
  private _applyRegenerateAutoSelect(result: ActiveRun, anchorCodecMessageId: string): void {
    this._regenSelections.set(anchorCodecMessageId, { kind: 'pending', runId: result.runId });
    this._logger.debug('DefaultView._applyRegenerateAutoSelect(); deferring regenerate selection', {
      anchorCodecMessageId,
      runId: result.runId,
    });

    // The agent's ai-run-start may have arrived before the publish ACK
    // that resolved sendDelegate — in which case `_onTreeUpdate` already
    // re-walked with the previous selection still authoritative, hiding
    // the new Run. Promote the pending entry now (if the new Run is
    // already in the tree) and force a recompute so the visible set
    // catches up without waiting for the next structural change.
    this._resolvePendingRegenSelections();
    const nodes = this._computeFlatNodes();
    if (this._visibleChanged(nodes)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitter.emit('update');
    }

    // Bound pending entry lifetime to the run — clean up on run-end.
    const runUnsub = this._tree.on('run', (evt) => {
      if (evt.type !== 'end' || evt.runId !== result.runId) return;
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
      if (firstMsg && _readMessageId(firstMsg) === messageId) {
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
    // CAST: Regenerate is a well-known variant of TInput, but TS can't
    // verify membership through the generic boundary without help.
    const result = await this._sendDelegate([regenerate as unknown as TInput], sendOptions, parentCodecMessageId);
    this._applyRegenerateAutoSelect(result, regenAnchorMsgId);
    return result;
  }

  // Spec: AIT-CT6
  async edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ActiveRun> {
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

    return this.sendInput(inputs, {
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
    const beforeRunIds = new Set(this._tree.runs(this._resolveSelections()).map((n) => n.runId));

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
    const alreadyKnown = new Set(this._tree.runs(this._resolveSelections()).map((n) => n.runId));

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
        const headers = getTransportHeaders(rawMsg);
        const serial = rawMsg.serial;

        if (
          rawMsg.name === EVENT_RUN_START ||
          rawMsg.name === EVENT_RUN_SUSPEND ||
          rawMsg.name === EVENT_RUN_RESUME ||
          rawMsg.name === EVENT_RUN_END
        ) {
          const event = parseRunLifecycle(rawMsg.name, headers, serial);
          if (event) this._tree.applyRunLifecycle(event);
          continue;
        }

        const { inputs, outputs } = decoder.decode(rawMsg);
        if (headers[HEADER_RUN_ID]) {
          this._tree.applyMessage({ inputs, outputs }, headers, serial);
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
      for (const n of this._tree.runs(this._resolveSelections())) {
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

    const newVisible = this._tree.runs(this._resolveSelections()).filter((n) => !beforeRunIds.has(n.runId));
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
   * `tree.runs()`. Pending entries (no sibling yet) are omitted,
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
    const headers = getTransportHeaders(msg);
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
    if (event.type === 'start' && this._isRunStartVisible(event)) {
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
  private _isRunStartVisible(event: RunLifecycleEvent & { type: 'start' }): boolean {
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
export const createView = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: ViewOptions<TInput, TOutput, TProjection, TMessage>,
): DefaultView<TInput, TOutput, TProjection, TMessage> => new DefaultView(options);
