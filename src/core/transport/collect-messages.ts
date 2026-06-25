/**
 * collectMessages — flatten a visible node chain into the flat
 * `CodecMessage<TMessage>[]` a view renders.
 *
 * Both the client view (navigable, selection-driven) and the agent view
 * (read-only, leaf-pinned) collect their messages through this one function, so
 * the two cannot drift on how a branch is rendered. It owns the one behaviour
 * not expressible in the Tree's `visibleNodes` sibling collapse:
 *
 *  - **Non-head-regenerate substitution** — a regenerate that replaced a
 *    non-head message inside a multi-message reply run parents at the target's
 *    predecessor, not as a same-parent sibling, so the Tree cannot collapse it.
 *    While emitting a reply run, at each non-head message that has a selected
 *    regenerator, this drops that message and the run's tail and emits the
 *    selected regenerator in its place (recursively, for regen-of-regen).
 *
 * A non-head regenerator is therefore emitted *only* via this substitution, at
 * the slot it replaces — never as a node in its own right. So the walk first
 * collects every non-head regenerator on the visible chain and skips them in
 * the top-level pass; reaching one directly (e.g. because `visibleNodes`
 * surfaced it as a child of the owner run) would otherwise emit it twice, or —
 * when an earlier substitution dropped the slot it anchored on — leave a stale
 * tail message on the branch.
 *
 * Pure: it reads nothing but its arguments. The caller supplies the codec's
 * `getMessages` and a {@link NonHeadRegenerateResolver} — so the same
 * flattening serves a selection-map source (client) and a leaf-derived source
 * (agent).
 */

import type { CodecMessage } from '../codec/types.js';
import type { ConversationNode, RunNode } from './types.js';

/**
 * Resolves a non-head-regenerate group: a regenerate that replaced a non-head
 * message inside a multi-message reply run. Such a regenerator parents at the
 * target's predecessor rather than as a same-parent sibling, so the Tree's
 * `visibleNodes` cannot collapse it — {@link collectMessages} resolves it via
 * this resolver. The client implements it from its navigation state; the agent
 * derives it from the leaf's path.
 */
export interface NonHeadRegenerateResolver<TProjection> {
  /**
   * The regenerator runs that replaced a non-head message of a reply run: the
   * reply runs parented at `predecessorCodecMessageId` whose
   * `regeneratesCodecMessageId` is `targetCodecMessageId`, oldest-first. Empty
   * when the message has no non-head regenerators.
   * @param targetCodecMessageId - The regenerate target's (non-head) message id.
   * @param predecessorCodecMessageId - The codec-message-id immediately before it in the owner run.
   * @returns The regenerator runs, oldest-first.
   */
  regenerators(targetCodecMessageId: string, predecessorCodecMessageId: string): RunNode<TProjection>[];
  /**
   * The selected member of a non-head regenerate group: the owner run id (the
   * regenerate target in place) or one of the regenerator run ids.
   * @param targetCodecMessageId - The regenerate target's message id (the group anchor).
   * @param ownerRunId - The run that owns the regenerate target.
   * @param regenerators - The regenerator runs (oldest-first) from {@link NonHeadRegenerateResolver.regenerators}.
   * @returns The selected member's run id (`ownerRunId` or a regenerator's).
   */
  selected(targetCodecMessageId: string, ownerRunId: string, regenerators: RunNode<TProjection>[]): string;
}

/**
 * Flatten a visible node chain to its flat message list, collapsing each
 * non-head regenerate into the slot it replaces. Whole-reply regenerates need
 * nothing here — `visibleNodes` (client) or the leaf parent walk (agent)
 * already picks the surviving sibling.
 * @param nodes - Visible nodes (inputs + reply runs), chronological.
 * @param getMessages - The codec's projection-to-messages function.
 * @param regenerate - Resolver for non-head-regenerate groups.
 * @returns The flat message list, each paired with its codec-message-id.
 */
export const collectMessages = <TProjection, TMessage>(
  nodes: readonly ConversationNode<TProjection>[],
  getMessages: (projection: TProjection) => CodecMessage<TMessage>[],
  regenerate: NonHeadRegenerateResolver<TProjection>,
): CodecMessage<TMessage>[] => {
  // Emit one node's messages into `out`, applying non-head-regenerate
  // substitution for a reply run. Input nodes and runs with no non-head
  // regenerators emit their projection verbatim; at a non-head slot whose
  // selected member is a regenerator, the owner run's message and the rest of
  // its tail are dropped and the regenerator is emitted in its place
  // (recursively, for regen-of-regen).
  const emitNode = (node: ConversationNode<TProjection>, out: CodecMessage<TMessage>[]): void => {
    const own = getMessages(node.projection);
    if (node.kind !== 'run') {
      out.push(...own);
      return;
    }
    for (let i = 0; i < own.length; i++) {
      const m = own[i];
      if (!m) continue;
      // Head message (i === 0) regenerates are whole-reply sibling runs, already
      // resolved by visibleNodes — only non-head messages anchor a non-head group.
      const predecessor = i > 0 ? own[i - 1]?.codecMessageId : undefined;
      if (predecessor !== undefined) {
        const regenerators = regenerate.regenerators(m.codecMessageId, predecessor);
        if (regenerators.length > 0) {
          const selectedKey = regenerate.selected(m.codecMessageId, node.runId, regenerators);
          if (selectedKey !== node.runId) {
            // A regenerator is selected: drop M and the rest of O, emit the
            // selected regenerator in M's place (recursively for nested regen).
            const chosen = regenerators.find((r) => r.runId === selectedKey);
            if (chosen) {
              emitNode(chosen, out);
              return;
            }
          }
          // Original (owner run) selected: fall through and emit M from O.
        }
      }
      out.push(m);
    }
  };

  // Non-head regenerators are emitted only via substitution at their anchor
  // slot, so collect them across the whole chain up front and skip them in the
  // top-level pass. Computing this independently of which slots a substitution
  // later reaches means a regenerator anchored on a slot an earlier
  // substitution drops (and the regenerators of that regenerator) is still
  // found, and never re-emitted as a top-level node.
  const nonHeadRegeneratorIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'run') continue;
    const own = getMessages(node.projection);
    for (let i = 1; i < own.length; i++) {
      const target = own[i]?.codecMessageId;
      const predecessor = own[i - 1]?.codecMessageId;
      if (target === undefined || predecessor === undefined) continue;
      for (const r of regenerate.regenerators(target, predecessor)) nonHeadRegeneratorIds.add(r.runId);
    }
  }

  const out: CodecMessage<TMessage>[] = [];
  for (const node of nodes) {
    if (node.kind === 'run' && nonHeadRegeneratorIds.has(node.runId)) continue;
    emitNode(node, out);
  }
  return out;
};
