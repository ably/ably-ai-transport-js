/**
 * ConversationTree — materializes a branching conversation from a flat
 * oplog of Ably messages using serial-first ordering.
 *
 * Serial order (the total order assigned by Ably) is the primary mechanism
 * for linear message sequences. `x-ably-parent` and `x-ably-fork-of` headers
 * are only structurally meaningful at branch points — where the user is
 * interacting with a visible message and the client always has it loaded.
 *
 * `upsert()` is the sole mutation method. Messages can arrive in any order
 * (live subscription, history pages, seed data) and the tree produces the
 * correct `flatten()` output once all messages are present.
 *
 * The tree owns conversation state. `flatten()` returns the linear message
 * list for the currently selected branches — this is what the transport's
 * `getMessages()` delegates to.
 */

import { HEADER_FORK_OF, HEADER_PARENT } from '../../../constants.js';
import type { Logger } from '../../../logger.js';
import type { ConversationNode, ConversationTree } from './types.js';

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

interface InternalNode<TMessage> {
  node: ConversationNode<TMessage>;
  /** Insertion sequence — tiebreaker for null-serial messages. */
  insertSeq: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT13
class DefaultConversationTree<TMessage> implements ConversationTree<TMessage> {
  /** All nodes indexed by msgId (x-ably-msg-id). */
  private readonly _nodeIndex = new Map<string, InternalNode<TMessage>>();

  /** Secondary index: codec message key to msgId. Bridges UIMessage.id to x-ably-msg-id. */
  private readonly _codecKeyIndex = new Map<string, string>();

  /**
   * All nodes sorted by serial (lexicographic). Null-serial messages
   * (optimistic inserts, seed data) sort after all serial-bearing messages,
   * ordered among themselves by insertion sequence.
   */
  private readonly _sortedList: InternalNode<TMessage>[] = [];

  /**
   * Parent index: parentId to set of child msgIds.
   * Nodes with no parent are indexed under the key `null`.
   */
  private readonly _parentIndex = new Map<string | undefined, Set<string>>();

  /**
   * Selected sibling index at each fork point, keyed by the msgId of
   * the first sibling in the group (the fork target). Default: last.
   */
  private readonly _selections = new Map<string, number>();

  private readonly _getKey: (message: TMessage) => string;
  private readonly _logger: Logger;

  /** Monotonically increasing counter for insertion sequence. */
  private _seqCounter = 0;

  constructor(getKey: (message: TMessage) => string, logger: Logger) {
    this._getKey = getKey;
    this._logger = logger;
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

  private _addToParentIndex(parentId: string | undefined, msgId: string): void {
    let set = this._parentIndex.get(parentId);
    if (!set) {
      set = new Set();
      this._parentIndex.set(parentId, set);
    }
    set.add(msgId);
  }

  private _removeFromParentIndex(parentId: string | undefined, msgId: string): void {
    const set = this._parentIndex.get(parentId);
    if (set) {
      set.delete(msgId);
      if (set.size === 0) this._parentIndex.delete(parentId);
    }
  }

  // -------------------------------------------------------------------------
  // Sibling grouping
  // -------------------------------------------------------------------------

  /**
   * Get the sibling group that `msgId` belongs to.
   *
   * A sibling group is: the original message + all messages whose `forkOf`
   * points to the original (or transitively to a sibling). We find the
   * group root by following `forkOf` chains to the earliest ancestor that
   * has no `forkOf` (or whose `forkOf` target doesn't share the same parent).
   * @param msgId - The msg-id to look up the sibling group for.
   * @returns The ordered list of sibling nodes.
   */
  // Spec: AIT-CT13b
  private _getSiblingGroup(msgId: string): ConversationNode<TMessage>[] {
    const entry = this._nodeIndex.get(msgId);
    if (!entry) return [];

    // Find the "original" — the message at the root of the fork chain
    // that shares the same parentId. Guard against cycles in forkOf chains.
    let original = entry.node;
    const visitedGroup = new Set<string>([original.msgId]);
    while (original.forkOf) {
      if (visitedGroup.has(original.forkOf)) break; // cycle guard
      const forkTarget = this._nodeIndex.get(original.forkOf);
      if (!forkTarget || forkTarget.node.parentId !== original.parentId) break;
      original = forkTarget.node;
      visitedGroup.add(original.msgId);
    }

    // Collect all siblings: nodes with the same parentId that either
    // ARE the original, or have a forkOf chain leading to the original.
    const parentId = original.parentId;
    const originalId = original.msgId;
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
  private _isSiblingOf(node: ConversationNode<TMessage>, originalId: string): boolean {
    if (node.msgId === originalId) return true;
    let current = node;
    const visited = new Set<string>([current.msgId]);
    while (current.forkOf) {
      if (current.forkOf === originalId) return true;
      if (visited.has(current.forkOf)) break; // cycle guard
      const target = this._nodeIndex.get(current.forkOf);
      if (!target) break;
      current = target.node;
      visited.add(current.msgId);
    }
    return false;
  }

  /**
   * Get the "group root" msgId for a sibling group — the original message
   * that all forks trace back to.
   * @param msgId - Any msg-id in the sibling group.
   * @returns The msg-id of the group root.
   */
  private _getGroupRoot(msgId: string): string {
    const entry = this._nodeIndex.get(msgId);
    if (!entry) return msgId;

    let current = entry.node;
    const visited = new Set<string>([current.msgId]);
    while (current.forkOf) {
      if (visited.has(current.forkOf)) break; // cycle guard
      const forkTarget = this._nodeIndex.get(current.forkOf);
      if (!forkTarget || forkTarget.node.parentId !== current.parentId) break;
      current = forkTarget.node;
      visited.add(current.msgId);
    }
    return current.msgId;
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  flatten(): TMessage[] {
    const result: TMessage[] = [];
    const currentPath = new Set<string>();
    // Track which sibling groups we've already resolved to avoid
    // re-resolving for every member of the group.
    const resolvedGroups = new Map<string, string>(); // groupRootId → selected msgId

    for (const internal of this._sortedList) {
      const node = internal.node;
      const { msgId, parentId } = node;

      // Step 1: Check parent reachability.
      if (parentId !== undefined && !currentPath.has(parentId)) {
        continue;
      }

      // Step 2: Check sibling selection.
      const group = this._getSiblingGroup(msgId);
      if (group.length > 1) {
        const groupRootId = this._getGroupRoot(msgId);
        let selectedId = resolvedGroups.get(groupRootId);
        if (selectedId === undefined) {
          const selectedIdx = this._selections.get(groupRootId) ?? group.length - 1;
          const clamped = Math.max(0, Math.min(selectedIdx, group.length - 1));
          const selected = group[clamped];
          if (!selected) break; // unreachable: clamped is always in bounds
          selectedId = selected.msgId;
          resolvedGroups.set(groupRootId, selectedId);
        }
        if (msgId !== selectedId) {
          continue;
        }
      }

      currentPath.add(msgId);
      result.push(node.message);
    }

    return result;
  }

  getSiblings(msgId: string): TMessage[] {
    return this._getSiblingGroup(msgId).map((n) => n.message);
  }

  hasSiblings(msgId: string): boolean {
    return this._getSiblingGroup(msgId).length > 1;
  }

  getSelectedIndex(msgId: string): number {
    const group = this._getSiblingGroup(msgId);
    if (group.length <= 1) return 0;
    const groupRootId = this._getGroupRoot(msgId);
    const stored = this._selections.get(groupRootId);
    if (stored !== undefined) return Math.max(0, Math.min(stored, group.length - 1));
    return group.length - 1; // default: latest
  }

  // Spec: AIT-CT13c
  select(msgId: string, index: number): void {
    this._logger.debug('ConversationTree.select();', { msgId, index });
    const group = this._getSiblingGroup(msgId);
    if (group.length <= 1) return;
    const groupRootId = this._getGroupRoot(msgId);
    this._selections.set(groupRootId, Math.max(0, Math.min(index, group.length - 1)));
  }

  getNode(msgId: string): ConversationNode<TMessage> | undefined {
    return this._nodeIndex.get(msgId)?.node;
  }

  getNodeByKey(key: string): ConversationNode<TMessage> | undefined {
    const msgId = this._codecKeyIndex.get(key);
    if (!msgId) return undefined;
    return this._nodeIndex.get(msgId)?.node;
  }

  getHeaders(msgId: string): Record<string, string> | undefined {
    return this._nodeIndex.get(msgId)?.node.headers;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  upsert(msgId: string, message: TMessage, headers: Record<string, string>, serial?: string): void {
    const parentId = headers[HEADER_PARENT] ?? undefined;
    const forkOf = headers[HEADER_FORK_OF] ?? undefined;

    // Maintain codec key → msgId secondary index
    this._codecKeyIndex.set(this._getKey(message), msgId);

    const existing = this._nodeIndex.get(msgId);
    if (existing) {
      // Update in place — message content may have changed (e.g. streaming).
      // Only update headers if the new headers are non-empty (prevents
      // streaming updates from erasing canonical headers).
      existing.node.message = message;
      if (Object.keys(headers).length > 0) {
        existing.node.headers = { ...headers };
      }
      // Spec: AIT-CT13d
      // Promote serial: optimistic (null) → server-assigned on relay.
      if (serial && !existing.node.serial) {
        this._logger.debug('ConversationTree.upsert(); promoting serial', { msgId, serial });
        existing.node.serial = serial;
        // Re-sort: remove from current position, re-insert at correct position.
        this._removeSorted(existing);
        this._insertSorted(existing);
      }
      return;
    }

    this._logger.trace('ConversationTree.upsert(); inserting new node', { msgId, parentId, forkOf });

    const node: ConversationNode<TMessage> = {
      message,
      msgId,
      parentId,
      forkOf,
      headers: { ...headers },
      serial,
    };

    const internal: InternalNode<TMessage> = { node, insertSeq: this._seqCounter++ };
    this._nodeIndex.set(msgId, internal);
    this._addToParentIndex(parentId, msgId);
    this._insertSorted(internal);
  }

  delete(msgId: string): void {
    const entry = this._nodeIndex.get(msgId);
    if (!entry) return;

    this._logger.debug('ConversationTree.delete();', { msgId });

    const { node } = entry;

    // Clean up secondary index
    const codecKey = this._getKey(node.message);
    if (this._codecKeyIndex.get(codecKey) === msgId) {
      this._codecKeyIndex.delete(codecKey);
    }

    // Remove from parent index
    this._removeFromParentIndex(node.parentId, msgId);

    // Remove from sorted list
    this._removeSorted(entry);

    // Remove from primary index
    this._nodeIndex.delete(msgId);
    this._selections.delete(msgId);

    // Children are NOT deleted — they become unreachable in flatten()
    // because their parent is no longer on the active path.
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ConversationTree that materializes branching history from a flat oplog.
 * @param getKey - Codec function that returns a stable key for a domain message.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link ConversationTree} instance.
 */
export const createConversationTree = <TMessage>(
  getKey: (message: TMessage) => string,
  logger: Logger,
): ConversationTree<TMessage> => new DefaultConversationTree(getKey, logger);
