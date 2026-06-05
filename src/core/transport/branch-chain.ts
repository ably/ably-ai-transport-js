/**
 * buildBranchChain — order a single conversation branch by walking
 * codec-message-id parent links upward from an anchor node to the root.
 *
 * This is the shared ordering spine of the agent's conversation
 * reconstruction and of history decode: both need the same root→anchor
 * sequence of nodes before folding each node's projection. Keeping the walk
 * here — pure, with no codec, no I/O, no logger — lets it be proven in
 * isolation and reused by both engines without drift.
 *
 * Branch selection is implicit: a node reaches only its own ancestors via
 * `parentTransportMessageId`, so sibling branches (edits / regenerates that the
 * anchor did not descend from) are never visited. There is no separate
 * fork/regenerate filtering step — the un-taken sibling is simply unreachable.
 */

/**
 * The single field {@link buildBranchChain} reads from a node. Richer node-meta
 * shapes (carrying run-id, fork-of, regenerates, …) satisfy this structurally,
 * so callers can pass their full index map directly.
 */
export interface BranchChainNode {
  /**
   * Codec-message-id of this node's structural parent — the node it hangs off
   * — or `undefined` for a root node. This is the only edge the walk follows.
   */
  parentTransportMessageId: string | undefined;
}

/**
 * Walk `parentTransportMessageId` links upward from `anchorTransportMessageId` and
 * return the branch it sits on, ordered root-first (oldest) to anchor (newest,
 * last). The anchor is always the final element.
 *
 * The walk stops at the root (a node with no parent), at a dangling parent
 * (a parent id absent from `nodeMeta` is still included as the chain head,
 * then the walk ends), or on revisiting a node (a cycle in malformed data is
 * broken best-effort rather than looping forever).
 * @param nodeMeta - Lookup from codec-message-id to its node meta. Need not
 *   contain the anchor or every ancestor; missing entries simply end the walk.
 * @param anchorTransportMessageId - The codec-message-id to start the walk from
 *   (the newest node on the branch; included in the result).
 * @returns The branch's codec-message-ids ordered root-first to anchor-last.
 */
export const buildBranchChain = (
  nodeMeta: ReadonlyMap<string, BranchChainNode>,
  anchorTransportMessageId: string,
): string[] => {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = anchorTransportMessageId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = nodeMeta.get(current)?.parentTransportMessageId;
  }
  return chain.toReversed();
};
