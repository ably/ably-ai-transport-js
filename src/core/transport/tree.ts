/**
 * Tree — materializes a branching conversation as a forest of nodes. Each turn
 * is two nodes: a user {@link InputNode} keyed by its client-owned
 * codec-message-id and an agent {@link RunNode} keyed by the agent-minted
 * run-id, parented to the input node.
 *
 * Each node holds a per-node codec {@link TProjection} which the Tree folds
 * from inbound events. The Tree owns the complete conversation state across
 * every observed node. The {@link View} walks the parent chain to extract a
 * flat message list for rendering.
 *
 * `applyMessage()` is the entry point for inbound channel messages — it
 * classifies a run-less user input into an input node (keyed by
 * codec-message-id) or routes a run-bearing wire to its reply run (keyed by
 * run-id), folds events into that node's projection, and maintains a secondary
 * `codecMessageId -> nodeKey` index. `applyRunLifecycle()` handles run-start /
 * run-end events.
 *
 * Sibling structure: editing a prompt produces a sibling input node linked by
 * {@link InputNode.forkOf}; regenerating a reply produces a sibling reply run
 * sharing the same input-node parent (no fork-of).
 */

import type * as Ably from 'ably';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import type { CodecInputEvent, CodecOutputEvent, Reducer } from '../codec/types.js';
import type { ConversationNode, InputNode, OutputEvent, RunLifecycleEvent, RunNode, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

interface InternalNode<TProjection> {
  node: ConversationNode<TProjection>;
  /** Insertion sequence — tiebreaker for null-startSerial nodes (optimistic). */
  insertSeq: number;
}

/**
 * The primary key a node is indexed under: a reply run's `runId`, or an input
 * node's `codecMessageId` (the client owns it before the agent mints a runId).
 * @param node - The node to key.
 * @returns The node's primary key.
 */
export const nodeKey = <TProjection>(node: ConversationNode<TProjection>): string =>
  node.kind === 'run' ? node.runId : node.codecMessageId;

/**
 * The serial a node sorts by: a reply run's `startSerial`, an input node's
 * `serial`. Undefined for an optimistic (not-yet-acked) node, which tail-sorts.
 * @param node - The node to read.
 * @returns The sort serial, or undefined for an optimistic node.
 */
const sortSerial = <TProjection>(node: ConversationNode<TProjection>): string | undefined =>
  node.kind === 'run' ? node.startSerial : node.serial;

// ---------------------------------------------------------------------------
// Internal interface — extended surface consumed by View / ClientSession
// ---------------------------------------------------------------------------

/** Internal tree surface used by View and ClientSession — not part of the public Tree API. */
export interface TreeInternal<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
> extends Tree<TOutput, TProjection> {
  /**
   * Monotonic counter that increments on structural changes (Run insert,
   * delete, startSerial promotion/reorder) but NOT on projection updates
   * (existing Run's projection mutated by fold). Allows the View to skip
   * full tree walks when only projection content changed.
   */
  readonly structuralVersion: number;

  /**
   * Walk the visible node chain (both input nodes and reply runs) along the
   * selected branches, in chronological order. The View renders from this.
   * @param selections - Per-group selected member key, keyed by group root.
   * @returns The visible nodes in chronological order.
   */
  visibleNodes(selections?: Map<string, string>): ConversationNode<TProjection>[];

  /**
   * Get the "group root" key for a sibling group — the stable key the
   * selection map is keyed by (the earliest edit version for input nodes, the
   * original reply for a regenerate group).
   */
  getGroupRoot(key: string): string;

  /**
   * The reply runs parented at an input node (its codec-message-id), in
   * iteration order. Empty when none have been observed. Used to resolve a
   * user prompt to its reply run(s).
   * @param inputCodecMessageId - The input node's codec-message-id.
   * @returns The reply runs parented at that input.
   */
  getReplyRuns(inputCodecMessageId: string): RunNode<TProjection>[];

  /**
   * Resolve the regenerate sibling group anchored at `codecMessageId`.
   *
   * Returned in chronological order: the Run that owns `codecMessageId` first
   * (lowest startSerial), then every Run with `regeneratesCodecMessageId === codecMessageId`
   * in serial order. Empty when neither the owner nor any regenerator has
   * been observed yet.
   * @param codecMessageId - The codec-message-id that anchors the group.
   * @returns Member Runs (owner first, then regenerators).
   */
  getRegenerateGroupByMsgId(codecMessageId: string): RunNode<TProjection>[];

  /**
   * Apply an inbound channel message to the tree.
   *
   * Classifies the message and routes it to the owning node:
   * 1. Run-less user input (no run-id, a `user`-role message carrying a
   *    codec-message-id and input events): creates or promotes the input node
   *    keyed by that codec-message-id, folds the input events.
   * 2. Run-bearing wire (assistant output, continuation tool-resolution, or a
   *    fresh agent-minted run): routes to the reply run by run-id (reconciling
   *    an optimistic insert by codec-message-id), folds events.
   * @param events - Decoded codec events, split by wire direction. Both are
   *   folded into the node's projection, inputs first.
   * @param events.inputs - Client-published events (`ai-input` wire).
   * @param events.outputs - Agent-published events (`ai-output` wire).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   */
  applyMessage(
    events: { inputs: TInput[]; outputs: TOutput[] },
    headers: Record<string, string>,
    serial?: string,
  ): void;

  /**
   * Apply a run-lifecycle event.
   *
   * - `start`: creates the Run (if missing) or sets status to 'active'.
   *   Tracks the run as active.
   * - `suspend`: sets RunNode.status to 'suspended' and records `endSerial`.
   *   The run stays live so a resume under the same `runId` picks up where it
   *   left off.
   * - `resume`: re-activates an existing suspended Run (status back to
   *   'active') without touching its structure or serials — a pure re-entry
   *   signal. A no-op if the Run is not yet known.
   * - `end`: sets RunNode.status to the end reason and `endSerial`.
   *   Untracks the run from active.
   *
   * Always emits a 'run' event to subscribers.
   * @param event - Lifecycle event payload, including the channel serial.
   */
  applyRunLifecycle(event: RunLifecycleEvent): void;

  /**
   * Remove a node from the tree by its key ({@link nodeKey} — a runId or an
   * input node's codec-message-id). Children become unreachable because their
   * parent is no longer on the active path.
   * @param key - The node key to remove.
   */
  delete(key: string): void;

  /**
   * Remove a node addressed by one of its codec-message-ids (resolved to the
   * owning node's key). Used to drop a failed optimistic input insert.
   * @param codecMessageId - A codec-message-id owned by the node to remove.
   */
  deleteByCodecMessageId(codecMessageId: string): void;

  /** Forward a raw Ably message event to tree subscribers. */
  emitAblyMessage(msg: Ably.InboundMessage): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** EventEmitter events map for the tree. */
interface TreeEventsMap<TOutput extends CodecOutputEvent> {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
  output: OutputEvent<TOutput>;
}

// Spec: AIT-CT13
export class DefaultTree<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
> implements TreeInternal<TInput, TOutput, TProjection> {
  private readonly _codec: Reducer<TInput | TOutput, TProjection>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<TreeEventsMap<TOutput>>;

  /**
   * All nodes indexed by their primary key ({@link nodeKey}): a reply run's
   * runId, or an input node's codec-message-id.
   */
  private readonly _nodeIndex = new Map<string, InternalNode<TProjection>>();

  /**
   * Maps every observed `codec-message-id` to its owning node's key
   * ({@link nodeKey}). For a reply run that is the runId of every message the
   * run published; for an input node it is the input's own codec-message-id.
   * Resolves fork-of / parent codec-message-ids to node keys, routes
   * continuation amend wires to existing nodes, and backs UI lookups that hold
   * a codec-message-id.
   */
  private readonly _codecMessageIdToNodeKey = new Map<string, string>();

  /**
   * All nodes sorted by startSerial (lexicographic). Null-startSerial nodes
   * (optimistic) sort after all serial-bearing nodes, ordered among themselves
   * by insertion sequence.
   */
  private readonly _sortedRuns: InternalNode<TProjection>[] = [];

  /**
   * Parent index: parent node key (the key its children's
   * `parentCodecMessageId` resolves to) to the set of child node keys. Root
   * nodes (no parent) are indexed under the key `undefined`. Kind-blind — a
   * reply run and an input node parent off each other through the same index.
   */
  private readonly _parentIndex = new Map<string | undefined, Set<string>>();

  /**
   * Reverse edge: an input node's codec-message-id to the set of reply-run ids
   * parented at it. Lets the View resolve a user prompt to its (selected) reply
   * run, and groups regenerate siblings (which all parent at the same input
   * node).
   */
  private readonly _replyRunsByInput = new Map<string, Set<string>>();

  /**
   * Regenerated codec-message-id -> set of runIds that regenerate it. A Run with
   * `regeneratesCodecMessageId` set inserts here on creation; the View uses this
   * index to resolve message-level regenerate sibling groups in one lookup.
   */
  private readonly _regenerateByMsgId = new Map<string, Set<string>>();

  /** Monotonically increasing counter for insertion sequence. */
  private _seqCounter = 0;

  /** Incremented on structural changes; unchanged on projection-only updates. */
  private _structuralVersion = 0;

  /**
   * Cached sibling-group lookups keyed by node key. The walk over forkOf
   * chains and the per-parent fan-out are pure functions of the node
   * graph, so the cache is keyed against {@link _structuralVersion}:
   * any topology mutation drops the cache and the next lookup
   * recomputes. Hits matter most during a single render pass where
   * the View calls `getSiblingNodes` once per visible node plus extra
   * per-message branch-anchor probes from React components.
   */
  private _siblingCache = new Map<string, InternalNode<TProjection>[]>();
  private _siblingCacheVersion = -1;

  get structuralVersion(): number {
    return this._structuralVersion;
  }

  constructor(codec: Reducer<TInput | TOutput, TProjection>, logger: Logger) {
    this._codec = codec;
    this._logger = logger;
    this._emitter = new EventEmitter<TreeEventsMap<TOutput>>(logger);
  }

  // -------------------------------------------------------------------------
  // Sorted list maintenance
  // -------------------------------------------------------------------------

  /**
   * Compare two Runs for sorted list ordering.
   * Serial-bearing Runs sort by startSerial (lexicographic).
   * Null-startSerial Runs sort after all serial-bearing Runs.
   * Among null-startSerial Runs, sort by insertion sequence.
   *
   * Optimistic (null-serial) Runs intentionally tail-sort so they reorder
   * into place when the server relay arrives and `applyMessage` promotes
   * startSerial — see {@link applyMessage}'s `_removeSortedRun` /
   * `_insertSortedRun` pair on the promotion path.
   * @param a - First Run to compare.
   * @param b - Second Run to compare.
   * @returns Negative if a sorts before b, positive if after, zero if equal.
   */
  // Spec: AIT-CT13a
  private _compareRuns(a: InternalNode<TProjection>, b: InternalNode<TProjection>): number {
    const sa = sortSerial(a.node);
    const sb = sortSerial(b.node);
    if (sa === undefined && sb === undefined) return a.insertSeq - b.insertSeq;
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.insertSeq - b.insertSeq;
  }

  /**
   * Insert a Run into sortedRuns at the correct position via binary search.
   * @param internal - The Run to insert.
   */
  private _insertSortedRun(internal: InternalNode<TProjection>): void {
    const startSerial = sortSerial(internal.node);

    // Fast path: null-startSerial always appends to end.
    if (startSerial === undefined) {
      this._sortedRuns.push(internal);
      return;
    }

    let lo = 0;
    let hi = this._sortedRuns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midRun = this._sortedRuns[mid];
      if (!midRun) break; // unreachable
      if (this._compareRuns(midRun, internal) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this._sortedRuns.splice(lo, 0, internal);
  }

  /**
   * Remove a Run from sortedRuns.
   * @param internal - The Run to remove.
   */
  private _removeSortedRun(internal: InternalNode<TProjection>): void {
    const idx = this._sortedRuns.indexOf(internal);
    if (idx !== -1) this._sortedRuns.splice(idx, 1);
  }

  // -------------------------------------------------------------------------
  // Parent index maintenance
  // -------------------------------------------------------------------------

  private _addToParentIndex(parentNodeKey: string | undefined, childKey: string): void {
    let set = this._parentIndex.get(parentNodeKey);
    if (!set) {
      set = new Set();
      this._parentIndex.set(parentNodeKey, set);
    }
    set.add(childKey);
  }

  private _removeFromParentIndex(parentNodeKey: string | undefined, childKey: string): void {
    const set = this._parentIndex.get(parentNodeKey);
    if (set) {
      set.delete(childKey);
      if (set.size === 0) this._parentIndex.delete(parentNodeKey);
    }
  }

  /**
   * Resolve a node's structural parent to the parent node's key
   * ({@link nodeKey}), or undefined for a root. The parent is named by a
   * codec-message-id (`parentCodecMessageId`); this maps it through the
   * codec-message-id index to the owning node's key (a runId for a reply run,
   * a codec-message-id for an input node). Returns undefined when the parent
   * hasn't been observed yet (the node is treated as a root until it arrives).
   * @param node - The node whose parent to resolve.
   * @returns The parent node's key, or undefined.
   */
  private _parentKeyOf(node: ConversationNode<TProjection>): string | undefined {
    const parentCodecMessageId = node.parentCodecMessageId;
    return parentCodecMessageId === undefined ? undefined : this._codecMessageIdToNodeKey.get(parentCodecMessageId);
  }

  // -------------------------------------------------------------------------
  // Sibling grouping
  // -------------------------------------------------------------------------

  /**
   * Get the sibling group that the node keyed by `key` belongs to. Kind-split:
   *
   * - **Reply runs** — every reply run sharing the same input-node parent is a
   *   sibling (the original reply + its regenerators all parent at the same
   *   input node M_user). No fork-of involved.
   * - **Input nodes** — edit versions: nodes sharing a parent AND linked by a
   *   `forkOf` chain to the group root.
   *
   * Returned ordered by startSerial (original/oldest first). A group of one is
   * returned as a single-element array (no branching).
   * @param key - The node key ({@link nodeKey}) to look up the group for.
   * @returns The ordered list of sibling nodes.
   */
  // Spec: AIT-CT13b
  private _getSiblingGroup(key: string): InternalNode<TProjection>[] {
    if (this._siblingCacheVersion !== this._structuralVersion) {
      this._siblingCache.clear();
      this._siblingCacheVersion = this._structuralVersion;
    }
    const cached = this._siblingCache.get(key);
    if (cached) return cached;

    const entry = this._nodeIndex.get(key);
    if (!entry) return [];

    // The "original" anchors the group's parent + kind. For an input node,
    // walk the forkOf chain to the earliest version sharing the parent; for a
    // reply run the node itself anchors (all same-parent runs are siblings).
    let original = entry.node;
    if (original.kind === 'input') {
      let input = original;
      const visitedGroup = new Set<string>([nodeKey(input)]);
      while (input.forkOf !== undefined) {
        if (visitedGroup.has(input.forkOf)) break;
        const forkTarget = this._nodeIndex.get(input.forkOf);
        if (forkTarget?.node.kind !== 'input' || forkTarget.node.parentCodecMessageId !== input.parentCodecMessageId) {
          break;
        }
        input = forkTarget.node;
        visitedGroup.add(nodeKey(input));
      }
      original = input;
    }

    // `_parentIndex` is keyed by the raw structural `parentCodecMessageId` (not
    // the resolved parent node key) so a run observed before its input node
    // still files/groups correctly — the parent codec-message-id is known at
    // creation, the resolved key may not be.
    const parentKey = original.parentCodecMessageId;
    const siblings: InternalNode<TProjection>[] = [];
    const candidateKeys = this._parentIndex.get(parentKey);
    if (candidateKeys) {
      for (const childKey of candidateKeys) {
        const childEntry = this._nodeIndex.get(childKey);
        if (childEntry && this._isSiblingOf(childEntry.node, original)) {
          siblings.push(childEntry);
        }
      }
    }

    siblings.sort((a, b) => this._compareRuns(a, b));
    // Cache against the queried key AND every member of the group: a single
    // group is the same array regardless of which member triggered the lookup,
    // so subsequent queries against any member hit without recomputing.
    for (const sib of siblings) {
      this._siblingCache.set(nodeKey(sib.node), siblings);
    }
    this._siblingCache.set(key, siblings);
    return siblings;
  }

  /**
   * Whether `node` belongs to the sibling group anchored at `original`.
   * Requires the same kind and the same structural parent; reply runs need
   * nothing more (same-parent runs are regenerate siblings), input nodes must
   * additionally be forkOf-linked to the original (edit versions).
   * @param node - The candidate node.
   * @param original - The group's anchor node.
   * @returns True if `node` is a sibling of `original`.
   */
  private _isSiblingOf(node: ConversationNode<TProjection>, original: ConversationNode<TProjection>): boolean {
    if (node.kind !== original.kind) return false;
    if (node.parentCodecMessageId !== original.parentCodecMessageId) return false;
    // Same-parent reply runs are regenerate siblings — no fork-of needed.
    if (node.kind === 'run') return true;
    // Input nodes: must be forkOf-linked to the original (edit versions).
    const originalKey = nodeKey(original);
    if (nodeKey(node) === originalKey) return true;
    let current: ConversationNode<TProjection> = node;
    const visited = new Set<string>([nodeKey(current)]);
    while (current.kind === 'input' && current.forkOf !== undefined) {
      if (current.forkOf === originalKey) return true;
      if (visited.has(current.forkOf)) break;
      const target = this._nodeIndex.get(current.forkOf);
      if (!target) break;
      current = target.node;
      visited.add(nodeKey(current));
    }
    return false;
  }

  /**
   * Get the "group root" key for a sibling group — the stable key the
   * selection map is keyed by. For an input node (edit versions) that is the
   * earliest fork-of ancestor; for a reply run (regenerate group) it is the
   * oldest same-parent run (the original reply).
   * @param key - Any node key in the sibling group.
   * @returns The group root's key.
   */
  getGroupRoot(key: string): string {
    const entry = this._nodeIndex.get(key);
    if (!entry) return key;

    if (entry.node.kind === 'input') {
      let current = entry.node;
      const visited = new Set<string>([nodeKey(current)]);
      while (current.forkOf !== undefined) {
        if (visited.has(current.forkOf)) break;
        const forkTarget = this._nodeIndex.get(current.forkOf);
        if (
          forkTarget?.node.kind !== 'input' ||
          forkTarget.node.parentCodecMessageId !== current.parentCodecMessageId
        ) {
          break;
        }
        current = forkTarget.node;
        visited.add(nodeKey(current));
      }
      return nodeKey(current);
    }

    // Reply run: the oldest same-parent run is the original reply.
    const group = this._getSiblingGroup(key);
    const root = group[0]?.node;
    return root ? nodeKey(root) : key;
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  /**
   * Walk the visible node chain along the selected branches, kind-blind. An
   * input node and a reply run reach each other through the same
   * parent-membership check, so seed-only user→user chains and the
   * input→reply→input weave both resolve here. Sibling groups (edit versions /
   * regenerate runs) collapse to the selected member.
   * @param selections - Per-group selected member key, keyed by group root.
   * @returns The visible nodes (both kinds) in chronological order.
   */
  visibleNodes(selections: Map<string, string> = new Map<string, string>()): ConversationNode<TProjection>[] {
    this._logger.trace('DefaultTree.visibleNodes();');
    const result: ConversationNode<TProjection>[] = [];
    const currentPath = new Set<string>();
    const resolvedGroups = new Map<string, string>(); // groupRootKey -> selected key

    for (const internal of this._sortedRuns) {
      const node = internal.node;
      const key = nodeKey(node);

      // Step 1: Parent reachability (kind-blind — the parent may be an input
      // node or a reply run; resolve its key and check the active path).
      const parentKey = this._parentKeyOf(node);
      if (parentKey !== undefined && !currentPath.has(parentKey)) {
        continue;
      }

      // Step 2: Sibling selection.
      const group = this._getSiblingGroup(key);
      if (group.length > 1) {
        const groupRootKey = this.getGroupRoot(key);
        let selectedKey = resolvedGroups.get(groupRootKey);
        if (selectedKey === undefined) {
          const preferredKey = selections.get(groupRootKey);
          if (preferredKey !== undefined && group.some((n) => nodeKey(n.node) === preferredKey)) {
            selectedKey = preferredKey;
          } else {
            const latest = group.at(-1);
            if (!latest) break; // unreachable: group.length > 1
            selectedKey = nodeKey(latest.node);
          }
          resolvedGroups.set(groupRootKey, selectedKey);
        }
        if (key !== selectedKey) {
          continue;
        }
      }

      currentPath.add(key);
      result.push(node);
    }

    return result;
  }

  getRunNode(runId: string): RunNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getRunNode();', { runId });
    const node = this._nodeIndex.get(runId)?.node;
    return node?.kind === 'run' ? node : undefined;
  }

  getNodeByCodecMessageId(codecMessageId: string): ConversationNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getNodeByCodecMessageId();', { codecMessageId });
    const key = this._codecMessageIdToNodeKey.get(codecMessageId);
    return key === undefined ? undefined : this._nodeIndex.get(key)?.node;
  }

  getReplyRuns(inputCodecMessageId: string): RunNode<TProjection>[] {
    const runIds = this._replyRunsByInput.get(inputCodecMessageId);
    if (!runIds) return [];
    const result: RunNode<TProjection>[] = [];
    for (const runId of runIds) {
      const node = this._nodeIndex.get(runId)?.node;
      if (node?.kind === 'run') result.push(node);
    }
    return result;
  }

  getSiblingNodes(key: string): ConversationNode<TProjection>[] {
    this._logger.trace('DefaultTree.getSiblingNodes();', { key });
    return this._getSiblingGroup(key).map((n) => n.node);
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  applyMessage(
    events: { inputs: TInput[]; outputs: TOutput[] },
    headers: Record<string, string>,
    serial?: string,
  ): void {
    const wireRunId = headers[HEADER_RUN_ID];
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    // The triggering input's codec-message-id, echoed by the agent on its
    // outputs. Surfaced on the `output` event as the stream's causal routing
    // key. Absent on optimistic local folds (no wire echo yet).
    const inputCodecMessageId = headers[HEADER_INPUT_CODEC_MESSAGE_ID];

    // Classify: with NO run-id, a user message carrying a codec-message-id and
    // at least one input event forms an INPUT node keyed by that
    // codec-message-id — the client owns it; the agent mints the reply run-id
    // separately. Everything else needs a run-id to route to a reply run.
    // Capturing the id (not a boolean) narrows it to `string` for the input path.
    const inputNodeCodecMessageId =
      wireRunId === undefined &&
      codecMessageId !== undefined &&
      headers[HEADER_ROLE] === 'user' &&
      events.inputs.length > 0
        ? codecMessageId
        : undefined;

    if (wireRunId === undefined && inputNodeCodecMessageId === undefined) {
      this._logger.warn('Tree.applyMessage(); message has no run-id and is not a user input; skipping');
      return;
    }

    // Fold inputs first, then outputs, preserving wire order.
    const all: (TInput | TOutput)[] = [...events.inputs, ...events.outputs];

    // Wire-only metadata-carrier messages (e.g. `ait-regenerate`) decode to
    // zero events and don't need a node at the tree level — the eventual reply
    // run is created later by run-start, and any regenerate / parent
    // information the wire carried is reread from the run-start headers.
    // Skipping here avoids a phantom node that would inflate sibling counts.
    const existingKey = inputNodeCodecMessageId ?? wireRunId;
    if (all.length === 0 && existingKey !== undefined && !this._nodeIndex.has(existingKey)) {
      return;
    }

    // `update` is the structural channel: emit it only when this apply
    // actually changes the tree shape (new node, startSerial promotion).
    // Content-only folds (streaming chunks into an existing node) flow through
    // `output` instead, so they leave `structuralVersion` untouched.
    const structuralBefore = this._structuralVersion;

    if (inputNodeCodecMessageId !== undefined) {
      this._applyInputMessage(inputNodeCodecMessageId, headers, serial, all);
    } else if (wireRunId !== undefined) {
      this._applyRunMessage(wireRunId, codecMessageId, headers, serial, all, inputCodecMessageId, events.outputs);
    }

    if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
  }

  /**
   * Apply a run-less user input wire: create (or promote the serial of) the
   * input node keyed by its codec-message-id, fold the input events into its
   * own projection, and emit an `output` event (with empty outputs — input
   * folds carry none) so the View observes the optimistic insert.
   * @param codecMessageId - The input node's codec-message-id (its primary key).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for an optimistic insert.
   * @param all - The decoded input events to fold, in wire order.
   */
  private _applyInputMessage(
    codecMessageId: string,
    headers: Record<string, string>,
    serial: string | undefined,
    all: (TInput | TOutput)[],
  ): void {
    let entry = this._nodeIndex.get(codecMessageId);
    if (!entry) {
      entry = this._createInputNodeFromHeaders(codecMessageId, headers, serial);
      this._nodeIndex.set(codecMessageId, entry);
      this._codecMessageIdToNodeKey.set(codecMessageId, codecMessageId);
      this._addToParentIndex(entry.node.parentCodecMessageId, codecMessageId);
      this._insertSortedRun(entry);
      this._structuralVersion++;
      this._logger.debug('Tree.applyMessage(); created input node', { codecMessageId });
    } else if (entry.node.kind === 'input' && serial && !entry.node.serial) {
      // Promote optimistic serial when the relay/echo arrives.
      this._logger.debug('Tree.applyMessage(); promoting input serial', { codecMessageId, serial });
      entry.node.serial = serial;
      this._removeSortedRun(entry);
      this._insertSortedRun(entry);
      this._structuralVersion++;
    }

    for (const event of all) {
      try {
        entry.node.projection = this._codec.fold(entry.node.projection, event, {
          serial: serial ?? '',
          messageId: codecMessageId,
        });
      } catch (error) {
        this._logger.error('Tree.applyMessage(); input fold threw', { codecMessageId, err: error });
      }
    }

    // An input node owns no agent outputs; the event still fires (empty
    // outputs) so consumers observe the projection change. It has no run-id —
    // the causal routing key is the input's own codec-message-id.
    this._emitter.emit('output', {
      runId: undefined,
      inputCodecMessageId: codecMessageId,
      codecMessageId,
      serial,
      events: [],
    });
  }

  /**
   * Apply a reply-run wire (assistant output, continuation tool-resolution, or
   * a fresh run keyed by the agent-minted run-id): create or reconcile the run
   * node, fold its events, maintain the codec-message-id and reply→input
   * indices, and emit the `output` event.
   * @param wireRunId - The run-id from the inbound wire (the node's primary key).
   * @param codecMessageId - The wire's codec-message-id, or undefined.
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for an optimistic insert.
   * @param all - The decoded events to fold (inputs then outputs), in wire order.
   * @param inputCodecMessageId - The triggering input's codec-message-id (the agent's echo), for the `output` event.
   * @param outputs - The decoded agent outputs, surfaced on the `output` event.
   */
  private _applyRunMessage(
    wireRunId: string,
    codecMessageId: string | undefined,
    headers: Record<string, string>,
    serial: string | undefined,
    all: (TInput | TOutput)[],
    inputCodecMessageId: string | undefined,
    outputs: TOutput[],
  ): void {
    let run = this._nodeIndex.get(wireRunId);

    // Reconcile an optimistic insert with its serial-bearing echo by
    // codec-message-id rather than the wire run-id (kept for assistant content
    // that pins a codec-message-id before its run-id is indexed).
    if (!run && codecMessageId !== undefined) {
      const indexedKey = this._codecMessageIdToNodeKey.get(codecMessageId);
      const indexed = indexedKey === undefined ? undefined : this._nodeIndex.get(indexedKey);
      if (indexed?.node.kind === 'run' && indexed.node.startSerial === undefined) run = indexed;
    }

    if (!run) {
      run = this._createRunFromHeaders(wireRunId, headers, serial);
      this._nodeIndex.set(wireRunId, run);
      this._addToParentIndex(run.node.parentCodecMessageId, wireRunId);
      this._indexReplyRun(run.node, wireRunId);
      this._insertSortedRun(run);
      this._structuralVersion++;
      this._logger.debug('Tree.applyMessage(); created new Run', { runId: wireRunId });
    } else if (serial && run.node.kind === 'run' && !run.node.startSerial) {
      // Promote optimistic startSerial when the relay/echo arrives.
      this._logger.debug('Tree.applyMessage(); promoting startSerial', { runId: wireRunId, serial });
      run.node.startSerial = serial;
      this._removeSortedRun(run);
      this._insertSortedRun(run);
      this._structuralVersion++;
    }

    // Index the codec-message-id against the node that actually owns it.
    const ownerKey = nodeKey(run.node);
    if (codecMessageId) this._codecMessageIdToNodeKey.set(codecMessageId, ownerKey);

    for (const event of all) {
      try {
        run.node.projection = this._codec.fold(run.node.projection, event, {
          serial: serial ?? '',
          messageId: codecMessageId,
        });
      } catch (error) {
        this._logger.error('Tree.applyMessage(); fold threw', { runId: ownerKey, err: error });
      }
    }

    this._emitter.emit('output', { runId: ownerKey, inputCodecMessageId, codecMessageId, serial, events: outputs });
  }

  /**
   * Record a reply run against its input-node parent (the reverse edge powering
   * `getReplyRuns` and regenerate sibling grouping). A reply run's
   * `parentCodecMessageId` is its input node's codec-message-id (the master
   * invariant), so no resolution is needed.
   * @param node - The reply run node.
   * @param runId - The run's id.
   */
  private _indexReplyRun(node: ConversationNode<TProjection>, runId: string): void {
    if (node.parentCodecMessageId === undefined) return;
    let set = this._replyRunsByInput.get(node.parentCodecMessageId);
    if (!set) {
      set = new Set();
      this._replyRunsByInput.set(node.parentCodecMessageId, set);
    }
    set.add(runId);
  }

  applyRunLifecycle(event: RunLifecycleEvent): void {
    this._logger.trace('DefaultTree.applyRunLifecycle();', { type: event.type, runId: event.runId });
    // Structural channel: emit `update` only when the lifecycle event changes
    // the tree shape (a new Run, startSerial promotion, or structural-metadata
    // backfill on run-start). A run-end only mutates status/endSerial on an
    // existing node — content, not structure — so it emits no `update`.
    const structuralBefore = this._structuralVersion;
    if (event.type === 'start') {
      const existing = this._nodeIndex.get(event.runId);
      if (existing?.node.kind === 'run') {
        const node = existing.node;
        if (node.status !== 'active') {
          node.status = 'active';
        }
        if (event.serial && !node.startSerial) {
          node.startSerial = event.serial;
          this._removeSortedRun(existing);
          this._insertSortedRun(existing);
          this._structuralVersion++;
        }
        // Backfill structural metadata if the Run was created from an
        // assistant wire that arrived before run-start (history pagination
        // boundary or out-of-order delivery). The run-start lifecycle event is
        // the canonical source for parent/forkOf/regenerates; only fill in
        // fields the wire didn't already populate. A run-start is always a
        // first start now (continuations re-enter via `ai-run-resume`, which
        // carries no structural metadata), so it is unconditionally
        // authoritative here. `parent` is the run's STRUCTURAL parent (its
        // input node) — reachability and the reply→input edge read it; the
        // run→run `parentRunId` derivation is gone (it was order-dependent).
        if (node.parentCodecMessageId === undefined && event.parent !== undefined) {
          node.parentCodecMessageId = event.parent;
          this._removeFromParentIndex(undefined, event.runId);
          this._addToParentIndex(node.parentCodecMessageId, event.runId);
          this._indexReplyRun(node, event.runId);
          this._structuralVersion++;
        }
        if (node.forkOf === undefined && event.forkOf !== undefined) {
          const forkOfKey = this._codecMessageIdToNodeKey.get(event.forkOf);
          if (forkOfKey !== undefined && forkOfKey !== event.runId) {
            node.forkOf = forkOfKey;
            this._structuralVersion++;
          }
        }
        if (node.regeneratesCodecMessageId === undefined && event.regenerates !== undefined) {
          node.regeneratesCodecMessageId = event.regenerates;
          this._indexRegenerate(event.runId, event.regenerates);
          this._structuralVersion++;
        }
        // Adopt the agent-minted invocation-id onto the optimistic node. The
        // client no longer mints it, so a node created from an optimistic
        // insert (or an assistant wire that arrived before run-start) carries
        // an empty id until the agent's run-start delivers it. Metadata, not
        // structure — consumers re-read it on the `run` emit below, so no
        // structural-version bump.
        if (node.invocationId === '' && event.invocationId !== '') {
          node.invocationId = event.invocationId;
        }
      } else if (!existing) {
        const run = this._createRunFromLifecycle(event);
        this._nodeIndex.set(event.runId, run);
        this._addToParentIndex(run.node.parentCodecMessageId, event.runId);
        this._indexReplyRun(run.node, event.runId);
        this._insertSortedRun(run);
        this._structuralVersion++;
      }
      this._emitter.emit('run', event);
      if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
      return;
    }

    if (event.type === 'suspend') {
      // A suspend pauses the run without ending it: mark the node 'suspended'
      // and record the serial it paused at, but keep the Run live so a resume
      // under the same runId resumes it. Status/endSerial are content, not
      // structure, so no 'update' is emitted (mirrors run-end).
      const run = this._nodeIndex.get(event.runId);
      if (run?.node.kind === 'run') {
        run.node.status = 'suspended';
        run.node.endSerial = event.serial;
      }
      this._emitter.emit('run', event);
      return;
    }

    if (event.type === 'resume') {
      // A resume re-enters an already-started run: flip a suspended run back
      // to 'active'. Pure re-entry — it carries no parent/forkOf and does not
      // promote startSerial (the original run-start owns the run's structure).
      // Only a suspended run resumes: a no-op when the run isn't known (e.g. a
      // resume replayed from a newer history page before its run-start) and a
      // no-op for an already-active or terminal (complete/cancelled/error) run —
      // a stray resume must never resurrect a run that has ended. Status is
      // content, not structure, so no 'update' is emitted (mirrors
      // run-end / run-suspend).
      const run = this._nodeIndex.get(event.runId);
      if (run?.node.kind === 'run' && run.node.status === 'suspended') {
        run.node.status = 'active';
      }
      this._emitter.emit('run', event);
      return;
    }

    // run-end (event.type === 'end')
    const run = this._nodeIndex.get(event.runId);
    if (run?.node.kind === 'run') {
      run.node.status = event.reason;
      run.node.endSerial = event.serial;
    }
    this._emitter.emit('run', event);
    if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
  }

  deleteByCodecMessageId(codecMessageId: string): void {
    const key = this._codecMessageIdToNodeKey.get(codecMessageId);
    if (key !== undefined) this.delete(key);
  }

  delete(key: string): void {
    const entry = this._nodeIndex.get(key);
    if (!entry) return;

    this._logger.debug('Tree.delete();', { key });

    this._removeFromParentIndex(entry.node.parentCodecMessageId, key);
    this._removeSortedRun(entry);
    this._nodeIndex.delete(key);
    if (entry.node.kind === 'run') {
      // Drop the reply→input reverse edge.
      if (entry.node.parentCodecMessageId !== undefined) {
        const replies = this._replyRunsByInput.get(entry.node.parentCodecMessageId);
        if (replies) {
          replies.delete(key);
          if (replies.size === 0) this._replyRunsByInput.delete(entry.node.parentCodecMessageId);
        }
      }
      if (entry.node.regeneratesCodecMessageId !== undefined) {
        const set = this._regenerateByMsgId.get(entry.node.regeneratesCodecMessageId);
        if (set) {
          set.delete(key);
          if (set.size === 0) this._regenerateByMsgId.delete(entry.node.regeneratesCodecMessageId);
        }
      }
    }
    // codecMessageIdToRunId entries pointing at this run linger but are harmless;
    // they'll be overwritten if the Run is re-created and remain dangling
    // otherwise. Cleanup not worth the index walk.

    this._structuralVersion++;
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Build a fresh RunNode from a wire message's headers. Used when an
   * inbound message arrives before any run-start event for its runId.
   * @param runId - The run-id from the inbound wire.
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _createRunFromHeaders(
    runId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): InternalNode<TProjection> {
    const parentCodecMessageId = headers[HEADER_PARENT];
    const forkOfMsgId = headers[HEADER_FORK_OF];
    // forkOf is resolved to the fork target's node key (an input node's
    // codec-message-id, or a run's id) — the same space `_isSiblingOf` walks.
    const forkOf = forkOfMsgId ? this._codecMessageIdToNodeKey.get(forkOfMsgId) : undefined;
    const regeneratesCodecMessageId = headers[HEADER_MSG_REGENERATE];

    const node: RunNode<TProjection> = {
      kind: 'run',
      runId,
      // Reachability uses parentCodecMessageId (structural); the run→run
      // parentRunId derivation is retired in the two-node model.
      parentRunId: undefined,
      parentCodecMessageId,
      forkOf,
      regeneratesCodecMessageId,
      clientId: headers[HEADER_RUN_CLIENT_ID] ?? '',
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      status: 'active',
      projection: this._codec.init(),
      startSerial: serial,
      endSerial: undefined,
    };

    if (regeneratesCodecMessageId !== undefined) {
      this._indexRegenerate(runId, regeneratesCodecMessageId);
    }

    return { node, insertSeq: this._seqCounter++ };
  }

  /**
   * Build a fresh InputNode from a run-less user input wire's headers.
   * @param codecMessageId - The input's codec-message-id (its primary key).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   * @returns A newly-allocated internal input node ready for insertion.
   */
  private _createInputNodeFromHeaders(
    codecMessageId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): InternalNode<TProjection> {
    const forkOfMsgId = headers[HEADER_FORK_OF];
    const node: InputNode<TProjection> = {
      kind: 'input',
      codecMessageId,
      parentCodecMessageId: headers[HEADER_PARENT],
      // An edit's fork-of names the original prompt's codec-message-id, which
      // IS that input node's key — no resolution needed.
      forkOf: forkOfMsgId,
      projection: this._codec.init(),
      serial,
    };
    return { node, insertSeq: this._seqCounter++ };
  }

  /**
   * Build a fresh RunNode from a run-start lifecycle event. Used when a
   * run-start event arrives before any message for its runId.
   * @param event - The run-start lifecycle event from the agent, including
   *   its channel serial.
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _createRunFromLifecycle(event: RunLifecycleEvent & { type: 'start' }): InternalNode<TProjection> {
    const parentCodecMessageId = event.parent;
    const forkOfMsgId = event.forkOf;
    const forkOf = forkOfMsgId ? this._codecMessageIdToNodeKey.get(forkOfMsgId) : undefined;
    const regeneratesCodecMessageId = event.regenerates;

    const node: RunNode<TProjection> = {
      kind: 'run',
      runId: event.runId,
      // Reachability uses parentCodecMessageId; parentRunId is retired.
      parentRunId: undefined,
      parentCodecMessageId,
      forkOf,
      regeneratesCodecMessageId,
      clientId: event.clientId,
      invocationId: event.invocationId,
      status: 'active',
      projection: this._codec.init(),
      startSerial: event.serial,
      endSerial: undefined,
    };

    if (regeneratesCodecMessageId !== undefined) {
      this._indexRegenerate(event.runId, regeneratesCodecMessageId);
    }

    return { node, insertSeq: this._seqCounter++ };
  }

  /**
   * Track a Run as a regenerator of the given codec-message-id. Maintained as a
   * forward map (`regenerated codec-message-id -> set of runIds that regenerate it`)
   * so the View can resolve regenerate sibling groups in one lookup.
   * @param runId - The runId of the regenerating Run.
   * @param regeneratesCodecMessageId - The codec-message-id the Run regenerates.
   */
  private _indexRegenerate(runId: string, regeneratesCodecMessageId: string): void {
    let set = this._regenerateByMsgId.get(regeneratesCodecMessageId);
    if (!set) {
      set = new Set();
      this._regenerateByMsgId.set(regeneratesCodecMessageId, set);
    }
    set.add(runId);
  }

  /**
   * Get all Runs (including the Run that owns the codec-message-id) that participate
   * in the regenerate sibling group rooted at `codecMessageId`. Returns an empty
   * array when neither the owner Run nor any regenerator is observed.
   * @param codecMessageId - The codec-message-id that anchors the group (the "original" message).
   * @returns Members ordered chronologically by startSerial — owner first
   *   (it has the lowest serial), regenerators after.
   */
  getRegenerateGroupByMsgId(codecMessageId: string): RunNode<TProjection>[] {
    const result: RunNode<TProjection>[] = [];

    const ownerRunId = this._codecMessageIdToNodeKey.get(codecMessageId);
    if (ownerRunId) {
      const owner = this._nodeIndex.get(ownerRunId);
      if (owner?.node.kind === 'run') result.push(owner.node);
    }

    const regenIds = this._regenerateByMsgId.get(codecMessageId);
    if (regenIds) {
      for (const id of regenIds) {
        const entry = this._nodeIndex.get(id);
        if (entry?.node.kind === 'run') result.push(entry.node);
      }
    }

    result.sort((a, b) => {
      const ai = this._nodeIndex.get(a.runId)?.insertSeq ?? 0;
      const bi = this._nodeIndex.get(b.runId)?.insertSeq ?? 0;
      const sa = a.startSerial;
      const sb = b.startSerial;
      if (sa === undefined && sb === undefined) return ai - bi;
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return ai - bi;
    });

    return result;
  }

  /**
   * Resolve the regenerate sibling group containing `runId`.
   *
   * A Run participates in a regenerate group if either:
   * - the Run regenerates a known codec-message-id (the Run is a regenerator), or
   * - the Run owns a codec-message-id that has been regenerated by another Run.
   *
   * The group's anchor is the "original" codec-message-id — the one being
   * regenerated. The Run that owns that codec-message-id is the group's root.
   * @param runId - The runId to look up.
   * @returns The group's anchor codec-message-id and ordered members, or undefined
   *   if `runId` is not in any regenerate group.
   */
  getRegenerateGroup(runId: string):
    | {
        /** The codec-message-id this group regenerates — anchor of the group. */
        anchorCodecMessageId: string;
        /** Ordered group members (owner first, then regenerators by serial). */
        runs: RunNode<TProjection>[];
      }
    | undefined {
    const entry = this._nodeIndex.get(runId);
    if (!entry) return undefined;

    // Case 1: this Run regenerates a known codec-message-id.
    const regenTarget = entry.node.kind === 'run' ? entry.node.regeneratesCodecMessageId : undefined;
    if (regenTarget !== undefined) {
      const runs = this.getRegenerateGroupByMsgId(regenTarget);
      return runs.length > 0 ? { anchorCodecMessageId: regenTarget, runs } : undefined;
    }

    // Case 2: this Run owns a codec-message-id that has been regenerated. Iterate
    // the regenerate index and match ownership via `_codecMessageIdToNodeKey`. The
    // index is keyed by regenerated codec-message-id, so the search is bounded by
    // the number of distinct regen anchors in the tree (small in practice).
    for (const [anchorCodecMessageId, regenRunIds] of this._regenerateByMsgId) {
      if (regenRunIds.size === 0) continue;
      const ownerRunId = this._codecMessageIdToNodeKey.get(anchorCodecMessageId);
      if (ownerRunId !== runId) continue;
      const runs = this.getRegenerateGroupByMsgId(anchorCodecMessageId);
      if (runs.length > 1) return { anchorCodecMessageId, runs };
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // Spec: AIT-CT8b, AIT-CT8e
  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(event: 'output', handler: (event: OutputEvent<TOutput>) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run' | 'output',
    handler:
      | (() => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((event: RunLifecycleEvent) => void)
      | ((event: OutputEvent<TOutput>) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: TreeEventsMap<TOutput>[keyof TreeEventsMap<TOutput>]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  /**
   * Forward a raw Ably message event to tree subscribers.
   * @param msg - The raw Ably message to emit.
   */
  emitAblyMessage(msg: Ably.InboundMessage): void {
    this._logger.trace('DefaultTree.emitAblyMessage();');
    this._emitter.emit('ably-message', msg);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Tree that materializes branching conversation history from a flat
 * oplog of Ably messages as a two-node-per-turn forest (input node + reply run).
 * @param codec - Codec used to fold inbound events into per-Run projections.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link DefaultTree} instance. The session uses DefaultTree
 *   directly for internal methods (applyMessage, applyRunLifecycle,
 *   emitAblyMessage). Public consumers see the narrower {@link Tree} interface.
 */
export const createTree = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection>(
  codec: Reducer<TInput | TOutput, TProjection>,
  logger: Logger,
): DefaultTree<TInput, TOutput, TProjection> => new DefaultTree<TInput, TOutput, TProjection>(codec, logger);
