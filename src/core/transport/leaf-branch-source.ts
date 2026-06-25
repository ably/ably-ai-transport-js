/**
 * LeafBranchSource — the agent's leaf-pinned branch strategy.
 *
 * The agent handles one run at a time, against a single branch: the parent chain
 * from the run's triggering input back to the conversation root. This source
 * resolves that branch and serves it two ways:
 *
 *  - As a {@link BranchSource} for the run's paginating `run.view` — a read-only
 *    {@link View} over the same base the client uses. The session calls
 *    {@link LeafBranchSource.setPin} from `Run.start()` once it has resolved the
 *    trigger's headers, fixing the branch `run.view` projects; before that
 *    `run.view` is empty. It then pages history like the client.
 *  - Via the direct {@link LeafBranchSource.messages} /
 *    {@link LeafBranchSource.loadConversation} methods that back `Run.messages`
 *    and `Run.loadConversation` — the full (un-paginated) conversation the agent
 *    feeds the model, taking the anchor/run-id/regenerate-target the session
 *    resolved at `start()`. (`loadConversation` additionally hydrates ancestors
 *    and honours `maxRuns`.)
 *
 * It does NOT own the Tree or hydrator — the session owns them and swaps both on
 * channel continuity loss, so this reads them through `getTree()` / `getHydrator()`
 * live accessors rather than captured references, observing a swap instead of
 * holding the abandoned instances.
 *
 * The branch is a linear parent walk, so flattening is a plain concatenation
 * (truncated before the regenerate target where one is set) — there is no
 * sibling/regenerate collapse to apply, unlike the client's navigable source.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecMessage, CodecOutputEvent } from '../codec/types.js';
import type { BranchSource } from './branch-source.js';
import type { HistoryHydrator } from './history-hydrator.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type { ConversationNode, RunNode, Tree } from './types.js';

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
const walkAncestorChain = <TOutput extends CodecOutputEvent, TProjection>(
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
 * Constructor dependencies for {@link LeafBranchSource}, injected by AgentSession
 * per run.
 *
 * The Tree and hydrator are read through accessors, not captured references: the
 * session swaps both on continuity loss, and the source must observe the swap.
 */
export interface LeafBranchSourceOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** Live accessor for the session's current materialisation Tree. */
  getTree: () => TreeInternal<TInput, TOutput, TProjection>;
  /** Live accessor for the session's current shared history hydrator. */
  getHydrator: () => HistoryHydrator;
  /** Codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
}

/**
 * The resolved leaf pin: the branch `run.view` projects. Set via
 * {@link LeafBranchSource.setPin} once the run's `start()` has resolved the
 * triggering input's headers.
 */
interface LeafPin {
  /**
   * The branch anchor — the triggering input's codec-message-id when it backs a
   * Tree node, else its `parent` (for wire-only regenerate carriers). Mirrors
   * the session's `assistantParentFallback`.
   */
  anchor: string | undefined;
  /** The run's resolved id (provisional for a fresh run, the wire id for a continuation). */
  runId: string;
  /** The codec-message-id being regenerated, if any — flattening stops before it. */
  regenerateTarget: string | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The agent's leaf-pinned {@link BranchSource}. See the file header for the two
 * roles (paginating `run.view` vs the direct `Run.messages`/`loadConversation`
 * reconstruction).
 */
export class LeafBranchSource<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements BranchSource<TProjection, TMessage> {
  private readonly _getTree: () => TreeInternal<TInput, TOutput, TProjection>;
  private readonly _getHydrator: () => HistoryHydrator;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger;

  /**
   * The resolved branch `run.view` projects. `undefined` until `start()` resolves
   * the trigger and calls {@link setPin} — so `run.view` is empty before the run
   * starts.
   */
  private _pin: LeafPin | undefined;
  /** Notifies the owning View to recompute; set by `createLeafView`. */
  private _notify: (() => void) | undefined;

  constructor(options: LeafBranchSourceOptions<TInput, TOutput, TProjection, TMessage>) {
    this._getTree = options.getTree;
    this._getHydrator = options.getHydrator;
    this._codec = options.codec;
    this._logger = options.logger.withContext({ component: 'LeafBranchSource' });
  }

  /**
   * Pin `run.view` to the run's branch. Called by `AgentSession` from `Run.start()`
   * once the triggering input's headers are resolved (the same anchor / run-id /
   * regenerate-target the session feeds `Run.messages`). Nudges the owning View to
   * recompute, since a pin change is not itself a Tree event.
   * @param anchor - The branch anchor (see {@link LeafPin.anchor}).
   * @param runId - The run's resolved id.
   * @param regenerateTarget - The codec-message-id being regenerated, if any.
   */
  setPin(anchor: string | undefined, runId: string, regenerateTarget: string | undefined): void {
    this._pin = { anchor, runId, regenerateTarget };
    this._notify?.();
  }

  /**
   * Register the owning View's recompute callback. Called by `createLeafView` so
   * {@link setPin} can refresh the view's snapshot.
   * @param notify - The recompute callback.
   */
  setNotify(notify: () => void): void {
    this._notify = notify;
  }

  // -------------------------------------------------------------------------
  // BranchSource contract — drives the run's paginating run.view
  // -------------------------------------------------------------------------

  visibleNodes(): ConversationNode<TProjection>[] {
    const pin = this._pin;
    if (pin === undefined) return [];
    const tree = this._getTree();
    const chain = walkAncestorChain(tree, pin.anchor, undefined, pin.runId);
    const runNode = tree.getRunNode(pin.runId);
    // Append the current run's own node (the leaf) when the ancestor walk didn't
    // already reach it — it is the conversation tail, not ancestor context.
    if (runNode !== undefined && !chain.some((n) => n.kind === 'run' && n.runId === pin.runId)) {
      return [...chain, runNode];
    }
    return [...chain];
  }

  extractMessages(nodes: ConversationNode<TProjection>[]): CodecMessage<TMessage>[] {
    // Linear parent walk — plain concatenation, no sibling/regenerate collapse.
    // Stop before the regenerate target (where set) so the reconstructed history
    // ends on the message the agent is about to replace, not on it.
    const regenerateTarget = this._pin?.regenerateTarget;
    const out: CodecMessage<TMessage>[] = [];
    for (const node of nodes) {
      for (const m of this._codec.getMessages(node.projection)) {
        if (regenerateTarget !== undefined && m.codecMessageId === regenerateTarget) return out;
        out.push(m);
      }
    }
    return out;
  }

  selectedReplyRun(inputCodecMessageId: string): RunNode<TProjection> | undefined {
    const replies = this._getTree().getReplyRuns(inputCodecMessageId);
    if (replies.length <= 1) return replies[0];
    // Prefer the reply run on this leaf's branch; otherwise the latest.
    const onBranch = new Set(this.visibleNodes().map((n) => nodeKey(n)));
    return (
      replies.find((r) => onBranch.has(r.runId)) ??
      replies.toSorted((a, b) => (a.startSerial ?? '￿').localeCompare(b.startSerial ?? '￿')).at(-1)
    );
  }

  // The leaf branch is fixed by its pin — no navigation state to reconcile, so
  // the BranchSource maintenance hook is a no-op (the `prevVisibleNodeKeys`
  // argument the contract passes is unused).
  onVisibleNodesChanged(): void {
    // intentional no-op
  }

  // -------------------------------------------------------------------------
  // Direct reconstruction — backs Run.messages / Run.loadConversation
  // -------------------------------------------------------------------------

  /**
   * Reconstruct the conversation by walking the parent chain from the run's
   * input node back to the conversation root, reading already-folded
   * projections off the Tree's nodes.
   *
   * Hydrates the Tree as needed via the shared hydrator
   * ({@link LeafBranchSource._hydrateAncestors}), then concatenates
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
   * Synchronous live read of the conversation messages for `Run.messages`:
   * walk the parent chain from `anchor` (no `maxRuns` bound), concatenate each
   * ancestor's projection, then append the current run's messages if its node
   * isn't already on the chain. No I/O — reflects whatever is currently folded.
   * @param runId - The current run's id (for the tail run's projection lookup).
   * @param anchor - The current run's input node codec-message-id (assistantParentFallback).
   * @param regenerateTarget - The codec-message-id being regenerated; when set,
   *   the walk stops before it (see {@link LeafBranchSource._collectConversation}).
   * @returns The conversation messages, root-first.
   */
  messages(runId: string, anchor: string | undefined, regenerateTarget?: string): TMessage[] {
    return this._collectConversation(runId, anchor, undefined, regenerateTarget).messages;
  }

  /**
   * Walk the parent chain from `anchor` over the current Tree and concatenate
   * each node's projected messages (root-first), then append the current run's
   * own messages when its RunNode isn't already on the chain. Shared by
   * {@link LeafBranchSource.loadConversation} and {@link LeafBranchSource.messages}.
   * Pure read over whatever is currently folded — no fetching.
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
    const tree = this._getTree();
    const chain = walkAncestorChain(tree, anchor, maxRuns, runId);
    const runNode = tree.getRunNode(runId);
    const messages: TMessage[] = [];
    for (const node of chain) {
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
      const tree = this._getTree();
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
      await this._getHydrator().foldUntil(() => !needsFetch(), signal);
    } catch (error) {
      this._logger.error('LeafBranchSource._hydrateAncestors(); history fetch failed', {
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
 * Create a {@link LeafBranchSource}. Factory entry point; AgentSession never
 * calls `new LeafBranchSource` directly.
 * @param options - Injected dependencies.
 * @returns A new LeafBranchSource.
 */
export const createLeafBranchSource = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: LeafBranchSourceOptions<TInput, TOutput, TProjection, TMessage>,
): LeafBranchSource<TInput, TOutput, TProjection, TMessage> => new LeafBranchSource(options);
