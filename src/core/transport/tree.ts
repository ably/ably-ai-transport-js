/**
 * Tree — materializes a branching conversation from a flat
 * oplog of Ably messages using serial-first ordering.
 *
 * Serial order (the total order assigned by Ably) is the primary mechanism
 * for linear message sequences. `x-ably-parent` and `x-ably-fork-of` headers
 * are only structurally meaningful at branch points — where the user is
 * interacting with a visible message and the client always has it loaded.
 *
 * `upsert()` is the sole mutation method. Messages can arrive in any order
 * (live subscription, history pages, seed data) and the tree produces the
 * correct `flattenNodes()` output once all messages are present.
 *
 * The tree owns conversation state. `flattenNodes()` returns the linear node
 * list for the currently selected branches — this is what the transport's
 * `getMessages()` delegates to.
 */

import type * as Ably from 'ably';

import {
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../constants.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import type { MessageNode, RunLifecycleEvent, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

interface InternalNode<TMessage> {
  node: MessageNode<TMessage>;
  /** Insertion sequence — tiebreaker for null-serial messages. */
  insertSeq: number;
}

// ---------------------------------------------------------------------------
// Internal interface — extended surface consumed by View
// ---------------------------------------------------------------------------

/** Internal tree surface used by View — not part of the public Tree API. */
export interface TreeInternal<TMessage> extends Tree<TMessage> {
  /**
   * Monotonic counter that increments on structural changes (node insert,
   * delete, serial promotion/reorder) but NOT on content-only updates
   * (existing node's message replaced). Allows the View to skip full
   * tree walks when only message content changed.
   */
  readonly structuralVersion: number;

  /**
   * Flatten the tree along selected branches into a linear node list.
   * The `selections` map provides the selected sibling's codecMessageId at each
   * fork point, keyed by group root codecMessageId. Fork points not present in
   * the map default to the latest sibling. If a selectedCodecMessageId is not
   * found in the sibling group (stale/deleted), falls back to latest.
   */
  flattenNodes(selections: Map<string, string>): MessageNode<TMessage>[];

  /**
   * Get the "group root" codecMessageId for a sibling group — the original message
   * that all forks in the group trace back to.
   */
  getGroupRoot(codecMessageId: string): string;

  /**
   * Get the sibling group that `codecMessageId` belongs to, as full MessageNode objects.
   * Allows callers to resolve index ↔ codecMessageId without losing identity.
   */
  getSiblingNodes(codecMessageId: string): MessageNode<TMessage>[];

  /** Forward a raw Ably message event to tree subscribers. */
  emitAblyMessage(msg: Ably.InboundMessage): void;
  /** Forward a run lifecycle event to tree subscribers. */
  emitRun(event: RunLifecycleEvent): void;
  /** Register an active run. */
  trackRun(runId: string, clientId: string): void;
  /** Unregister an active run. */
  untrackRun(runId: string): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** EventEmitter events map for the tree. */
interface TreeEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
  'invocation-winner-changed': { runId: string; invocationId: string; serial: string };
}

// Spec: AIT-CT13
export class DefaultTree<TMessage> implements TreeInternal<TMessage> {
  /** All nodes indexed by codecMessageId (x-ably-codec-message-id). */
  private readonly _nodeIndex = new Map<string, InternalNode<TMessage>>();

  /**
   * All nodes sorted by serial (lexicographic). Null-serial messages
   * (optimistic inserts, seed data) sort after all serial-bearing messages,
   * ordered among themselves by insertion sequence.
   */
  private readonly _sortedList: InternalNode<TMessage>[] = [];

  /**
   * Parent index: parentId to set of child codecMessageIds.
   * Nodes with no parent are indexed under the key `null`.
   */
  private readonly _parentIndex = new Map<string | undefined, Set<string>>();

  private readonly _emitter: EventEmitter<TreeEventsMap>;
  private readonly _logger: Logger;

  /** Active runs: runId → clientId. */
  private readonly _runClientIds = new Map<string, string>();

  /**
   * Winning invocation per run-id: runId → { invocationId, serial }.
   * Updated only when a user-message with a non-null serial is upserted.
   * The entry replaces an existing one only if the new serial is higher.
   */
  private readonly _winningInvocations = new Map<string, { invocationId: string; serial: string }>();

  /** Monotonically increasing counter for insertion sequence. */
  private _seqCounter = 0;

  /** Incremented on structural changes; unchanged on content-only updates. */
  private _structuralVersion = 0;

  get structuralVersion(): number {
    return this._structuralVersion;
  }

  constructor(logger: Logger) {
    this._logger = logger;
    this._emitter = new EventEmitter<TreeEventsMap>(logger);
  }

  // -------------------------------------------------------------------------
  // Sorted list maintenance
  // -------------------------------------------------------------------------

  /**
   * Compare two nodes for sorted list ordering.
   * Serial-bearing nodes sort by serial (lexicographic).
   * Null-serial nodes sort after all serial-bearing nodes.
   * Among null-serial nodes, sort by insertion sequence.
   * @param a - First node to compare.
   * @param b - Second node to compare.
   * @returns Negative if a sorts before b, positive if after, zero if equal.
   */
  // Spec: AIT-CT13a
  private _compareNodes(a: InternalNode<TMessage>, b: InternalNode<TMessage>): number {
    const sa = a.node.serial;
    const sb = b.node.serial;
    if (sa === undefined && sb === undefined) return a.insertSeq - b.insertSeq;
    if (sa === undefined) return 1; // a sorts after serial-bearing b
    if (sb === undefined) return -1; // b sorts after serial-bearing a
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.insertSeq - b.insertSeq; // same serial: preserve insertion order
  }

  /**
   * Insert a node into sortedList at the correct position via binary search.
   * @param internal - The node to insert.
   */
  private _insertSorted(internal: InternalNode<TMessage>): void {
    const serial = internal.node.serial;

    // Fast path: null-serial always appends to end (among other null-serials)
    if (serial === undefined) {
      this._sortedList.push(internal);
      return;
    }

    // Binary search for insertion point among serial-bearing nodes.
    let lo = 0;
    let hi = this._sortedList.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midNode = this._sortedList[mid];
      if (!midNode) break; // unreachable: mid is always in bounds
      if (this._compareNodes(midNode, internal) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this._sortedList.splice(lo, 0, internal);
  }

  /**
   * Remove a node from sortedList.
   * @param internal - The node to remove.
   */
  private _removeSorted(internal: InternalNode<TMessage>): void {
    const idx = this._sortedList.indexOf(internal);
    if (idx !== -1) this._sortedList.splice(idx, 1);
  }

  // -------------------------------------------------------------------------
  // Parent index maintenance
  // -------------------------------------------------------------------------

  private _addToParentIndex(parentId: string | undefined, codecMessageId: string): void {
    let set = this._parentIndex.get(parentId);
    if (!set) {
      set = new Set();
      this._parentIndex.set(parentId, set);
    }
    set.add(codecMessageId);
  }

  private _removeFromParentIndex(parentId: string | undefined, codecMessageId: string): void {
    const set = this._parentIndex.get(parentId);
    if (set) {
      set.delete(codecMessageId);
      if (set.size === 0) this._parentIndex.delete(parentId);
    }
  }

  // -------------------------------------------------------------------------
  // Sibling grouping
  // -------------------------------------------------------------------------

  /**
   * Get the sibling group that `codecMessageId` belongs to.
   *
   * A sibling group is: the original message + all messages whose `forkOf`
   * points to the original (or transitively to a sibling). We find the
   * group root by following `forkOf` chains to the earliest ancestor that
   * has no `forkOf` (or whose `forkOf` target doesn't share the same parent).
   * @param codecMessageId - The codec-message-id to look up the sibling group for.
   * @returns The ordered list of sibling nodes.
   */
  // Spec: AIT-CT13b
  private _getSiblingGroup(codecMessageId: string): MessageNode<TMessage>[] {
    const entry = this._nodeIndex.get(codecMessageId);
    if (!entry) return [];

    // Find the "original" — the message at the root of the fork chain
    // that shares the same parentId. Guard against cycles in forkOf chains.
    let original = entry.node;
    const visitedGroup = new Set<string>([original.codecMessageId]);
    while (original.forkOf) {
      if (visitedGroup.has(original.forkOf)) break; // cycle guard
      const forkTarget = this._nodeIndex.get(original.forkOf);
      if (!forkTarget || forkTarget.node.parentId !== original.parentId) break;
      original = forkTarget.node;
      visitedGroup.add(original.codecMessageId);
    }

    // Collect all siblings: nodes with the same parentId that either
    // ARE the original, or have a forkOf chain leading to the original.
    const parentId = original.parentId;
    const originalId = original.codecMessageId;
    const siblings: InternalNode<TMessage>[] = [];

    const candidateIds = this._parentIndex.get(parentId);
    if (candidateIds) {
      for (const childId of candidateIds) {
        const childEntry = this._nodeIndex.get(childId);
        if (childEntry && this._isSiblingOf(childEntry.node, originalId)) {
          siblings.push(childEntry);
        }
      }
    }

    // Sort by Ably serial (lexicographic). Messages without a serial
    // (optimistic inserts before server relay) sort after all serial-bearing
    // siblings — they represent the user's most recent action.
    siblings.sort((a, b) => this._compareNodes(a, b));
    return siblings.map((s) => s.node);
  }

  /**
   * Check if `node` belongs to the sibling group rooted at `originalId`.
   * A node is a sibling if it IS the original or its forkOf chain leads
   * to the original (with the same parentId).
   * @param node - The node to check.
   * @param originalId - The group root to match against.
   * @returns True if the node belongs to the sibling group.
   */
  private _isSiblingOf(node: MessageNode<TMessage>, originalId: string): boolean {
    if (node.codecMessageId === originalId) return true;
    let current = node;
    const visited = new Set<string>([current.codecMessageId]);
    while (current.forkOf) {
      if (current.forkOf === originalId) return true;
      if (visited.has(current.forkOf)) break; // cycle guard
      const target = this._nodeIndex.get(current.forkOf);
      if (!target) break;
      current = target.node;
      visited.add(current.codecMessageId);
    }
    return false;
  }

  /**
   * Get the "group root" codecMessageId for a sibling group — the original message
   * that all forks trace back to.
   * @param codecMessageId - Any codec-message-id in the sibling group.
   * @returns The codec-message-id of the group root.
   */
  getGroupRoot(codecMessageId: string): string {
    const entry = this._nodeIndex.get(codecMessageId);
    if (!entry) return codecMessageId;

    let current = entry.node;
    const visited = new Set<string>([current.codecMessageId]);
    while (current.forkOf) {
      if (visited.has(current.forkOf)) break; // cycle guard
      const forkTarget = this._nodeIndex.get(current.forkOf);
      if (!forkTarget || forkTarget.node.parentId !== current.parentId) break;
      current = forkTarget.node;
      visited.add(current.codecMessageId);
    }
    return current.codecMessageId;
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  flattenNodes(selections: Map<string, string>): MessageNode<TMessage>[] {
    this._logger.trace('DefaultTree.flattenNodes();');
    const result: MessageNode<TMessage>[] = [];
    const currentPath = new Set<string>();
    // Track which sibling groups we've already resolved to avoid
    // re-resolving for every member of the group.
    const resolvedGroups = new Map<string, string>(); // groupRootId → selected codecMessageId

    for (const internal of this._sortedList) {
      const node = internal.node;
      const { codecMessageId, parentId } = node;

      // Step 1: Check parent reachability.
      if (parentId !== undefined && !currentPath.has(parentId)) {
        continue;
      }

      // Step 2: Check sibling selection.
      const group = this._getSiblingGroup(codecMessageId);
      if (group.length > 1) {
        const groupRootId = this.getGroupRoot(codecMessageId);
        let selectedId = resolvedGroups.get(groupRootId);
        if (selectedId === undefined) {
          const preferredId = selections.get(groupRootId);
          // Verify the preferred codecMessageId is in the group, otherwise default to latest
          if (preferredId && group.some((n) => n.codecMessageId === preferredId)) {
            selectedId = preferredId;
          } else {
            const latest = group.at(-1);
            if (!latest) break; // unreachable: group.length > 1
            selectedId = latest.codecMessageId;
          }
          resolvedGroups.set(groupRootId, selectedId);
        }
        if (codecMessageId !== selectedId) {
          continue;
        }
      }

      currentPath.add(codecMessageId);
      result.push(node);
    }

    return result;
  }

  getSiblings(codecMessageId: string): TMessage[] {
    this._logger.trace('DefaultTree.getSiblings();', { codecMessageId });
    return this._getSiblingGroup(codecMessageId).map((n) => n.message);
  }

  getSiblingNodes(codecMessageId: string): MessageNode<TMessage>[] {
    return this._getSiblingGroup(codecMessageId);
  }

  hasSiblings(codecMessageId: string): boolean {
    return this._getSiblingGroup(codecMessageId).length > 1;
  }

  getNode(codecMessageId: string): MessageNode<TMessage> | undefined {
    this._logger.trace('DefaultTree.getNode();', { codecMessageId });
    return this._nodeIndex.get(codecMessageId)?.node;
  }

  getHeaders(codecMessageId: string): Record<string, string> | undefined {
    this._logger.trace('DefaultTree.getHeaders();', { codecMessageId });
    return this._nodeIndex.get(codecMessageId)?.node.headers;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  upsert(codecMessageId: string, message: TMessage, headers: Record<string, string>, serial?: string): void {
    const parentId = headers[HEADER_PARENT] ?? undefined;
    const forkOf = headers[HEADER_FORK_OF] ?? undefined;

    const existing = this._nodeIndex.get(codecMessageId);
    if (existing) {
      // Update in place — message content may have changed (e.g. streaming).
      // Only update headers if the new headers are non-empty (prevents
      // streaming updates from erasing canonical headers).
      existing.node.message = message;
      if (Object.keys(headers).length > 0) {
        // Preserve a previously-set `x-ably-role`. Secondary wire
        // contributions to an existing message (e.g. a client-published
        // continuation tool resolution stamped with the prior assistant's
        // codec-message-id) carry `x-ably-role: 'user'`, but the node's role
        // belongs to its original contributor (the agent's assistant
        // stream). Without this carve-out the role flips and downstream
        // consumers (UI rendering, winner rule, etc.) misread the node.
        const previousRole = existing.node.headers[HEADER_ROLE];
        existing.node.headers = { ...headers };
        if (previousRole !== undefined) {
          existing.node.headers[HEADER_ROLE] = previousRole;
        }
      }
      // Spec: AIT-CT13d
      // Promote serial: optimistic (null) → server-assigned on relay.
      if (serial && !existing.node.serial) {
        this._logger.debug('Tree.upsert(); promoting serial', { codecMessageId, serial });
        existing.node.serial = serial;
        // Re-sort: remove from current position, re-insert at correct position.
        this._removeSorted(existing);
        this._insertSorted(existing);
        this._structuralVersion++;
      }
      this._maybeUpdateWinningInvocation(headers, serial);
      this._emitter.emit('update');
      return;
    }

    this._logger.trace('Tree.upsert(); inserting new node', { codecMessageId, parentId, forkOf });

    const node: MessageNode<TMessage> = {
      kind: 'message',
      message,
      codecMessageId,
      parentId,
      forkOf,
      headers: { ...headers },
      serial,
    };

    const internal: InternalNode<TMessage> = { node, insertSeq: this._seqCounter++ };
    this._nodeIndex.set(codecMessageId, internal);
    this._addToParentIndex(parentId, codecMessageId);
    this._insertSorted(internal);
    this._structuralVersion++;
    this._maybeUpdateWinningInvocation(headers, serial);
    this._emitter.emit('update');
  }

  /**
   * Update the per-run winning invocation map on user-message upsert.
   *
   * Defensive rule: within a run-id, the invocation whose user-message has
   * the highest Ably channel serial is canonical. We only consider messages
   * with `role: user` and a non-null serial — optimistic (null-serial)
   * inserts never win, otherwise a fresh-but-unacked retry would prematurely
   * supersede the in-flight invocation. Continuation user-messages
   * (`x-ably-run-continue: 'true'`) are skipped: they publish under the
   * same run-id as the original prompt but represent tool-resolution
   * traffic, not a competing user-prompt. Without this exclusion the
   * continuation's higher serial would supersede the original prompt in
   * materialised history.
   * @param headers - Transport headers from the incoming user message.
   * @param serial - Ably channel serial assigned to the published message.
   */
  private _maybeUpdateWinningInvocation(headers: Record<string, string>, serial: string | undefined): void {
    if (!serial) return;
    if (headers[HEADER_ROLE] !== 'user') return;
    if (headers[HEADER_RUN_CONTINUE] === 'true') return;
    const runId = headers[HEADER_RUN_ID];
    const invocationId = headers[HEADER_INVOCATION_ID];
    if (!runId || !invocationId) return;
    const current = this._winningInvocations.get(runId);
    if (current && current.serial >= serial) return;
    this._logger.debug('Tree._maybeUpdateWinningInvocation(); winner set', {
      runId,
      invocationId,
      serial,
      previous: current?.invocationId,
    });
    this._winningInvocations.set(runId, { invocationId, serial });
    this._emitter.emit('invocation-winner-changed', { runId, invocationId, serial });
  }

  delete(codecMessageId: string): void {
    const entry = this._nodeIndex.get(codecMessageId);
    if (!entry) return;

    this._logger.debug('Tree.delete();', { codecMessageId });

    const { node } = entry;

    // Remove from parent index
    this._removeFromParentIndex(node.parentId, codecMessageId);

    // Remove from sorted list
    this._removeSorted(entry);

    // Remove from primary index
    this._nodeIndex.delete(codecMessageId);

    // Children are NOT deleted — they become unreachable in flattenNodes()
    // because their parent is no longer on the active path.
    this._structuralVersion++;
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // Spec: AIT-CT17
  getActiveRunIds(): Map<string, Set<string>> {
    this._logger.trace('DefaultTree.getActiveRunIds();');
    const result = new Map<string, Set<string>>();
    for (const [runId, clientId] of this._runClientIds) {
      let set = result.get(clientId);
      if (!set) {
        set = new Set<string>();
        result.set(clientId, set);
      }
      set.add(runId);
    }
    return result;
  }

  getWinningInvocation(runId: string): { invocationId: string; serial: string } | undefined {
    const entry = this._winningInvocations.get(runId);
    return entry ? { ...entry } : undefined;
  }

  // Spec: AIT-CT8b, AIT-CT8e
  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(
    event: 'invocation-winner-changed',
    handler: (event: { runId: string; invocationId: string; serial: string }) => void,
  ): () => void;
  on(
    event: 'update' | 'ably-message' | 'run' | 'invocation-winner-changed',
    handler:
      | (() => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((event: RunLifecycleEvent) => void)
      | ((event: { runId: string; invocationId: string; serial: string }) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: TreeEventsMap[keyof TreeEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // -------------------------------------------------------------------------
  // Internal methods (called by the transport, not part of Tree interface)
  // -------------------------------------------------------------------------

  /**
   * Forward a raw Ably message event to tree subscribers.
   * @param msg - The raw Ably message to emit.
   */
  emitAblyMessage(msg: Ably.InboundMessage): void {
    this._logger.trace('DefaultTree.emitAblyMessage();');
    this._emitter.emit('ably-message', msg);
  }

  /**
   * Forward a run lifecycle event to tree subscribers.
   * @param event - The run lifecycle event to emit.
   */
  emitRun(event: RunLifecycleEvent): void {
    this._logger.trace('DefaultTree.emitRun();', { runId: event.runId });
    this._emitter.emit('run', event);
  }

  /**
   * Register an active run.
   * @param runId - The run's unique identifier.
   * @param clientId - The client that owns the run.
   */
  trackRun(runId: string, clientId: string): void {
    this._logger.trace('DefaultTree.trackRun();', { runId, clientId });
    this._runClientIds.set(runId, clientId);
  }

  /**
   * Unregister an active run.
   * @param runId - The run to untrack.
   */
  untrackRun(runId: string): void {
    this._logger.trace('DefaultTree.untrackRun();', { runId });
    this._runClientIds.delete(runId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Tree that materializes branching history from a flat oplog.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link DefaultTree} instance. The session uses DefaultTree
 *   directly for internal methods (emitAblyMessage, emitRun, trackRun, untrackRun).
 *   Public consumers see the narrower {@link Tree} interface.
 */
export const createTree = <TMessage>(logger: Logger): DefaultTree<TMessage> => new DefaultTree(logger);
