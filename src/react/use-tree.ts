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
  getSiblings: (codecMessageId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (codecMessageId: string) => boolean;
  /** Get a node by codecMessageId, or undefined if not found. */
  getNode: (codecMessageId: string) => MessageNode<TMessage> | undefined;
}

/** Options for {@link useTree}. */
export type UseTreeOptions<TEvent, TProjection, TMessage> = BaseSessionOption<TEvent, TProjection, TMessage>;

/**
 * Provide stable structural query callbacks backed by the session's tree.
 * When `session` is omitted, uses the nearest {@link ClientSessionProvider}'s session via context.
 * @param props - Options including optional `session`.
 * @param props.session - Session to read tree structure from; defaults to the nearest provider.
 * @returns A {@link TreeHandle} with structural query methods.
 */
export const useTree = <TEvent, TProjection, TMessage>({
  session,
}: UseTreeOptions<TEvent, TProjection, TMessage> = {}): TreeHandle<TMessage> => {
  const resolved = useResolvedSession({ session });

  const getSiblings = useCallback(
    (codecMessageId: string): TMessage[] => resolved?.tree.getSiblings(codecMessageId) ?? [],
    [resolved],
  );

  const hasSiblings = useCallback(
    (codecMessageId: string) => resolved?.tree.hasSiblings(codecMessageId) ?? false,
    [resolved],
  );

  const getNode = useCallback(
    (codecMessageId: string): MessageNode<TMessage> | undefined => resolved?.tree.getNode(codecMessageId),
    [resolved],
  );

  return {
    getSiblings,
    hasSiblings,
    getNode,
  };
};
