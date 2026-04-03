/**
 * useTree — stable structural query callbacks for a ClientTransport's tree.
 *
 * Returns a {@link TreeHandle} with methods to inspect the tree structure.
 * These are thin `useCallback` wrappers around `transport.tree` — no local
 * state or subscriptions. Branch navigation (select, getSelectedIndex) is
 * on {@link ViewHandle} from {@link useView}.
 */

import { useCallback } from 'react';

import type { ClientTransport, TreeNode } from '../core/transport/types.js';

/** Handle for querying the conversation tree structure. */
export interface TreeHandle<TMessage> {
  /** Get all sibling messages at a fork point, ordered chronologically by serial. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Get a node by msgId, or undefined if not found. */
  getNode: (msgId: string) => TreeNode<TMessage> | undefined;
}

/**
 * Provide stable structural query callbacks backed by the transport's tree.
 * @param transport - The client transport whose conversation tree to query.
 * @returns A {@link TreeHandle} with structural query methods.
 */
export const useTree = <TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>): TreeHandle<TMessage> => {
  const getSiblings = useCallback((msgId: string) => transport.tree.getSiblings(msgId), [transport]);

  const hasSiblings = useCallback((msgId: string) => transport.tree.hasSiblings(msgId), [transport]);

  const getNode = useCallback((msgId: string) => transport.tree.getNode(msgId), [transport]);

  return {
    getSiblings,
    hasSiblings,
    getNode,
  };
};
