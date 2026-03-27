/**
 * useTree — stable branch navigation callbacks for a ClientTransport's tree.
 *
 * Returns a {@link TreeHandle} with methods to inspect and navigate branches.
 * These are thin `useCallback` wrappers around `transport.tree` — no local
 * state or subscriptions. The visible node list comes from {@link useView}.
 */

import { useCallback } from 'react';

import type { ClientTransport, TreeNode } from '../core/transport/types.js';

/** Handle for navigating the branching conversation tree. */
export interface TreeHandle<TMessage> {
  /** Get all sibling messages at a fork point, ordered chronologically by serial. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Index of the currently selected sibling at a fork point. */
  getSelectedIndex: (msgId: string) => number;
  /** Navigate to a sibling by index. Triggers a view update with the new branch. */
  select: (msgId: string, index: number) => void;
  /** Get a node by msgId, or undefined if not found. */
  getNode: (msgId: string) => TreeNode<TMessage> | undefined;
}

/**
 * Provide stable branch navigation callbacks backed by the transport's tree.
 * @param transport - The client transport whose conversation tree to navigate.
 * @returns A {@link TreeHandle} with navigation methods.
 */
export const useTree = <TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>): TreeHandle<TMessage> => {
  const getSiblings = useCallback((msgId: string) => transport.tree.getSiblings(msgId), [transport]);

  const hasSiblings = useCallback((msgId: string) => transport.tree.hasSiblings(msgId), [transport]);

  const getSelectedIndex = useCallback((msgId: string) => transport.tree.getSelectedIndex(msgId), [transport]);

  const select = useCallback(
    (msgId: string, index: number) => {
      transport.tree.select(msgId, index);
    },
    [transport],
  );

  const getNode = useCallback((msgId: string) => transport.tree.getNode(msgId), [transport]);

  return {
    getSiblings,
    hasSiblings,
    getSelectedIndex,
    select,
    getNode,
  };
};
