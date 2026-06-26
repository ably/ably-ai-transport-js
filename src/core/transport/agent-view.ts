/**
 * AgentView — internal, server-side conversation reader for AgentSession.
 *
 * Reconstructs the ancestor chain an agent run needs for its LLM prompt: it
 * hydrates the session Tree via the shared {@link HistoryHydrator} as far back
 * as the walk requires ({@link AgentView.loadConversation}), then reads the
 * already-folded projections off the Tree's nodes
 * ({@link AgentView.messages} / `loadConversation`).
 *
 * It does NOT own the materialisation Tree or the hydrator — AgentSession owns
 * the Tree, applier, and hydrator (and swaps all three on channel continuity
 * loss) and injects the Tree, codec, and hydrator here as `readonly` fields.
 * Because AgentSession swaps the Tree/hydrator, it RECREATES the AgentView on
 * continuity loss (a fresh instance bound to the fresh Tree/hydrator) rather
 * than mutating it — so this class never needs a tree accessor or a reset hook.
 *
 * This is deliberately internal: it is not exported from any entry point and
 * does NOT implement the public `View` interface (that is the client-side
 * `DefaultView`, unrelated to this class).
 *
 * The pre-run-start input-event lookup lives separately in
 * {@link locateInputEvent}; both it and `loadConversation` drive the SAME
 * session hydrator, so a `start()` input scan and a concurrent `loadConversation`
 * share folded pages instead of each scanning the channel.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import type { HistoryHydrator } from './history-hydrator.js';
import type { TreeInternal } from './tree.js';
import type { ConversationNode, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Ancestor-chain walk over the Tree
// ---------------------------------------------------------------------------

/**
 * Walk parent pointers from an anchor codec-message-id back through the
 * Tree to the conversation root, returning nodes in root-first order. When
 * `maxRuns` is set, the walk stops before the RunNode that would exceed the
 * bound, so the bounding run's own input node(s) are still included (input
 * nodes never count toward the bound). The chain therefore starts with the
 * input that triggered its oldest run, never with an assistant reply.
 *
 * Returns an empty array when the anchor isn't in the Tree.
 * @param tree - The materialisation tree to walk.
 * @param anchor - The codec-message-id to start from (typically the current run's input).
 * @param maxRuns - Optional bound on the number of ancestor reply RunNodes in the chain.
 * @param currentRunId - The current run's id. Its own RunNode (reachable when
 * the anchor's wire carried the run-id) is conversation tail, not ancestor
 * context, so it never counts toward `maxRuns`.
 * @returns Nodes from root to anchor in chronological order.
 */
export const walkAncestorChain = <TOutput extends CodecOutputEvent, TProjection>(
  tree: Tree<TOutput, TProjection>,
  anchor: string | undefined,
  maxRuns?: number,
  currentRunId?: string,
): readonly ConversationNode<TProjection>[] => {
  if (anchor === undefined) return [];
  const chain: ConversationNode<TProjection>[] = [];
  let current = tree.getNodeByCodecMessageId(anchor);
  const seen = new Set<string>();
  let runs = 0;
  while (current !== undefined) {
    // Defensive cycle guard — `parentCodecMessageId` chains should be DAGs;
    // a cycle indicates Tree corruption but we don't want to infinite-loop.
    const key = current.kind === 'run' ? current.runId : current.codecMessageId;
    if (seen.has(key)) break;
    if (current.kind === 'run' && current.runId !== currentRunId) {
      // Stop before a run that would exceed the bound — the input node(s)
      // above the last in-bound run belong to its turn and stay included.
      if (maxRuns !== undefined && runs >= maxRuns) break;
      runs += 1;
    }
    seen.add(key);
    chain.unshift(current);
    const parentId = current.parentCodecMessageId;
    if (parentId === undefined) break;
    current = tree.getNodeByCodecMessageId(parentId);
  }
  return chain;
};

/**
 * Count the ancestor reply RunNodes in a chain. Used to bound the walk via
 * the `maxRuns` option; the current run's own node never counts.
 * @param chain - Ancestor chain to count over.
 * @param currentRunId - The current run's id, excluded from the count.
 * @returns Number of ancestor reply RunNodes in the chain.
 */
const countReplyRuns = <TProjection>(
  chain: readonly ConversationNode<TProjection>[],
  currentRunId?: string,
): number => {
  let count = 0;
  for (const node of chain) if (node.kind === 'run' && node.runId !== currentRunId) count++;
  return count;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor dependencies for {@link AgentView}, injected by AgentSession.
 *
 * AgentView reads the `tree` and drives the `hydrator`; AgentSession owns both
 * and, because it SWAPS them on continuity loss, recreates the AgentView with
 * the fresh pair rather than mutating them in place.
 */
export interface AgentViewOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The session's materialisation Tree (read for ancestor walks). */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** Codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** The session's shared history hydrator; ancestor hydration drives it. */
  hydrator: HistoryHydrator;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Internal server-side view: conversation loading over the session Tree. See
 * the file header for the ownership boundary.
 */
export class AgentView<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _hydrator: HistoryHydrator;
  private readonly _logger?: Logger;

  constructor(options: AgentViewOptions<TInput, TOutput, TProjection, TMessage>) {
    this._tree = options.tree;
    this._codec = options.codec;
    this._hydrator = options.hydrator;
    this._logger = options.logger?.withContext({ component: 'AgentView' });
  }

  // -------------------------------------------------------------------------
  // Conversation walk
  // -------------------------------------------------------------------------

  /**
   * Reconstruct the conversation by walking the parent chain from the run's
   * input node back to the conversation root, reading already-folded
   * projections off the Tree's nodes.
   *
   * Hydrates the Tree as needed via the shared hydrator
   * ({@link AgentView._hydrateAncestors}), then concatenates
   * `codec.getMessages(node.projection)` per node (root first) and appends the
   * current run's projection at the tail.
   * @param runId - The current run's id (for the tail run's projection lookup).
   * @param assistantParentFallback - The current run's input node codec-message-id.
   * @param signal - AbortSignal; rejects with InvalidArgument when aborted.
   * @param maxRuns - Optional bound on the parent walk; counts reply RunNodes.
   * @param runIdAdopted - True when the run-id came from outside (runtime
   *   override or continuation), so its node may exist in channel history;
   *   false for agent-minted ids, whose run-start only ever arrives via the
   *   live echo.
   * @param regenerateTarget - The codec-message-id being regenerated, or
   *   undefined; the run that owns it is flattened only up to that message so
   *   the reconstructed history stops before the assistant message being
   *   replaced (which the model would otherwise reject).
   * @returns The branch's messages (root-first) and the current run's projection.
   */
  async loadConversation(
    runId: string,
    assistantParentFallback: string | undefined,
    signal: AbortSignal,
    maxRuns: number | undefined,
    runIdAdopted: boolean,
    regenerateTarget?: string,
  ): Promise<{ messages: TMessage[]; projection: TProjection }> {
    if (signal.aborted) {
      throw new Ably.ErrorInfo(
        `unable to load conversation; run ${runId} was cancelled`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    await this._hydrateAncestors(runId, assistantParentFallback, signal, maxRuns, runIdAdopted);

    return this._collectConversation(runId, assistantParentFallback, maxRuns, regenerateTarget);
  }

  /**
   * Walk the parent chain from `anchor` over the current Tree and concatenate
   * each node's projected messages (root-first), then append the current run's
   * own messages when its RunNode isn't already on the chain. Shared by
   * {@link AgentView.loadConversation} and {@link AgentView.messages}. Pure read
   * over whatever is currently folded — no fetching.
   * @param runId - The current run's id (for the tail run's projection lookup).
   * @param anchor - The current run's input node codec-message-id.
   * @param maxRuns - Optional bound on the ancestor walk (counts reply runs).
   * @param regenerateTarget - The codec-message-id being regenerated; when set,
   *   the walk stops before that message (a regenerate of a non-head message
   *   anchors at the target's predecessor, so flattening its run whole would
   *   re-emit the target and end the history on the message being replaced).
   * @returns The conversation messages (root-first) and the current run's
   *   projection (the codec's empty init when the run has no node yet).
   */
  private _collectConversation(
    runId: string,
    anchor: string | undefined,
    maxRuns?: number,
    regenerateTarget?: string,
  ): { messages: TMessage[]; projection: TProjection } {
    const tree = this._tree;
    const chain = walkAncestorChain(tree, anchor, maxRuns, runId);
    const runNode = tree.getRunNode(runId);
    const messages: TMessage[] = [];
    for (const node of chain) {
      // Omit an ancestor run whose projection isn't prompt-safe (AIT-878): the
      // codec reports unresolved work — for the Vercel codec, an assistant tool
      // call with no matching result — which the model provider would reject as
      // a dangling tool call. Checked by projection content, not run state, so
      // it catches a run still `active` while a server-side tool executes as
      // well as a suspended/terminated one. The current run (the tail being
      // produced or continued) is exempt: its own resolutions are applied
      // before we prompt. Runs on every prompt build (initial inference and
      // each continuation/resume), so a late re-walk can't reintroduce the run.
      // A codec without isPromptSafe treats every projection as safe (no-op).
      if (node.kind === 'run' && node.runId !== runId && this._codec.isPromptSafe?.(node.projection) === false) {
        this._logger?.debug('AgentView._collectConversation(); omitting prompt-unsafe ancestor run', {
          runId: node.runId,
        });
        continue;
      }
      for (const m of this._codec.getMessages(node.projection)) {
        if (regenerateTarget !== undefined && m.codecMessageId === regenerateTarget) {
          return { messages, projection: runNode?.projection ?? this._codec.init() };
        }
        messages.push(m.message);
      }
    }

    if (runNode !== undefined && !chain.some((n) => n.kind === 'run' && n.runId === runId)) {
      for (const m of this._codec.getMessages(runNode.projection)) {
        messages.push(m.message);
      }
    }

    return { messages, projection: runNode?.projection ?? this._codec.init() };
  }

  /**
   * Synchronous live read of the conversation messages for `Run.messages`:
   * walk the parent chain from `anchor` (no `maxRuns` bound), concatenate each
   * ancestor's projection, then append the current run's messages if its node
   * isn't already on the chain. No I/O — reflects whatever is currently folded.
   * @param runId - The current run's id (for the tail run's projection lookup).
   * @param anchor - The current run's input node codec-message-id (assistantParentFallback).
   * @param regenerateTarget - The codec-message-id being regenerated; when set,
   *   the walk stops before it (see {@link AgentView._collectConversation}).
   * @returns The conversation messages, root-first.
   */
  messages(runId: string, anchor: string | undefined, regenerateTarget?: string): TMessage[] {
    return this._collectConversation(runId, anchor, undefined, regenerateTarget).messages;
  }

  // -------------------------------------------------------------------------
  // Ancestor hydration
  // -------------------------------------------------------------------------

  /**
   * Populate the Tree with enough ancestor coverage to walk from `anchor` to
   * root (or `maxRuns` reply runs back) by driving the shared hydrator. The
   * hydrator owns cursor exhaustion, so a walk that needs more than the channel
   * holds pages to exhaustion and then returns with the partial chain folded.
   * @param runId - The current run's id (when adopted, its node must be present in the Tree before the walk is complete).
   * @param anchor - The input codec-message-id to walk from. Undefined means no walk is needed (current run only).
   * @param signal - AbortSignal.
   * @param maxRuns - Optional bound on the ancestor walk.
   * @param runIdAdopted - Whether the run-id came from outside (override or continuation) and so may name a run present in channel history.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when `signal` aborts;
   *   `HistoryFetchFailed` — or the underlying Ably code when the failure
   *   carried one — (original as `cause`) when the history fetch fails after
   *   retries.
   */
  private async _hydrateAncestors(
    runId: string,
    anchor: string | undefined,
    signal: AbortSignal,
    maxRuns: number | undefined,
    runIdAdopted: boolean,
  ): Promise<void> {
    // Check whether the Tree already has what we need: the current run node
    // exists AND (no anchor OR anchor's chain reaches root / maxRuns).
    const needsFetch = (): boolean => {
      const tree = this._tree;
      // Only an adopted run-id (runtime override or continuation) can name a
      // run already present in channel history. A fresh agent-minted run's
      // run-start is published after attach, so the `untilAttach` walk can
      // never surface it; demanding it would page the whole channel to
      // exhaustion. Fresh runs are satisfied by start()'s optimistic insert.
      // For adopted ids the node must be serial-CONFIRMED: an override id's
      // optimistic insert is serial-less, and its history content (if any)
      // still needs hydrating.
      if (runIdAdopted && tree.getRunNode(runId)?.startSerial === undefined) return true;
      if (anchor === undefined) return false;
      if (tree.getNodeByCodecMessageId(anchor) === undefined) return true;
      const chain = walkAncestorChain(tree, anchor, maxRuns, runId);
      const head = chain[0];
      const reachedRoot = head !== undefined && head.parentCodecMessageId === undefined;
      // The bound is only satisfied once the bounding run's triggering input
      // is in the chain — a head that is still an ancestor RunNode means the
      // input above it hasn't been hydrated yet (assistant-first context).
      const reachedLimit =
        maxRuns !== undefined &&
        countReplyRuns(chain, runId) >= maxRuns &&
        head !== undefined &&
        (head.kind !== 'run' || head.runId === runId);
      return !reachedRoot && !reachedLimit;
    };

    if (!needsFetch()) return;

    try {
      // The hydrator pages until `needsFetch()` is satisfied or the channel is
      // exhausted (it owns and short-circuits on its own exhaustion), folding
      // each page into the Tree.
      await this._hydrator.foldUntil(() => !needsFetch(), signal);
    } catch (error) {
      this._logger?.error('AgentView._hydrateAncestors(); history fetch failed', {
        runId,
        error: errorMessage(error),
      });
      throw error;
    }

    // A between-pages abort unwinds the fold cleanly (no throw); surface it as
    // the cancellation the caller expects rather than returning partial history.
    if (signal.aborted && needsFetch()) {
      throw new Ably.ErrorInfo('unable to hydrate ancestors; signal aborted', ErrorCode.InvalidArgument, 400);
    }
  }
}

/**
 * Create an {@link AgentView}. Factory entry point mirroring `createTree`;
 * AgentSession never calls `new AgentView` directly.
 * @param options - Injected dependencies.
 * @returns A new AgentView.
 */
export const createAgentView = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: AgentViewOptions<TInput, TOutput, TProjection, TMessage>,
): AgentView<TInput, TOutput, TProjection, TMessage> => new AgentView(options);
