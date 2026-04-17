/**
 * useTree — stable structural query callbacks for a ClientTransport's tree.
 *
 * Returns a {@link TreeHandle} with methods to inspect the tree structure.
 * These are thin `useCallback` wrappers around `transport.tree` — no local
 * state or subscriptions. Branch navigation (select, getSelectedIndex) is
 * on {@link ViewHandle} from {@link useView}.
 *
 * When `transport` is omitted, defaults to the nearest
 * {@link TransportProvider}'s transport via context.
 */

import { useCallback } from 'react';

import type { ClientTransport, MessageNode } from '../core/transport/types.js';
import { useResolvedTransport } from './internal/use-resolved-transport.js';

/** Handle for querying the conversation tree structure. */
export interface TreeHandle<TMessage> {
  /** Get all sibling messages at a fork point, ordered chronologically by serial. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Get a node by msgId, or undefined if not found. */
  getNode: (msgId: string) => MessageNode<TMessage> | undefined;
}

/**
 * Provide stable structural query callbacks backed by the transport's tree.
 * When `transport` is omitted, uses the nearest {@link TransportProvider}'s transport via context.
 * @param props - Options including optional `transport`.
 * @param props.transport - Transport to read tree structure from; defaults to the nearest provider.
 * @returns A {@link TreeHandle} with structural query methods.
 */
export const useTree = <TEvent, TMessage>({
  transport,
}: { transport?: ClientTransport<TEvent, TMessage> } = {}): TreeHandle<TMessage> => {
  const resolved = useResolvedTransport({ transport });

  const getSiblings = useCallback((msgId: string) => resolved?.tree.getSiblings(msgId) ?? [], [resolved]);

  const hasSiblings = useCallback((msgId: string) => resolved?.tree.hasSiblings(msgId) ?? false, [resolved]);

  const getNode = useCallback((msgId: string) => resolved?.tree.getNode(msgId), [resolved]);

  return {
    getSiblings,
    hasSiblings,
    getNode,
  };
};
