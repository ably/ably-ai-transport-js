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

import type { RunNode } from '../core/transport/types.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Handle for querying the conversation tree structure. */
export interface TreeHandle {
  /** Get a Run by runId, or undefined if not found. */
  getRunNode: (runId: string) => RunNode | undefined;
  /** Get the Run that owns a given codec-message-id, or undefined if not observed. */
  getRunByCodecMessageId: (codecMessageId: string) => RunNode | undefined;
  /** Get all sibling Runs at a fork point, ordered chronologically by startSerial. */
  getSiblingRuns: (runId: string) => RunNode[];
  /** Whether a Run has sibling alternatives (i.e., show navigation arrows). */
  hasSiblingRuns: (runId: string) => boolean;
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
}: UseTreeOptions<TEvent, TProjection, TMessage> = {}): TreeHandle => {
  const resolved = useResolvedSession({ session });

  const getRunNode = useCallback((runId: string): RunNode | undefined => resolved?.tree.getRunNode(runId), [resolved]);

  const getRunByCodecMessageId = useCallback(
    (codecMessageId: string): RunNode | undefined => resolved?.tree.getRunByCodecMessageId(codecMessageId),
    [resolved],
  );

  const getSiblingRuns = useCallback(
    (runId: string): RunNode[] => resolved?.tree.getSiblingRuns(runId) ?? [],
    [resolved],
  );

  const hasSiblingRuns = useCallback((runId: string) => resolved?.tree.hasSiblingRuns(runId) ?? false, [resolved]);

  return {
    getRunNode,
    getRunByCodecMessageId,
    getSiblingRuns,
    hasSiblingRuns,
  };
};
