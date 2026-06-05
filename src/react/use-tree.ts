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

import type { CodecInputEvent, CodecOutputEvent } from '../core/codec/types.js';
import type { ConversationNode, RunNode } from '../core/transport/types.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Handle for querying the conversation tree structure. */
export interface TreeHandle<TProjection> {
  /** Get a Run by runId, or undefined if not found. */
  getRunNode: (runId: string) => RunNode<TProjection> | undefined;
  /**
   * Get the node that owns a given codec-message-id, or undefined if not
   * observed. Returns a {@link ConversationNode} union — narrow on `kind`
   * (`'input'` vs `'run'`) before reading kind-specific fields.
   */
  getNodeByCodecMessageId: (codecMessageId: string) => ConversationNode<TProjection> | undefined;
  /**
   * Get the sibling group (both kinds) the node keyed by `key` belongs to —
   * edit versions for an input node, regenerate runs for a reply run — ordered
   * oldest-first. A single-element array when the node has no siblings; empty
   * when `key` is unknown. `key` is a {@link RunNode.runId} or an
   * {@link InputNode.codecMessageId}.
   */
  getSiblingNodes: (key: string) => ConversationNode<TProjection>[];
}

/** Options for {@link useTree}. */
export type UseTreeOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> = BaseSessionOption<TInput, TOutput, TProjection, TMessage>;

/**
 * Provide stable structural query callbacks backed by the session's tree.
 * When `session` is omitted, uses the nearest {@link ClientSessionProvider}'s session via context.
 * @param props - Options including optional `session`.
 * @param props.session - Session to read tree structure from; defaults to the nearest provider.
 * @returns A {@link TreeHandle} with structural query methods.
 */
export const useTree = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>({
  session,
}: UseTreeOptions<TInput, TOutput, TProjection, TMessage> = {}): TreeHandle<TProjection> => {
  const resolved = useResolvedSession({ session });

  const getRunNode = useCallback(
    (runId: string): RunNode<TProjection> | undefined => resolved?.tree.getRunNode(runId),
    [resolved],
  );

  const getNodeByCodecMessageId = useCallback(
    (codecMessageId: string): ConversationNode<TProjection> | undefined =>
      resolved?.tree.getNodeByCodecMessageId(codecMessageId),
    [resolved],
  );

  const getSiblingNodes = useCallback(
    (key: string): ConversationNode<TProjection>[] => resolved?.tree.getSiblingNodes(key) ?? [],
    [resolved],
  );

  return {
    getRunNode,
    getNodeByCodecMessageId,
    getSiblingNodes,
  };
};
