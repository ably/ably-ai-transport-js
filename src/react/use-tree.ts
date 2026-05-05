/**
 * useTree — stable structural query callbacks for a ClientSession's tree.
 *
 * Returns a {@link TreeHandle} with methods to inspect the tree structure.
 * These are thin `useCallback` wrappers around `session.tree` — no local
 * state or subscriptions. Branch navigation (select, getSelectedIndex) is
 * on {@link ViewHandle} from {@link useView}.
 *
 * When `session` is omitted, defaults to the nearest
 * {@link ClientSessionProvider}'s session via context.
 */

import { useCallback } from 'react';

import type { MessageNode } from '../core/transport/types.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Handle for querying the conversation tree structure. */
export interface TreeHandle<TMessage> {
  /** Get all sibling messages at a fork point, ordered chronologically by serial. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Get a node by msgId, or undefined if not found. */
  getNode: (msgId: string) => MessageNode<TMessage> | undefined;
}

/** Options for {@link useTree}. */
export type UseTreeOptions<TEvent, TMessage> = BaseSessionOption<TEvent, TMessage>;

/**
 * Provide stable structural query callbacks backed by the session's tree.
 * When `session` is omitted, uses the nearest {@link ClientSessionProvider}'s session via context.
 * @param props - Options including optional `session`.
 * @param props.session - Session to read tree structure from; defaults to the nearest provider.
 * @returns A {@link TreeHandle} with structural query methods.
 */
export const useTree = <TEvent, TMessage>({ session }: UseTreeOptions<TEvent, TMessage> = {}): TreeHandle<TMessage> => {
  const resolved = useResolvedSession({ session });

  const getSiblings = useCallback((msgId: string) => resolved?.tree.getSiblings(msgId) ?? [], [resolved]);

  const hasSiblings = useCallback((msgId: string) => resolved?.tree.hasSiblings(msgId) ?? false, [resolved]);

  const getNode = useCallback((msgId: string) => resolved?.tree.getNode(msgId), [resolved]);

  return {
    getSiblings,
    hasSiblings,
    getNode,
  };
};
