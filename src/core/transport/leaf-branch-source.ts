/**
 * LeafBranchSource — the agent's leaf-pinned branch strategy.
 *
 * The agent handles one run at a time, against a single branch: the parent chain
 * from the run's triggering input back to the conversation root. This source
 * resolves that branch as a {@link BranchSource} for the run's paginating
 * `run.view` — a read-only {@link View} over the same base the client uses. The
 * input-event watcher calls {@link LeafBranchSource.setPin} the moment the
 * trigger folds in (which may be before `Run.start()`, when the caller pages
 * `run.view` first), fixing the branch `run.view` projects; before that
 * `run.view` is empty. It then pages history like the client, via the one
 * history driver — `run.view.loadOlder()`.
 *
 * It does NOT own the Tree — the session owns it and swaps it on channel
 * continuity loss, so this reads it through the `getTree()` live accessor rather
 * than a captured reference, observing a swap instead of holding the abandoned
 * instance.
 *
 * The branch is a linear parent walk, so flattening is a plain concatenation
 * (truncated before the regenerate target where one is set) — there is no
 * sibling/regenerate collapse to apply, unlike the client's navigable source.
 *
 * Ancestor turns whose run did not complete successfully — still streaming,
 * suspended, cancelled, or errored — are omitted from the branch: such a run can
 * hold an assistant tool call with no matching tool result, which the model
 * provider rejects when it reaches the prompt. The current run (the leaf being
 * served) is always kept — see {@link LeafBranchSource.visibleNodes}.
 */

import type { Codec, CodecInputEvent, CodecMessage, CodecOutputEvent } from '../codec/types.js';
import type { BranchSource } from './branch-source.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type { ConversationNode, RunNode, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Ancestor-chain walk over the Tree
// ---------------------------------------------------------------------------

/**
 * Walk parent pointers from an anchor codec-message-id back through the Tree to
 * the conversation root, returning nodes in root-first (chronological) order.
 * Returns an empty array when the anchor isn't in the Tree.
 * @param tree - The materialisation tree to walk.
 * @param anchor - The codec-message-id to start from (typically the current run's input).
 * @returns Nodes from root to anchor in chronological order.
 */
const walkAncestorChain = <TOutput extends CodecOutputEvent, TProjection>(
  tree: Tree<TOutput, TProjection>,
  anchor: string | undefined,
): readonly ConversationNode<TProjection>[] => {
  if (anchor === undefined) return [];
  const chain: ConversationNode<TProjection>[] = [];
  let current = tree.getNodeByCodecMessageId(anchor);
  const seen = new Set<string>();
  while (current !== undefined) {
    // Defensive cycle guard — `parentCodecMessageId` chains should be DAGs;
    // a cycle indicates Tree corruption but we don't want to infinite-loop.
    const key = current.kind === 'run' ? current.runId : current.codecMessageId;
    if (seen.has(key)) break;
    seen.add(key);
    chain.unshift(current);
    const parentId = current.parentCodecMessageId;
    if (parentId === undefined) break;
    current = tree.getNodeByCodecMessageId(parentId);
  }
  return chain;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor dependencies for {@link LeafBranchSource}, injected by AgentSession
 * per run.
 *
 * The Tree is read through an accessor, not a captured reference: the session
 * swaps it on continuity loss, and the source must observe the swap.
 */
export interface LeafBranchSourceOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** Live accessor for the session's current materialisation Tree. */
  getTree: () => TreeInternal<TInput, TOutput, TProjection>;
  /** Codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
}

/**
 * The resolved leaf pin: the branch `run.view` projects. Set via
 * {@link LeafBranchSource.setPin} once the run's triggering input is matched on
 * the channel.
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
 * The agent's leaf-pinned {@link BranchSource}. See the file header for its role
 * driving the paginating `run.view`.
 */
export class LeafBranchSource<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements BranchSource<TProjection, TMessage> {
  private readonly _getTree: () => TreeInternal<TInput, TOutput, TProjection>;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;

  /**
   * The resolved branch `run.view` projects. `undefined` until the input-event
   * watcher matches the trigger and calls {@link setPin} — so `run.view` is
   * empty before then.
   */
  private _pin: LeafPin | undefined;
  /** Notifies the owning View to recompute; set by `createLeafView`. */
  private _notify: (() => void) | undefined;

  constructor(options: LeafBranchSourceOptions<TInput, TOutput, TProjection, TMessage>) {
    this._getTree = options.getTree;
    this._codec = options.codec;
  }

  /**
   * Pin `run.view` to the run's branch. Called by `AgentSession` from the
   * input-event watcher once the triggering input's headers are resolved (the
   * same anchor / run-id / regenerate-target the run's read-model uses). Nudges
   * the owning View to recompute, since a pin change is not itself a Tree event.
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

  /**
   * The full structural branch: the ancestor chain from the pin's anchor back to
   * the conversation root, plus the current run's node (the leaf) when the walk
   * didn't already reach it. Unfiltered — this is the branch's identity, used for
   * run lookup and sibling selection where a run's lifecycle status is
   * irrelevant. {@link visibleNodes} layers the prompt-safety filter on top.
   * @returns The branch nodes in root-first (chronological) order.
   */
  private _structuralBranch(): ConversationNode<TProjection>[] {
    const pin = this._pin;
    if (pin === undefined) return [];
    const tree = this._getTree();
    const chain = walkAncestorChain(tree, pin.anchor);
    const runNode = tree.getRunNode(pin.runId);
    // Append the current run's own node (the leaf) when the ancestor walk didn't
    // already reach it — it is the conversation tail, not ancestor context.
    if (runNode !== undefined && !chain.some((n) => n.kind === 'run' && n.runId === pin.runId)) {
      return [...chain, runNode];
    }
    return [...chain];
  }

  visibleNodes(): ConversationNode<TProjection>[] {
    const pin = this._pin;
    if (pin === undefined) return [];

    // The current run's node — the leaf we are serving — is normally keyed by
    // `pin.runId`. A client tool-result FORK is the exception: it is served
    // `run.view`-first (the caller pages `loadUntil`/`loadOlder` to bring the
    // trigger in) BEFORE `run.start()` reconciles the optimistic fork run onto
    // the agent-minted run-id. Until that reconciliation the fork run is keyed by
    // its trigger's codec-message-id (`pin.anchor`), not `pin.runId`, so a
    // `pin.runId` match alone would miss it. Resolve the leaf's live key off
    // `pin.anchor` too — only a fork's trigger backs a run node (a fresh send
    // backs an input node, a regenerate carrier backs none) — so the fork is
    // recognised as the current run and exempted from the incomplete-ancestor
    // drop below; otherwise it and its input are dropped and the prompt comes
    // back empty (AIT-1144).
    const anchorNode = pin.anchor === undefined ? undefined : this._getTree().getNodeByCodecMessageId(pin.anchor);
    const leafRunId = anchorNode?.kind === 'run' ? anchorNode.runId : undefined;

    // Omit ancestor turns whose run did not complete successfully. An incomplete
    // run — one still streaming, suspended awaiting a client tool result, or
    // cancelled/errored mid-call — can carry an assistant tool call with no
    // matching tool result; flattened into the prompt, the model provider
    // rejects the whole request. We drop such a run together with the user input
    // it replied to (its `parentCodecMessageId`), so the prompt stays a clean
    // user/assistant sequence rather than carrying an orphaned input. Read off
    // live `RunNode.state` on every call, so a run that later completes reappears
    // and a late history re-walk cannot reintroduce a still-incomplete one. The
    // current run (`pin.runId`, or `leafRunId` for a pre-reconciliation fork) is
    // exempt — it is the leaf we are serving, its own as-yet-unresolved work is
    // expected and its resolutions are applied before the prompt is built — so
    // its input (`pin.anchor`) is never dropped. Two passes, and they must stay
    // separate: the branch is root-first so an input precedes the run that
    // replied to it, and pass two can only drop an input once pass one has
    // collected every dropped run's `parentCodecMessageId`.
    const droppedInputIds = new Set<string>();
    const withoutIncompleteRuns = this._structuralBranch().filter((node) => {
      if (
        node.kind !== 'run' ||
        node.runId === pin.runId ||
        node.runId === leafRunId ||
        node.state.status === 'complete'
      )
        return true;
      if (node.parentCodecMessageId !== undefined) droppedInputIds.add(node.parentCodecMessageId);
      return false;
    });
    return withoutIncompleteRuns.filter((node) => !(node.kind === 'input' && droppedInputIds.has(node.codecMessageId)));
  }

  extractMessages(
    nodes: ConversationNode<TProjection>[],
    getMessages: (node: ConversationNode<TProjection>) => CodecMessage<TMessage>[] = (n) =>
      this._codec.getMessages(n.projection),
  ): CodecMessage<TMessage>[] {
    // Linear parent walk — plain concatenation, no sibling/regenerate collapse.
    // Stop before the regenerate target (where set) so the reconstructed history
    // ends on the message the agent is about to replace, not on it.
    const regenerateTarget = this._pin?.regenerateTarget;
    const out: CodecMessage<TMessage>[] = [];
    for (const node of nodes) {
      for (const m of getMessages(node)) {
        if (regenerateTarget !== undefined && m.codecMessageId === regenerateTarget) return out;
        out.push(m);
      }
    }
    return out;
  }

  selectedReplyRun(inputCodecMessageId: string): RunNode<TProjection> | undefined {
    const replies = this._getTree().getReplyRuns(inputCodecMessageId);
    if (replies.length <= 1) return replies[0];
    // Prefer the reply run on this leaf's branch; otherwise the latest. Resolve
    // against the structural branch, not the prompt-filtered `visibleNodes()` —
    // an incomplete reply is still the one structurally on this branch, so branch
    // identity must not shift just because that reply hasn't completed yet.
    const onBranch = new Set(this._structuralBranch().map((n) => nodeKey(n)));
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
