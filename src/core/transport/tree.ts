/**
 * Tree — materializes a branching conversation as a forest of nodes. Each turn
 * is two nodes: a user {@link InputNode} keyed by its client-owned
 * codec-message-id and an agent {@link RunNode} keyed by the agent-minted
 * run-id, parented to the input node.
 *
 * Each node holds a per-node codec {@link TProjection} which the Tree folds
 * from inbound events. The Tree owns the complete conversation state across
 * every observed node. The {@link View} walks the parent chain to extract a
 * flat message list for rendering.
 *
 * `applyMessage()` is the entry point for inbound channel messages — it
 * classifies a run-less user input into an input node (keyed by
 * codec-message-id) or routes a run-bearing wire to its reply run (keyed by
 * run-id), folds events into that node's projection, and maintains a secondary
 * `codecMessageId -> nodeKey` index. `applyRunLifecycle()` handles run-start /
 * run-suspend / run-resume / run-end events.
 *
 * Sibling structure: editing a prompt produces a sibling input node linked by
 * {@link InputNode.forkOf}; regenerating a reply produces a sibling reply run
 * sharing the same input-node parent (no fork-of).
 */

import type * as Ably from 'ably';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_START_SERIAL,
  HEADER_STEP_ID,
  HEADER_STREAM,
} from '../../constants.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import { toCodecEvents } from '../codec/codec-event.js';
import type { CodecEvent, CodecInputEvent, CodecOutputEvent, Reducer } from '../codec/types.js';
import type {
  ConversationNode,
  InputNode,
  OutputEvent,
  RunLifecycleEvent,
  RunNode,
  StepEndReason,
  StepInfo,
  StepLifecycleEvent,
  Tree,
} from './types.js';
import { WireLog } from './wire-log.js';

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

/**
 * How long (in ms, on the Ably message-timestamp timeline) a structurally
 * complete run's event log is retained after the node's last observed
 * activity. Bounds cross-publisher live delivery reorder: a wire can be
 * delivered after a higher-serial wire by at most this window. Conservative
 * placeholder pending confirmation of the actual cross-region bound.
 */
export const REORDER_WINDOW_MS = 120_000;

/**
 * Per-step precedence record on a run node. Tracks the canonical attempt (the
 * one whose `ai-step-start` has the latest serial — its `start-serial`) and
 * every attempt seen, so the read-model and the fold gate can be derived. The
 * canonical attempt's output is the only one folded into the run's projection.
 */
interface StepRecord {
  /**
   * Whether any `ai-step-start` has been observed for this step. Distinguishes
   * "no start seen yet" (a step known only from an out-of-order step-end or
   * output) from a canonical attempt whose `start-serial` happens to be
   * `undefined` (a serial-less optimistic seed).
   */
  started: boolean;
  /**
   * The canonical attempt's `start-serial` (the serial of its latest-serial
   * `ai-step-start`) — the attempt's identity — or `undefined` for a serial-less
   * optimistic seed (the agent's own pre-echo start) or before any start is
   * seen. An undefined serial sorts lowest, so any concrete-serial start
   * promotes/supersedes it.
   */
  canonicalStartSerial: string | undefined;
  /**
   * The canonical attempt's `step-client-id` (the step's participant), surfaced
   * on {@link StepInfo.stepClientId}. Set from the canonical `ai-step-start`, so
   * it tracks the canonical attempt across supersedes. `undefined` until a
   * `step-start` is seen (a step seen only via an out-of-order step-end).
   */
  stepClientId: string | undefined;
  /**
   * Every `start-serial` seen for this step — from step-starts (their own
   * serial) and step-ends (their back-ref). Its size is the read-model attempt
   * count (distinct physical attempts).
   */
  startSerials: Set<string>;
  /** Terminal reason per `start-serial`, from `ai-step-end`. The read-model status reads the canonical attempt's entry. */
  endReasonByStartSerial: Map<string, StepEndReason>;
}

/**
 * A run node's step-precedence state. Allocated lazily on the first step event
 * or step-attributed output — run-less input nodes never carry it, so the fold
 * gate is the identity for them (behaviour-preserving for stepless runs).
 */
interface StepState {
  /** stepId -> its {@link StepRecord}. */
  steps: Map<string, StepRecord>;
  /** stepIds in first-observed order, for the {@link RunNode.steps} read-model. */
  order: string[];
  /** Output wire serial -> the step/attempt (by `start-serial`) that published it (read from the output's headers). Drives the fold gate. */
  attribution: Map<string, { stepId: string; startSerial: string }>;
  /** stepId -> the set of attempt `start-serial`s that have published (attributed) output. Drives the refold-on-supersede trigger. */
  outputAttempts: Map<string, Set<string>>;
}

interface InternalNode<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection> {
  node: ConversationNode<TProjection>;
  /** Insertion sequence — tiebreaker for nodes with no sort serial (optimistic). */
  insertSeq: number;
  /**
   * The node's event log: every serial-bearing wire applied to this node, in
   * canonical serial order. Owns its own record/refold/replay-guard/sweep
   * mutation (see {@link WireLog}). Optimistic (serial-less) applies are not
   * recorded.
   */
  log: WireLog<CodecEvent<TInput, TOutput>>;
  /**
   * Max Ably message timestamp (epoch ms) of everything applied to this node,
   * including its run lifecycle events; 0 until a timestamped apply. The
   * retention sweep measures {@link REORDER_WINDOW_MS} from here.
   */
  lastActivityTs: number;
  /**
   * Whether this run's `ai-run-start` has been observed (run nodes only —
   * always false for input nodes). The structural half of log retention:
   * run-start is the run's serial floor, so once it is observed no older
   * history page can deliver further wires for this node.
   */
  runStartSeen: boolean;
  /** Whether this node is already queued for sweeping (guards double-enqueue). */
  sweepQueued: boolean;
  /**
   * Whether an optimistic (serial-less) seed has been folded into the
   * projection but not into the log. The first serial-bearing wire (the echo)
   * refolds the node from the log alone, discarding the seed, then clears
   * this — so a codec needs no seed-replacement logic of its own.
   */
  optimistic: boolean;
  /**
   * Step-precedence state — present only on run nodes that have observed a
   * step event or step-attributed output (lazily allocated). Run-less input
   * nodes never carry it: the fold gate treats a node with no `stepState` (and
   * any serial with no attribution entry) as ungated, so stepless runs and
   * input nodes fold identically to before steps existed.
   */
  stepState?: StepState;
}

/**
 * The primary key a node is indexed under: a reply run's `runId`, or an input
 * node's `codecMessageId` (the client owns it before the agent mints a runId).
 * @param node - The node to key.
 * @returns The node's primary key.
 */
export const nodeKey = <TProjection>(node: ConversationNode<TProjection>): string =>
  node.kind === 'run' ? node.runId : node.codecMessageId;

/**
 * The serial a node sorts by: a reply run's `startSerial`, an input node's
 * `serial`. Undefined for an optimistic (not-yet-acked) node, which tail-sorts.
 * @param node - The node to read.
 * @returns The sort serial, or undefined for an optimistic node.
 */
const sortSerial = <TProjection>(node: ConversationNode<TProjection>): string | undefined =>
  node.kind === 'run' ? node.startSerial : node.serial;

/**
 * Add a value to a `Map<K, Set<V>>`, creating the bucket Set on first use.
 * @param map - The Map to mutate.
 * @param key - The bucket key.
 * @param value - The value to add.
 */
const addToSetMap = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
};

/**
 * Remove a value from a `Map<K, Set<V>>`, dropping the bucket when it empties.
 * @param map - The Map to mutate.
 * @param key - The bucket key.
 * @param value - The value to remove.
 */
const deleteFromSetMap = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
};

// ---------------------------------------------------------------------------
// Internal interface — extended surface consumed by View / ClientSession
// ---------------------------------------------------------------------------

/** Internal tree surface used by View and ClientSession — not part of the public Tree API. */
export interface TreeInternal<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
> extends Tree<TOutput, TProjection> {
  /**
   * Walk the visible node chain (both input nodes and reply runs) along the
   * selected branches, in chronological order. The View renders from this.
   * @param selections - Per-group selected member key, keyed by group root.
   * @returns The visible nodes in chronological order.
   */
  visibleNodes(selections?: Map<string, string>): ConversationNode<TProjection>[];

  /**
   * Get the "group root" key for a sibling group — the stable key the
   * selection map is keyed by (the earliest edit version for input nodes, the
   * original reply for a regenerate group).
   */
  getGroupRoot(key: string): string;

  /**
   * The reply runs parented at an input node (its codec-message-id), in
   * iteration order. Empty when none have been observed. Used to resolve a
   * user prompt to its reply run(s).
   * @param inputCodecMessageId - The input node's codec-message-id.
   * @returns The reply runs parented at that input.
   */
  getReplyRuns(inputCodecMessageId: string): RunNode<TProjection>[];

  /**
   * Apply an inbound channel message to the tree.
   *
   * Classifies the message and routes it to the owning node:
   * 1. Run-less user input (no run-id, a `user`-role message carrying a
   *    codec-message-id and input events): creates or promotes the input node
   *    keyed by that codec-message-id, folds the input events.
   * 2. Run-bearing wire (assistant output, continuation tool-resolution, or a
   *    fresh agent-minted run): routes to the reply run by run-id (reconciling
   *    an optimistic insert by codec-message-id), folds events.
   * @param events - Decoded codec events, split by wire direction. Both are
   *   folded into the node's projection, inputs first.
   * @param events.inputs - Client-published events (`ai-input` wire).
   * @param events.outputs - Agent-published events (`ai-output` wire).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   * @param timestamp - Ably server timestamp (epoch ms) of the message —
   *   top-level `Message.timestamp`, the message's create time on every
   *   delivery (an append's own receive time lives in `version.timestamp`) —
   *   or undefined for optimistic inserts. Advances the Tree's event-log
   *   retention clock and the owning node's last-activity time.
   * @param version - The delivery's `Message.version.serial`, or undefined
   *   when the delivery carried none (optimistic inserts, never-mutated
   *   deliveries from sources that omit it). Guards the node's event log
   *   against whole-wire replays: a delivery at or below the version already
   *   decoded into its log entry is dropped.
   */
  applyMessage(
    events: { inputs: TInput[]; outputs: TOutput[] },
    headers: Record<string, string>,
    serial?: string,
    timestamp?: number,
    version?: string,
  ): void;

  /**
   * Apply a run-lifecycle event.
   *
   * - `start`: creates the reply run (if missing) or, for an existing run,
   *   sets RunNode.state to 'active', promotes startSerial, and backfills
   *   structural metadata (parent / forkOf / regenerates / invocationId).
   * - `suspend`: sets RunNode.state to 'suspended' and records `endSerial`.
   *   The run stays live so a resume under the same `runId` picks up where it
   *   left off.
   * - `resume`: re-activates an existing suspended Run (state back to
   *   'active') without touching its structure or serials — a pure re-entry
   *   signal. A no-op if the Run is not yet known.
   * - `end`: sets RunNode.state to the terminal reason and records
   *   `endSerial`.
   *
   * Always emits a 'run' event to subscribers.
   * @param event - Lifecycle event payload, including the channel serial.
   */
  applyRunLifecycle(event: RunLifecycleEvent): void;

  /**
   * Apply a step-lifecycle event (`step-start` / `step-end`) to its run node.
   *
   * - `step-start`: records the attempt and, when its serial is the latest for
   *   the step, makes it the canonical attempt. If that supersedes a different
   *   attempt whose output is already folded, the run node is refolded so only
   *   the canonical attempt's output remains in the projection, and a
   *   projection-changed `output` event (empty `events`) is emitted so the View
   *   repaints. Creates a bare run node if none exists yet (the run-start /
   *   output wires backfill its structure), so precedence is correct regardless
   *   of arrival order.
   * - `step-end`: records the attempt's terminal reason for the read-model.
   *
   * Updates the run node's {@link RunNode.steps} read-model. A `step-end` for an
   * unknown run is a no-op (mirroring `run-end`); a `step-start` for an unknown
   * run creates the node.
   * @param event - The step-lifecycle event payload, including the channel serial.
   */
  applyStepLifecycle(event: StepLifecycleEvent): void;

  /**
   * Get the node keyed by `key`, or undefined if `key` names no node. The
   * key is a {@link nodeKey} — a runId (reply run) or an input node's
   * codec-message-id — so the result is a {@link ConversationNode} union:
   * narrow on `kind` before reading kind-specific fields. Pairs with
   * {@link getNodeByCodecMessageId}, which resolves an arbitrary owned
   * codec-message-id (including an assistant message's) to its node.
   * @param key - The node key to look up.
   * @returns The node, or undefined if not found.
   */
  getNode(key: string): ConversationNode<TProjection> | undefined;

  /**
   * Remove a node from the tree by its key ({@link nodeKey} — a runId or an
   * input node's codec-message-id). Children become unreachable because their
   * parent is no longer on the active path.
   * @param key - The node key to remove.
   */
  delete(key: string): void;

  /** Forward a raw Ably message event to tree subscribers. */
  emitAblyMessage(msg: Ably.InboundMessage): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** EventEmitter events map for the tree. */
interface TreeEventsMap<TOutput extends CodecOutputEvent> {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
  output: OutputEvent<TOutput>;
}

// Spec: AIT-CT13
export class DefaultTree<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
> implements TreeInternal<TInput, TOutput, TProjection> {
  private readonly _codec: Reducer<CodecEvent<TInput, TOutput>, TProjection>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<TreeEventsMap<TOutput>>;

  /**
   * All nodes indexed by their primary key ({@link nodeKey}): a reply run's
   * runId, or an input node's codec-message-id.
   */
  private readonly _nodeIndex = new Map<string, InternalNode<TInput, TOutput, TProjection>>();

  /**
   * Maps every observed `codec-message-id` to its owning node's key
   * ({@link nodeKey}). For a reply run that is the runId of every message the
   * run published; for an input node it is the input's own codec-message-id.
   * Resolves fork-of / parent codec-message-ids to node keys, routes
   * continuation amend wires to existing nodes, and backs UI lookups that hold
   * a codec-message-id.
   */
  private readonly _codecMessageIdToNodeKey = new Map<string, string>();

  /**
   * All nodes sorted by their sort serial ({@link sortSerial}: `startSerial`
   * for runs, `serial` for input nodes), lexicographically. Nodes with no sort
   * serial (optimistic) sort after all serial-bearing nodes, ordered among
   * themselves by insertion sequence.
   */
  private readonly _sortedNodes: InternalNode<TInput, TOutput, TProjection>[] = [];

  /**
   * Parent index: parent node key (the key its children's
   * `parentCodecMessageId` resolves to) to the set of child node keys. Root
   * nodes (no parent) are indexed under the key `undefined`. Kind-blind — a
   * reply run and an input node parent off each other through the same index.
   */
  private readonly _parentIndex = new Map<string | undefined, Set<string>>();

  /**
   * Reverse edge: an input node's codec-message-id to the set of reply-run ids
   * parented at it. Lets the View resolve a user prompt to its (selected) reply
   * run, and groups regenerate siblings (which all parent at the same input
   * node).
   */
  private readonly _replyRunsByInput = new Map<string, Set<string>>();

  /** Monotonically increasing counter for insertion sequence. */
  private _seqCounter = 0;

  /** Incremented on structural changes; unchanged on projection-only updates. */
  private _structuralVersion = 0;

  /**
   * Cached sibling-group lookups keyed by node key. The walk over forkOf
   * chains and the per-parent fan-out are pure functions of the node
   * graph, so the cache is keyed against {@link _structuralVersion}:
   * any topology mutation drops the cache and the next lookup
   * recomputes. Hits matter most during a single render pass where
   * the View calls `getSiblingNodes` once per visible node plus extra
   * per-message branch-anchor probes from React components.
   */
  private _siblingCache = new Map<string, InternalNode<TInput, TOutput, TProjection>[]>();
  private _siblingCacheVersion = -1;

  /**
   * Index from `event-id` header to the raw Ably message that carried it.
   * Populated incrementally as messages arrive via {@link emitAblyMessage};
   * reads back the raw message for the agent's input-event lookup
   * ({@link findAblyMessageByEventId}). Bounded by the Tree's lifetime — cleared
   * when the Tree is replaced on continuity loss / session close.
   */
  private readonly _eventIdIndex = new Map<string, Ably.InboundMessage>();

  /**
   * Event-log retention logical clock: the max Ably message timestamp (epoch
   * ms) observed across every apply, 0 until the first timestamped one. Only
   * ever advances — older-page history application carries smaller timestamps
   * and leaves it (and therefore the sweep) untouched.
   */
  private _clock = 0;

  /**
   * Keys of structurally complete run nodes (run-start and run-end both
   * observed) whose event logs await the retention window, in completion
   * order. Drained from the front whenever {@link _clock} advances; sweeping
   * only at clock advances keeps a history page's batch atomic — applying an
   * older page can never advance the clock, so a node cannot be swept between
   * its run-start and the rest of its wires in the same page.
   */
  private readonly _sweepQueue: string[] = [];

  /**
   * Window (ms, on the Ably message-timestamp timeline) a structurally complete
   * run's event log is retained after the node's last activity, before the
   * sweep may drop it. Defaults to {@link REORDER_WINDOW_MS}; an injected value
   * raises it for a long-backoff durable agent or lowers it for deterministic
   * tests (see {@link createTree}).
   */
  private readonly _reorderWindowMs: number;

  constructor(
    codec: Reducer<CodecEvent<TInput, TOutput>, TProjection>,
    logger: Logger,
    reorderWindowMs: number = REORDER_WINDOW_MS,
  ) {
    this._codec = codec;
    this._logger = logger;
    this._reorderWindowMs = reorderWindowMs;
    this._emitter = new EventEmitter<TreeEventsMap<TOutput>>(logger);
  }

  // -------------------------------------------------------------------------
  // Sorted list maintenance
  // -------------------------------------------------------------------------

  /**
   * Compare two nodes (Run or input) for sorted list ordering.
   * Serial-bearing nodes sort by their sort serial (`startSerial` for runs,
   * `serial` for input nodes), lexicographically.
   * Nodes with no sort serial sort after all serial-bearing nodes.
   * Among them, sort by insertion sequence.
   *
   * Optimistic (null-serial) nodes intentionally tail-sort so they reorder
   * into place when the server relay arrives and `applyMessage` promotes
   * startSerial — see {@link applyMessage}'s `_removeSortedNode` /
   * `_insertSortedNode` pair on the promotion path.
   * @param a - First node to compare.
   * @param b - Second node to compare.
   * @returns Negative if a sorts before b, positive if after, zero if equal.
   */
  // Spec: AIT-CT13a
  private _compareNodes(
    a: InternalNode<TInput, TOutput, TProjection>,
    b: InternalNode<TInput, TOutput, TProjection>,
  ): number {
    const sa = sortSerial(a.node);
    const sb = sortSerial(b.node);
    if (sa === undefined && sb === undefined) return a.insertSeq - b.insertSeq;
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.insertSeq - b.insertSeq;
  }

  /**
   * Insert a node into the sorted list at the correct position via binary search.
   * @param internal - The node to insert.
   */
  private _insertSortedNode(internal: InternalNode<TInput, TOutput, TProjection>): void {
    const startSerial = sortSerial(internal.node);

    // Fast path: null-startSerial always appends to end.
    if (startSerial === undefined) {
      this._sortedNodes.push(internal);
      return;
    }

    let lo = 0;
    let hi = this._sortedNodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midNode = this._sortedNodes[mid];
      if (!midNode) break; // unreachable
      if (this._compareNodes(midNode, internal) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this._sortedNodes.splice(lo, 0, internal);
  }

  /**
   * Remove a node from the sorted list.
   * @param internal - The node to remove.
   */
  private _removeSortedNode(internal: InternalNode<TInput, TOutput, TProjection>): void {
    const idx = this._sortedNodes.indexOf(internal);
    if (idx !== -1) this._sortedNodes.splice(idx, 1);
  }

  /**
   * Insert a freshly-created node into the primary store, the parent index, and
   * the sorted list, then bump the structural version. Kind-specific secondary
   * indexing — the codec-message-id map for input nodes, the reply→input edge
   * for reply runs — is the caller's responsibility.
   * @param key - The node's primary key ({@link nodeKey}).
   * @param entry - The internal node to insert.
   * @param parentCodecMessageId - The node's structural parent, or undefined for a root.
   */
  private _insertNode(
    key: string,
    entry: InternalNode<TInput, TOutput, TProjection>,
    parentCodecMessageId: string | undefined,
  ): void {
    this._nodeIndex.set(key, entry);
    this._addToParentIndex(parentCodecMessageId, key);
    this._insertSortedNode(entry);
    this._structuralVersion++;
  }

  /**
   * Re-sort a node whose sort key just changed and bump the structural version.
   * The caller mutates the serial field (`serial` for input nodes, `startSerial`
   * for runs); this keeps the sorted list and version in step. Used on the
   * optimistic-serial promotion paths when the server relay/echo arrives.
   * @param entry - The internal node whose serial was just promoted.
   */
  private _promoteSerial(entry: InternalNode<TInput, TOutput, TProjection>): void {
    this._removeSortedNode(entry);
    this._insertSortedNode(entry);
    this._structuralVersion++;
  }

  /**
   * Fold a batch of events into a node's projection in place, isolating each
   * fold in a try/catch so a throwing reducer can't abort the rest of the batch
   * or the surrounding apply.
   * @param entry - The internal node whose projection is folded in place.
   * @param events - The decoded events to fold, in wire order.
   * @param serial - Ably channel serial; coerced to '' for an optimistic insert.
   * @param messageId - The reducer routing key (codec-message-id), or undefined.
   */
  private _foldInto(
    entry: InternalNode<TInput, TOutput, TProjection>,
    events: CodecEvent<TInput, TOutput>[],
    serial: string | undefined,
    messageId: string | undefined,
  ): void {
    // Step precedence gate: a wire whose attempt is a superseded (non-canonical)
    // step attempt is not folded. A wire with no attribution (every stepless
    // output, every input-node fold, and an optimistic serial-less seed) is
    // never gated — the predicate is the identity, so the path is unchanged.
    if (serial !== undefined && this._isGatedSerial(entry, serial)) return;
    for (const event of events) {
      try {
        entry.node.projection = this._codec.fold(entry.node.projection, event, { serial: serial ?? '', messageId });
      } catch (error) {
        this._logger.error('Tree._foldInto(); fold threw', { key: nodeKey(entry.node), messageId, err: error });
      }
    }
  }

  /**
   * Whether a wire's serial is a superseded (non-canonical) step attempt and so
   * must not fold. `true` only when `serial` is attributed to an attempt known
   * to be non-canonical for its step; `false` for an unattributed serial or a
   * step with no canonical attempt yet (folded optimistically, refolded out
   * later) — see {@link StepState}.
   * @param entry - The node the wire folds into.
   * @param serial - The wire's Ably serial.
   * @returns True when the wire is a superseded step attempt and must be skipped.
   */
  private _isGatedSerial(entry: InternalNode<TInput, TOutput, TProjection>, serial: string): boolean {
    const ss = entry.stepState;
    if (!ss) return false;
    const attr = ss.attribution.get(serial);
    if (!attr) return false;
    const rec = ss.steps.get(attr.stepId);
    if (rec?.canonicalStartSerial === undefined) return false;
    return attr.startSerial !== rec.canonicalStartSerial;
  }

  /**
   * Record a serial-bearing wire in the node's event log and fold it. Events
   * extending the log tail (the common case — in-order live delivery) fold
   * incrementally onto the existing projection, identical to a bare
   * {@link _foldInto}. Events that land earlier in the log (an earlier-serial
   * wire delivered late — cross-publisher reorder, or a history page applying
   * an older message after a newer one) cannot be folded incrementally without
   * corrupting serial order, so the node is refolded from the whole log via
   * {@link _refold}.
   *
   * Optimistic (serial-less) applies and empty event batches are not logged;
   * an optimistic seed folds into the projection but never into the log, and
   * marks the node `optimistic`. The first serial-bearing wire (the echo of
   * the optimistic input, which re-delivers the seeded content) refolds the
   * node from the log alone — rebuilding the projection without the seed
   * rather than folding the echo on top of it. The codec therefore never sees
   * the seed and its echo in one projection, and needs no seed-replacement
   * logic. The seed must be a faithful preview of the echo, since the echo's
   * content is what survives.
   *
   * Whole-wire replays are dropped at the log: each entry records the highest
   * `Message.version.serial` decoded into it (`decodedThrough`), so a
   * version-bearing delivery the entry has already incorporated — a second
   * hydration over a populated Tree, a remounted View's re-fetch, an agent
   * re-walk — records nothing and folds nothing. A newer version of a
   * discrete wire (an edited discrete) is likewise dropped; propagating edits
   * into projections is deliberately out of scope.
   * @param entry - The internal node whose log and projection are updated.
   * @param events - The decoded events to fold, in wire order.
   * @param serial - Ably channel serial; undefined for an optimistic insert.
   * @param messageId - The reducer routing key (codec-message-id), or undefined.
   * @param version - The delivery's `Message.version.serial`, or undefined.
   * @param streamed - Whether the delivery is part of a streamed wire.
   */
  private _recordAndFold(
    entry: InternalNode<TInput, TOutput, TProjection>,
    events: CodecEvent<TInput, TOutput>[],
    serial: string | undefined,
    messageId: string | undefined,
    version: string | undefined,
    streamed: boolean,
  ): void {
    // A serial-less optimistic seed (or an empty batch) is not logged. Fold it
    // in; a non-empty seed marks the node so its echo refolds the seed away.
    if (serial === undefined || events.length === 0) {
      if (serial === undefined && events.length > 0) entry.optimistic = true;
      this._foldInto(entry, events, serial, messageId);
      return;
    }

    const fold = entry.log.record(serial, messageId, events, version, streamed);
    if (fold === 'dropped') {
      // The version guard rejected a re-delivery the log already incorporated —
      // a whole-wire replay (second hydration, remount, agent re-walk, or a
      // `loadOlder()` re-applying a swept run's history) or an edit to a
      // discrete. Nothing to fold.
      this._logger.debug('Tree._recordAndFold(); version guard dropped re-delivered wire', {
        key: nodeKey(entry.node),
        serial,
        version,
        swept: entry.log.swept,
      });
      return;
    }
    if (entry.optimistic && !entry.log.swept) {
      // First serial-bearing wire (the echo) on a node that carries an
      // optimistic seed. The seed is in the projection but not the log, so
      // refold from the log alone — the echo re-delivers the seeded content —
      // rebuilding the projection without the seed instead of folding the echo
      // on top of it.
      entry.optimistic = false;
      this._refold(entry);
      return;
    }
    if (fold === 'refold') {
      this._refold(entry);
      return;
    }
    // 'incremental'. On a swept log this is a genuinely-new wire outside the
    // reorder window (it should not occur) folding in arrival order — the log
    // could not refold it.
    if (entry.log.swept) {
      this._logger.warn('Tree._recordAndFold(); late wire after log retention window; folding in arrival order', {
        key: nodeKey(entry.node),
        serial,
      });
    }
    this._foldInto(entry, events, serial, messageId);
  }

  /**
   * Rebuild a node's projection from its event log in canonical serial order:
   * a fresh {@link Reducer.init} folded through every logged event, each with
   * its own wire's serial and messageId. Used when a late, earlier-serial wire
   * makes incremental folding unsound. Reducer purity (a fold is a function of
   * its inputs alone) is what makes the rebuild faithful; the per-fold
   * try/catch mirrors {@link _foldInto} so one throwing event can't abort the
   * rebuild.
   *
   * Rebuilds the projection only; the surrounding apply emits its usual
   * `output` event carrying just the triggering wire's events. Consumers read
   * the rebuilt state from `node.projection` (the View recomputes its message
   * list from it), so on the refold path the event's `events` payload is not a
   * delta of the full projection change.
   * @param entry - The internal node whose projection is rebuilt in place.
   */
  private _refold(entry: InternalNode<TInput, TOutput, TProjection>): void {
    let projection = this._codec.init();
    entry.log.replay((event, serial, messageId) => {
      // Apply the same step-precedence gate as the incremental path so a
      // rebuild drops superseded attempts' output (the serial is always defined
      // here — the log only retains serial-bearing wires).
      if (this._isGatedSerial(entry, serial)) return;
      try {
        projection = this._codec.fold(projection, event, { serial, messageId });
      } catch (error) {
        this._logger.error('Tree._refold(); fold threw', { key: nodeKey(entry.node), messageId, err: error });
      }
    });
    entry.node.projection = projection;
  }

  // -------------------------------------------------------------------------
  // Event-log retention
  // -------------------------------------------------------------------------

  /**
   * Record activity on a node and advance the retention clock. Updates the
   * node's `lastActivityTs` and the Tree-wide `_clock` to the given timestamp
   * when it is newer; a clock advance drains the sweep queue. `undefined`
   * (an optimistic local apply) advances nothing.
   * @param entry - The node the activity belongs to.
   * @param timestamp - Ably message timestamp (epoch ms), or undefined.
   */
  private _recordActivity(entry: InternalNode<TInput, TOutput, TProjection>, timestamp: number | undefined): void {
    if (timestamp === undefined) return;
    if (timestamp > entry.lastActivityTs) entry.lastActivityTs = timestamp;
    if (timestamp > this._clock) {
      this._clock = timestamp;
      this._drainSweepQueue();
    }
  }

  /**
   * Queue a run node's event log for retention sweeping once the node is
   * structurally complete: its run-start (serial floor — no older history page
   * can add to it) and its run-end (no further agent output) have both been
   * observed. The actual drop happens in {@link _drainSweepQueue} once the
   * reorder window has also lapsed. No-op for input nodes (never swept — no
   * floor marker, and their logs are bounded by one user message), for nodes
   * already queued or swept, and while either marker is missing.
   *
   * An UNSETTLED step is a second floor alongside `runStartSeen`: a step whose
   * canonical attempt's `ai-step-start` was observed but whose matching
   * `ai-step-end` was not (its read-model status is `'active'`). A finite
   * window cannot cover a durable retry whose backoff exceeds it — if the
   * structurally-complete run were swept while a step is still open, a
   * much-later rescheduled `ai-step-start` (same stepId, higher serial) would
   * hit the swept-log path and the dead attempt's partial output would
   * over-retain. So refusing to queue while any step is unsettled keeps the log
   * superseder-ready until {@link applyStepLifecycle} re-queues the node when
   * that last open step settles. Called from the run-end / run-start lifecycle
   * paths AND from a step-end (the re-queue trigger).
   * @param entry - The node to consider for sweeping.
   */
  private _maybeQueueSweep(entry: InternalNode<TInput, TOutput, TProjection>): void {
    const node = entry.node;
    if (node.kind !== 'run') return;
    if (entry.log.swept || entry.sweepQueued) return;
    if (!entry.runStartSeen) return;
    if (node.state.status === 'active' || node.state.status === 'suspended') return;
    if (this._hasUnsettledStep(entry)) return;
    entry.sweepQueued = true;
    this._sweepQueue.push(node.runId);
  }

  /**
   * Whether the node has any step whose canonical attempt has not settled — its
   * `ai-step-start` is recorded (`started` is set) but no matching `ai-step-end`
   * reason is, so its read-model status is `'active'`. The same predicate
   * {@link _updateStepsReadModel} derives a step's `'active'` status from, read
   * here as the sweep floor. A node with no step state has no step to be
   * unsettled, so this is `false` for stepless runs (behaviour-preserving).
   *
   * A canonical attempt with ANY observed end reason — including `failed` —
   * counts as settled here, deliberately. A retry after a clean `failed` end is
   * scheduled while the run is still `active`/`suspended`, so it is the
   * run-status floor (not this one) that holds the sweep across that retry; once
   * the workflow drives the run terminal it no longer retries that step, so the
   * canonical end is final and the run (e.g. a terminal `error`) is free to
   * sweep. This floor exists for the case the status floor cannot cover: a
   * canonical attempt with NO observed end whose run was driven terminal by a
   * separate cleanup, where a much-later rescheduled `ai-step-start` must still
   * find the dead attempt's log to supersede it.
   * @param entry - The run node to inspect.
   * @returns True when at least one observed step is still open.
   */
  private _hasUnsettledStep(entry: InternalNode<TInput, TOutput, TProjection>): boolean {
    const ss = entry.stepState;
    if (!ss) return false;
    for (const rec of ss.steps.values()) {
      if (!rec.started) continue;
      const settled =
        rec.canonicalStartSerial !== undefined &&
        rec.endReasonByStartSerial.get(rec.canonicalStartSerial) !== undefined;
      if (!settled) return true;
    }
    return false;
  }

  /**
   * Drop the event logs of queued nodes whose retention window has lapsed:
   * `lastActivityTs + _reorderWindowMs < _clock`. Drains from the front and
   * stops at the first node still inside the window — completion order is
   * time-ordered for live traffic, so this is amortised O(1) per apply, and
   * stopping early only ever over-retains (memory, never correctness). Called
   * only when the clock advances, so applying an older history page (smaller
   * timestamps) can never sweep mid-batch. Deleted nodes are skipped.
   */
  private _drainSweepQueue(): void {
    while (this._sweepQueue.length > 0) {
      const key = this._sweepQueue[0];
      const entry = key === undefined ? undefined : this._nodeIndex.get(key);
      if (!entry || entry.log.swept) {
        this._sweepQueue.shift();
        continue;
      }
      if (entry.lastActivityTs + this._reorderWindowMs >= this._clock) return;
      this._sweepQueue.shift();
      entry.sweepQueued = false;
      // Drop the decoded payloads (the unbounded cost) but keep each entry's
      // replay key, so a post-sweep whole-wire replay is still recognised and
      // dropped rather than re-folded (a refold can no longer rebuild them).
      entry.log.sweep();
      this._logger.debug('Tree._drainSweepQueue(); dropped event-log payloads, kept replay keys', {
        key,
        lastActivityTs: entry.lastActivityTs,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Parent index maintenance
  // -------------------------------------------------------------------------

  private _addToParentIndex(parentNodeKey: string | undefined, childKey: string): void {
    addToSetMap(this._parentIndex, parentNodeKey, childKey);
  }

  private _removeFromParentIndex(parentNodeKey: string | undefined, childKey: string): void {
    deleteFromSetMap(this._parentIndex, parentNodeKey, childKey);
  }

  /**
   * Resolve a node's structural parent to the parent node's key
   * ({@link nodeKey}), or undefined for a root. The parent is named by a
   * codec-message-id (`parentCodecMessageId`); this maps it through the
   * codec-message-id index to the owning node's key (a runId for a reply run,
   * a codec-message-id for an input node). Returns undefined when the parent
   * hasn't been observed yet (the node is treated as a root until it arrives).
   * @param node - The node whose parent to resolve.
   * @returns The parent node's key, or undefined.
   */
  private _parentKeyOf(node: ConversationNode<TProjection>): string | undefined {
    const parentCodecMessageId = node.parentCodecMessageId;
    return parentCodecMessageId === undefined ? undefined : this._codecMessageIdToNodeKey.get(parentCodecMessageId);
  }

  // -------------------------------------------------------------------------
  // Sibling grouping
  // -------------------------------------------------------------------------

  /**
   * Walk an input node's `forkOf` chain to the group root — the earliest edit
   * version sharing the same structural parent. Stops at a missing target, a
   * non-input target, a parent mismatch, or a cycle.
   * @param node - The input node to walk from.
   * @returns The group-root input node (the node itself when it is the root).
   */
  private _inputGroupRoot(node: InputNode<TProjection>): InputNode<TProjection> {
    let current = node;
    const visited = new Set<string>([nodeKey(current)]);
    while (current.forkOf !== undefined) {
      if (visited.has(current.forkOf)) break;
      const forkTarget = this._nodeIndex.get(current.forkOf);
      if (forkTarget?.node.kind !== 'input' || forkTarget.node.parentCodecMessageId !== current.parentCodecMessageId) {
        break;
      }
      current = forkTarget.node;
      visited.add(nodeKey(current));
    }
    return current;
  }

  /**
   * Get the sibling group that the node keyed by `key` belongs to. Kind-split:
   *
   * - **Reply runs** — every reply run sharing the same input-node parent is a
   *   sibling (the original reply + its regenerators all parent at the same
   *   input node M_user). No fork-of involved.
   * - **Input nodes** — edit versions: nodes sharing a parent AND linked by a
   *   `forkOf` chain to the group root.
   *
   * Returned ordered by startSerial (original/oldest first). A group of one is
   * returned as a single-element array (no branching).
   * @param key - The node key ({@link nodeKey}) to look up the group for.
   * @returns The ordered list of sibling nodes.
   */
  // Spec: AIT-CT13b
  private _getSiblingGroup(key: string): InternalNode<TInput, TOutput, TProjection>[] {
    if (this._siblingCacheVersion !== this._structuralVersion) {
      this._siblingCache.clear();
      this._siblingCacheVersion = this._structuralVersion;
    }
    const cached = this._siblingCache.get(key);
    if (cached) return cached;

    const entry = this._nodeIndex.get(key);
    if (!entry) return [];

    // The "original" anchors the group's parent + kind. For an input node,
    // walk the forkOf chain to the earliest version sharing the parent; for a
    // reply run the node itself anchors (all same-parent runs are siblings).
    let original = entry.node;
    if (original.kind === 'input') {
      original = this._inputGroupRoot(original);
    }

    // `_parentIndex` is keyed by the raw structural `parentCodecMessageId` (not
    // the resolved parent node key) so a run observed before its input node
    // still files/groups correctly — the parent codec-message-id is known at
    // creation, the resolved key may not be.
    const parentKey = original.parentCodecMessageId;
    const siblings: InternalNode<TInput, TOutput, TProjection>[] = [];
    const candidateKeys = this._parentIndex.get(parentKey);
    if (candidateKeys) {
      for (const childKey of candidateKeys) {
        const childEntry = this._nodeIndex.get(childKey);
        if (childEntry && this._isSiblingOf(childEntry.node, original)) {
          siblings.push(childEntry);
        }
      }
    }

    siblings.sort((a, b) => this._compareNodes(a, b));
    // Cache against the queried key AND every member of the group: a single
    // group is the same array regardless of which member triggered the lookup,
    // so subsequent queries against any member hit without recomputing.
    for (const sib of siblings) {
      this._siblingCache.set(nodeKey(sib.node), siblings);
    }
    this._siblingCache.set(key, siblings);
    return siblings;
  }

  /**
   * Whether `node` belongs to the sibling group anchored at `original`.
   * Requires the same kind and the same structural parent; reply runs need
   * nothing more (same-parent runs are regenerate siblings), input nodes must
   * additionally be forkOf-linked to the original (edit versions).
   * @param node - The candidate node.
   * @param original - The group's anchor node.
   * @returns True if `node` is a sibling of `original`.
   */
  private _isSiblingOf(node: ConversationNode<TProjection>, original: ConversationNode<TProjection>): boolean {
    if (node.kind !== original.kind) return false;
    if (node.parentCodecMessageId !== original.parentCodecMessageId) return false;
    // Same-parent reply runs are regenerate siblings — no fork-of needed.
    if (node.kind === 'run') return true;
    // Input nodes: must be forkOf-linked to the original (edit versions).
    const originalKey = nodeKey(original);
    if (nodeKey(node) === originalKey) return true;
    let current: ConversationNode<TProjection> = node;
    const visited = new Set<string>([nodeKey(current)]);
    while (current.kind === 'input' && current.forkOf !== undefined) {
      if (current.forkOf === originalKey) return true;
      if (visited.has(current.forkOf)) break;
      const target = this._nodeIndex.get(current.forkOf);
      if (!target) break;
      current = target.node;
      visited.add(nodeKey(current));
    }
    return false;
  }

  /**
   * Get the "group root" key for a sibling group — the stable key the
   * selection map is keyed by. For an input node (edit versions) that is the
   * earliest fork-of ancestor; for a reply run (regenerate group) it is the
   * oldest same-parent run (the original reply).
   * @param key - Any node key in the sibling group.
   * @returns The group root's key.
   */
  getGroupRoot(key: string): string {
    const entry = this._nodeIndex.get(key);
    if (!entry) return key;

    if (entry.node.kind === 'input') {
      return nodeKey(this._inputGroupRoot(entry.node));
    }

    // Reply run: the oldest same-parent run is the original reply.
    const group = this._getSiblingGroup(key);
    const root = group[0]?.node;
    return root ? nodeKey(root) : key;
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  /**
   * Walk the visible node chain along the selected branches, kind-blind. An
   * input node and a reply run reach each other through the same
   * parent-membership check, so seed-only user→user chains and the
   * input→reply→input weave both resolve here. Sibling groups (edit versions /
   * regenerate runs) collapse to the selected member.
   * @param selections - Per-group selected member key, keyed by group root.
   * @returns The visible nodes (both kinds) in chronological order.
   */
  visibleNodes(selections: Map<string, string> = new Map<string, string>()): ConversationNode<TProjection>[] {
    this._logger.trace('DefaultTree.visibleNodes();');
    const result: ConversationNode<TProjection>[] = [];
    const currentPath = new Set<string>();
    const resolvedGroups = new Map<string, string>(); // groupRootKey -> selected key

    for (const internal of this._sortedNodes) {
      const node = internal.node;
      const key = nodeKey(node);

      // Step 1: Parent reachability (kind-blind — the parent may be an input
      // node or a reply run; resolve its key and check the active path).
      const parentKey = this._parentKeyOf(node);
      if (parentKey !== undefined && !currentPath.has(parentKey)) {
        continue;
      }

      // Step 2: Sibling selection.
      const group = this._getSiblingGroup(key);
      if (group.length > 1) {
        const groupRootKey = this.getGroupRoot(key);
        let selectedKey = resolvedGroups.get(groupRootKey);
        if (selectedKey === undefined) {
          const preferredKey = selections.get(groupRootKey);
          if (preferredKey !== undefined && group.some((n) => nodeKey(n.node) === preferredKey)) {
            selectedKey = preferredKey;
          } else {
            const latest = group.at(-1);
            if (!latest) break; // unreachable: group.length > 1
            selectedKey = nodeKey(latest.node);
          }
          resolvedGroups.set(groupRootKey, selectedKey);
        }
        if (key !== selectedKey) {
          continue;
        }
      }

      currentPath.add(key);
      result.push(node);
    }

    return result;
  }

  getRunNode(runId: string): RunNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getRunNode();', { runId });
    const node = this._nodeIndex.get(runId)?.node;
    return node?.kind === 'run' ? node : undefined;
  }

  getNode(key: string): ConversationNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getNode();', { key });
    return this._nodeIndex.get(key)?.node;
  }

  getNodeByCodecMessageId(codecMessageId: string): ConversationNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getNodeByCodecMessageId();', { codecMessageId });
    const key = this._codecMessageIdToNodeKey.get(codecMessageId);
    return key === undefined ? undefined : this._nodeIndex.get(key)?.node;
  }

  getReplyRuns(inputCodecMessageId: string): RunNode<TProjection>[] {
    const runIds = this._replyRunsByInput.get(inputCodecMessageId);
    if (!runIds) return [];
    const result: RunNode<TProjection>[] = [];
    for (const runId of runIds) {
      const node = this._nodeIndex.get(runId)?.node;
      if (node?.kind === 'run') result.push(node);
    }
    return result;
  }

  getSiblingNodes(key: string): ConversationNode<TProjection>[] {
    this._logger.trace('DefaultTree.getSiblingNodes();', { key });
    return this._getSiblingGroup(key).map((n) => n.node);
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  applyMessage(
    events: { inputs: TInput[]; outputs: TOutput[] },
    headers: Record<string, string>,
    serial?: string,
    timestamp?: number,
    version?: string,
  ): void {
    const wireRunId = headers[HEADER_RUN_ID];
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];

    // Classify: with NO run-id, a user message carrying a codec-message-id and
    // at least one input event forms an INPUT node keyed by that
    // codec-message-id — the client owns it; the agent mints the reply run-id
    // separately. Everything else needs a run-id to route to a reply run.
    // Capturing the id (not a boolean) narrows it to `string` for the input path.
    const inputNodeCodecMessageId =
      wireRunId === undefined &&
      codecMessageId !== undefined &&
      headers[HEADER_ROLE] === 'user' &&
      events.inputs.length > 0
        ? codecMessageId
        : undefined;

    if (wireRunId === undefined && inputNodeCodecMessageId === undefined) {
      this._logger.warn('Tree.applyMessage(); message has no run-id and is not a user input; skipping');
      return;
    }

    // Fold inputs first, then outputs, preserving wire order.
    const all: CodecEvent<TInput, TOutput>[] = toCodecEvents(events);

    // Wire-only metadata-carrier messages (e.g. `ait-regenerate`) decode to
    // zero events and don't need a node at the tree level — the eventual reply
    // run is created later by run-start, and any regenerate / parent
    // information the wire carried is reread from the run-start headers.
    // Skipping here avoids a phantom node that would inflate sibling counts.
    const existingKey = inputNodeCodecMessageId ?? wireRunId;
    if (all.length === 0 && existingKey !== undefined && !this._nodeIndex.has(existingKey)) {
      return;
    }

    // `update` is the structural channel: emit it only when this apply
    // actually changes the tree shape (new node, startSerial promotion).
    // Content-only folds (streaming chunks into an existing node) flow through
    // `output` instead, so they leave `_structuralVersion` untouched.
    const structuralBefore = this._structuralVersion;

    if (inputNodeCodecMessageId !== undefined) {
      this._applyInputMessage(inputNodeCodecMessageId, headers, serial, timestamp, version, all);
    } else if (wireRunId !== undefined) {
      this._applyRunMessage(wireRunId, events, headers, serial, timestamp, version);
    }

    if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
  }

  /**
   * Apply a run-less user input wire: create (or promote the serial of) the
   * input node keyed by its codec-message-id, fold the input events into its
   * own projection, and emit an `output` event (with empty outputs — input
   * folds carry none) so the View observes the optimistic insert.
   * @param codecMessageId - The input node's codec-message-id (its primary key).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for an optimistic insert.
   * @param timestamp - Ably server timestamp (epoch ms); undefined for an optimistic insert.
   * @param version - The delivery's `Message.version.serial`, or undefined.
   * @param all - The direction-tagged input events to fold, in wire order.
   */
  private _applyInputMessage(
    codecMessageId: string,
    headers: Record<string, string>,
    serial: string | undefined,
    timestamp: number | undefined,
    version: string | undefined,
    all: CodecEvent<TInput, TOutput>[],
  ): void {
    let entry = this._nodeIndex.get(codecMessageId);
    if (!entry) {
      entry = this._createInputNodeFromHeaders(codecMessageId, headers, serial);
      this._insertNode(codecMessageId, entry, entry.node.parentCodecMessageId);
      this._codecMessageIdToNodeKey.set(codecMessageId, codecMessageId);
      this._logger.debug('Tree.applyMessage(); created input node', { codecMessageId });
    } else if (entry.node.kind === 'input' && serial && !entry.node.serial) {
      // Promote optimistic serial when the relay/echo arrives.
      this._logger.debug('Tree.applyMessage(); promoting input serial', { codecMessageId, serial });
      entry.node.serial = serial;
      this._promoteSerial(entry);
    }

    this._recordActivity(entry, timestamp);

    // Log the wire and fold it — incrementally onto the tail in the common
    // case, or by refolding the node if this wire arrived out of serial order.
    this._recordAndFold(entry, all, serial, codecMessageId, version, headers[HEADER_STREAM] === 'true');

    // An input node owns no agent outputs; the event still fires (empty
    // outputs) so consumers observe the projection change. It has no run-id —
    // the causal routing key is the input's own codec-message-id.
    this._emitter.emit('output', {
      runId: undefined,
      inputCodecMessageId: codecMessageId,
      codecMessageId,
      serial,
      events: [],
      inputs: all.filter((e) => e.direction === 'input').map((e) => e.event),
    });
  }

  /**
   * Apply a reply-run wire (assistant output, continuation tool-resolution, or
   * a fresh run keyed by the agent-minted run-id): create or reconcile the run
   * node, fold its events, maintain the codec-message-id and reply→input
   * indices, and emit the `output` event. Derives the codec-message-id,
   * triggering-input id, fold list, and outputs from `events`/`headers`,
   * mirroring `applyMessage`.
   * @param wireRunId - The run-id from the inbound wire (the node's primary key).
   * @param events - The decoded inputs and outputs from the wire.
   * @param events.inputs - Client-published events (`ai-input` wire).
   * @param events.outputs - Agent-published events (`ai-output` wire).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for an optimistic insert.
   * @param timestamp - Ably server timestamp (epoch ms); undefined for an optimistic insert.
   * @param version - The delivery's `Message.version.serial`, or undefined.
   */
  private _applyRunMessage(
    wireRunId: string,
    events: { inputs: TInput[]; outputs: TOutput[] },
    headers: Record<string, string>,
    serial: string | undefined,
    timestamp: number | undefined,
    version: string | undefined,
  ): void {
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    // The triggering input's codec-message-id (the agent's echo), surfaced on
    // the `output` event as the stream's causal routing key.
    const inputCodecMessageId = headers[HEADER_INPUT_CODEC_MESSAGE_ID];
    // Fold inputs first, then outputs, preserving wire order.
    const all: CodecEvent<TInput, TOutput>[] = toCodecEvents(events);
    const outputs = events.outputs;

    let run = this._nodeIndex.get(wireRunId);

    // Reconcile an optimistic insert with its serial-bearing echo by
    // codec-message-id rather than the wire run-id — covers assistant content
    // that pins a codec-message-id before its run-id is indexed.
    if (!run && codecMessageId !== undefined) {
      const indexedKey = this._codecMessageIdToNodeKey.get(codecMessageId);
      const indexed = indexedKey === undefined ? undefined : this._nodeIndex.get(indexedKey);
      if (indexed?.node.kind === 'run' && indexed.node.startSerial === undefined) run = indexed;
    }

    if (!run) {
      run = this._createRunFromHeaders(wireRunId, headers, serial);
      this._insertNode(wireRunId, run, run.node.parentCodecMessageId);
      this._indexReplyRun(run.node, wireRunId);
      this._logger.debug('Tree.applyMessage(); created new Run', { runId: wireRunId });
    } else if (serial && run.node.kind === 'run' && !run.node.startSerial) {
      // Promote optimistic startSerial when the relay/echo arrives.
      this._logger.debug('Tree.applyMessage(); promoting startSerial', { runId: wireRunId, serial });
      run.node.startSerial = serial;
      this._promoteSerial(run);
    }

    // Index the codec-message-id against the node that actually owns it.
    const ownerKey = nodeKey(run.node);
    if (codecMessageId) this._codecMessageIdToNodeKey.set(codecMessageId, ownerKey);

    this._recordActivity(run, timestamp);

    // Record step attribution from the output's headers BEFORE the fold, so a
    // refold triggered by this same (out-of-order) wire sees its own attempt and
    // gates it correctly rather than folding it as stepless. Only agent outputs
    // carry step-id/start-serial; inputs and stepless outputs leave it unset.
    const stepId = headers[HEADER_STEP_ID];
    const startSerial = headers[HEADER_START_SERIAL];
    if (stepId !== undefined && startSerial !== undefined && serial !== undefined) {
      this._recordStepAttribution(run, serial, stepId, startSerial);
    }

    // Log the wire and fold it — incrementally onto the tail in the common
    // case, or by refolding the node if this wire arrived out of serial order.
    // `run` may be a reconciled optimistic node: record on whichever entry
    // owns the fold. The fold is gated (a superseded attempt's output is logged
    // but not folded).
    this._recordAndFold(run, all, serial, codecMessageId, version, headers[HEADER_STREAM] === 'true');

    // Suppress the `output` emit only for a known-superseded attempt (a
    // post-retry orphan); stepless output (no attribution) is never suppressed,
    // so the emit cadence the View and the Vercel run-output-stream depend on is
    // unchanged.
    if (serial === undefined || !this._isGatedSerial(run, serial)) {
      this._emitter.emit('output', {
        runId: ownerKey,
        inputCodecMessageId,
        codecMessageId,
        serial,
        events: outputs,
        inputs: events.inputs,
        ...(stepId !== undefined && { stepId }),
        ...(startSerial !== undefined && { startSerial }),
      });
    }
  }

  /**
   * Record a reply run against its input-node parent (the reverse edge powering
   * `getReplyRuns` and regenerate sibling grouping). A reply run's
   * `parentCodecMessageId` is its input node's codec-message-id (the master
   * invariant), so no resolution is needed.
   * @param node - The reply run node.
   * @param runId - The run's id.
   */
  private _indexReplyRun(node: ConversationNode<TProjection>, runId: string): void {
    if (node.parentCodecMessageId === undefined) return;
    addToSetMap(this._replyRunsByInput, node.parentCodecMessageId, runId);
  }

  applyRunLifecycle(event: RunLifecycleEvent): void {
    this._logger.trace('DefaultTree.applyRunLifecycle();', { type: event.type, runId: event.runId });
    // Structural channel: emit `update` only when the lifecycle event changes
    // the tree shape. Only run-start can do that (a new Run, startSerial
    // promotion, or structural-metadata backfill); suspend/resume/end mutate
    // status/endSerial on an existing node — content, not structure — so the
    // conditional naturally never fires for them.
    const structuralBefore = this._structuralVersion;
    switch (event.type) {
      case 'start': {
        this._applyRunStart(event);
        break;
      }
      case 'suspend': {
        this._applyRunSuspend(event);
        break;
      }
      case 'resume': {
        this._applyRunResume(event);
        break;
      }
      case 'end': {
        this._applyRunEnd(event);
        break;
      }
    }
    this._emitter.emit('run', event);
    if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
  }

  applyStepLifecycle(event: StepLifecycleEvent): void {
    this._logger.trace('DefaultTree.applyStepLifecycle();', {
      type: event.type,
      runId: event.runId,
      stepId: event.stepId,
    });

    // A step-start creates the run node if absent (like run-start / output
    // wires) so precedence is captured regardless of arrival order — a
    // step-start replayed from a newer history page before the run's other
    // wires must not be lost, or canonical attribution would be wrong. A
    // step-end for an unknown run is a no-op, mirroring run-end.
    const structuralBefore = this._structuralVersion;
    const entry =
      event.type === 'step-start' ? this._getOrCreateRunNodeForStep(event.runId) : this._nodeIndex.get(event.runId);
    if (entry?.node.kind !== 'run') return;
    const runNode = entry.node;
    this._recordActivity(entry, event.timestamp);

    const ss = (entry.stepState ??= this._newStepState());
    let rec = ss.steps.get(event.stepId);
    if (!rec) {
      rec = {
        started: false,
        canonicalStartSerial: undefined,
        stepClientId: undefined,
        startSerials: new Set(),
        endReasonByStartSerial: new Map(),
      };
      ss.steps.set(event.stepId, rec);
      ss.order.push(event.stepId);
    }

    // The attempt's identity is its `start-serial`: a step-start's own serial,
    // a step-end's back-ref. Count it only when defined — a serial-less
    // optimistic step-start seed has no identity to count yet (its concrete
    // echo will), so it must not inflate the attempt count.
    const startSerial = event.type === 'step-start' ? event.serial : event.startSerial;
    if (startSerial !== undefined) rec.startSerials.add(startSerial);

    if (event.type === 'step-start') {
      this._applyStepStart(entry, ss, rec, event.stepId, event.serial, event.stepClientId);
    } else {
      rec.endReasonByStartSerial.set(event.startSerial, event.reason);
    }

    this._updateStepsReadModel(runNode, ss);

    // A step lifecycle event may have settled the node's last open step: a
    // step-end records the canonical attempt's reason, and a reordered
    // step-start can advance the canonical to an attempt whose step-end was
    // already observed (end-before-start arrival across publishers). The sweep
    // floor in `_maybeQueueSweep` refuses to queue a run with any unsettled
    // step, so a run that went terminal while a step was still open was never
    // queued; this is the re-queue trigger that makes a now-fully-settled
    // terminal run sweep-eligible. Idempotent (guarded by `sweepQueued`/`swept`
    // and the terminal/run-start floors), so it no-ops on a non-terminal or
    // still-unsettled run regardless of which lifecycle event fired it.
    this._maybeQueueSweep(entry);

    // Only a freshly-created node bumps the structural version; the common
    // case (node already exists) changes step content only, repainted via the
    // supersede's empty-events `output` emit, not the structural channel.
    if (this._structuralVersion !== structuralBefore) this._emitter.emit('update');
  }

  /**
   * Build a fresh, empty {@link StepState}.
   * @returns A new step-state with empty maps.
   */
  private _newStepState(): StepState {
    return { steps: new Map(), order: [], attribution: new Map(), outputAttempts: new Map() };
  }

  /**
   * Apply a `step-start`'s canonical effect: when its serial is the latest seen
   * for the step, make it the canonical attempt, and if that supersedes a
   * different attempt whose output is already folded, refold the node to drop
   * the superseded output. The attempt's identity is its own `serial` (its
   * `start-serial`).
   * @param entry - The run node's internal entry.
   * @param ss - The node's step state.
   * @param rec - The step's record.
   * @param stepId - The step id.
   * @param serial - This `step-start`'s serial — the attempt's `start-serial`
   *   (undefined for an optimistic seed).
   * @param stepClientId - This `step-start`'s `step-client-id` (the step's
   *   participant), recorded on the record when the attempt becomes canonical so
   *   the read-model tracks the canonical attempt's client across supersedes.
   */
  private _applyStepStart(
    entry: InternalNode<TInput, TOutput, TProjection>,
    ss: StepState,
    rec: StepRecord,
    stepId: string,
    serial: string | undefined,
    stepClientId: string,
  ): void {
    // Latest-serial wins. An undefined serial sorts lowest (optimistic seed),
    // so the first start seen sets canonical and any concrete serial promotes
    // (the same attempt's echo) or supersedes (a later start) it.
    const isCanonical =
      !rec.started ||
      (rec.canonicalStartSerial === undefined && serial !== undefined) ||
      (rec.canonicalStartSerial !== undefined && serial !== undefined && serial > rec.canonicalStartSerial);
    rec.started = true;
    if (!isCanonical) return;

    rec.canonicalStartSerial = serial;
    rec.stepClientId = stepClientId;

    // Refold only when a different attempt's output is already folded (avoids a
    // refold on the common first-start-then-stream case, where the only
    // attributed attempt is the new canonical one). Every `ai-step-start` has a
    // distinct serial, so a re-stream under the same step-id always lands here
    // and supersedes the prior attempt's output cleanly.
    const attributed = ss.outputAttempts.get(stepId);
    if (attributed && [...attributed].some((s) => s !== serial)) {
      this._refoldForSupersede(entry);
    }
  }

  /**
   * Rebuild a run node's projection so a superseded attempt's output is dropped
   * (the gate now excludes it), then repaint via a projection-changed `output`
   * event (empty `events`). Guarded against a swept log, which can no longer be
   * rebuilt — there the superseded output is over-retained (a documented,
   * bounded gap) rather than blanking the projection.
   * @param entry - The run node whose projection to rebuild.
   */
  private _refoldForSupersede(entry: InternalNode<TInput, TOutput, TProjection>): void {
    if (entry.log.swept) {
      this._logger.warn(
        'DefaultTree.applyStepLifecycle(); superseding step-start after log sweep; superseded output over-retained',
        { key: nodeKey(entry.node) },
      );
      return;
    }
    this._refold(entry);
    // Projection-changed repaint over the CONTENT channel: the View's output
    // handler recomputes getMessages and re-emits its own structural update.
    // Deliberately not the structural `update` channel (a content-only change).
    this._emitter.emit('output', {
      runId: nodeKey(entry.node),
      inputCodecMessageId: undefined,
      codecMessageId: undefined,
      serial: undefined,
      events: [],
      inputs: [],
    });
  }

  /**
   * Record which step attempt published an output wire, keyed by the wire's
   * serial, plus the per-step set of attempt `start-serial`s that have published
   * output (the refold-on-supersede trigger). Allocates step state lazily.
   * @param entry - The run node's internal entry.
   * @param serial - The output wire's serial.
   * @param stepId - The publishing step's id.
   * @param startSerial - The publishing attempt's `start-serial`.
   */
  private _recordStepAttribution(
    entry: InternalNode<TInput, TOutput, TProjection>,
    serial: string,
    stepId: string,
    startSerial: string,
  ): void {
    const ss = (entry.stepState ??= this._newStepState());
    ss.attribution.set(serial, { stepId, startSerial });
    let set = ss.outputAttempts.get(stepId);
    if (!set) {
      set = new Set();
      ss.outputAttempts.set(stepId, set);
    }
    set.add(startSerial);
  }

  /**
   * Get the run node for a step event, creating a bare one (structure
   * backfilled by run-start) if absent. Returns undefined only in the
   * defensive case that the id already names a non-run node.
   * @param runId - The run id from the step event.
   * @returns The run node's internal entry, or undefined.
   */
  private _getOrCreateRunNodeForStep(runId: string): InternalNode<TInput, TOutput, TProjection> | undefined {
    const existing = this._nodeIndex.get(runId);
    if (existing) return existing.node.kind === 'run' ? existing : undefined;
    const entry = this._buildRunNode({
      runId,
      parentCodecMessageId: undefined,
      forkOf: undefined,
      regeneratesCodecMessageId: undefined,
      clientId: '',
      invocationId: '',
      startSerial: undefined,
      runStartSeen: false,
    });
    this._insertNode(runId, entry, entry.node.parentCodecMessageId);
    this._logger.debug('DefaultTree.applyStepLifecycle(); created run node from step event', { runId });
    return entry;
  }

  /**
   * Recompute a run node's {@link RunNode.steps} read-model from its step state.
   * Each entry reflects the step's canonical attempt status; the attempt count
   * is the number of distinct `start-serial`s seen (physical attempts).
   * @param node - The run node to update.
   * @param ss - The node's step state.
   */
  private _updateStepsReadModel(node: RunNode<TProjection>, ss: StepState): void {
    const steps: StepInfo[] = [];
    for (const stepId of ss.order) {
      const rec = ss.steps.get(stepId);
      if (!rec) continue;
      // 'active' until the canonical attempt's `ai-step-end` is observed — and
      // also while its `start-serial` is unknown (a serial-less optimistic seed
      // whose end reason cannot yet be keyed), or a step seen only via a step-end
      // / output with no step-start at all.
      const status: 'active' | StepEndReason =
        !rec.started || rec.canonicalStartSerial === undefined
          ? 'active'
          : (rec.endReasonByStartSerial.get(rec.canonicalStartSerial) ?? 'active');
      steps.push({ stepId, status, attemptCount: rec.startSerials.size, stepClientId: rec.stepClientId });
    }
    node.steps = steps;
  }

  /**
   * Apply a run-start lifecycle event's structural effect: create the reply
   * run if it doesn't exist yet, or backfill an optimistic / wire-created
   * node's structure and metadata from the canonical run-start. Mutates
   * `_structuralVersion` when the tree shape changes; the caller owns the
   * `run`/`update` emits.
   * @param event - The run-start lifecycle event.
   */
  private _applyRunStart(event: RunLifecycleEvent & { type: 'start' }): void {
    const existing = this._nodeIndex.get(event.runId);
    if (existing?.node.kind === 'run') {
      const node = existing.node;
      // Activate only a suspended run. A run-start can be observed AFTER the
      // run's terminal event (history pages replay newest-first, so an older
      // page delivers the start last) — like a stray resume, it must never
      // resurrect a run that has ended.
      if (node.state.status === 'suspended') {
        node.state = { status: 'active' };
      }
      if (event.serial && !node.startSerial) {
        node.startSerial = event.serial;
        this._promoteSerial(existing);
      }
      // Backfill structural metadata if the Run was created from an
      // assistant wire that arrived before run-start (history pagination
      // boundary or out-of-order delivery). The run-start lifecycle event is
      // the canonical source for parent/forkOf/regenerates; only fill in
      // fields the wire didn't already populate. A run-start is always a
      // first start (continuations re-enter via `ai-run-resume`, which
      // carries no structural metadata), so it is unconditionally
      // authoritative here. `parent` is the run's STRUCTURAL parent (its
      // input node) — reachability and the reply→input edge read it.
      if (node.parentCodecMessageId === undefined && event.parent !== undefined) {
        node.parentCodecMessageId = event.parent;
        this._removeFromParentIndex(undefined, event.runId);
        this._addToParentIndex(node.parentCodecMessageId, event.runId);
        this._indexReplyRun(node, event.runId);
        this._structuralVersion++;
      }
      if (node.forkOf === undefined && event.forkOf !== undefined) {
        const forkOfKey = this._codecMessageIdToNodeKey.get(event.forkOf);
        if (forkOfKey !== undefined && forkOfKey !== event.runId) {
          node.forkOf = forkOfKey;
          this._structuralVersion++;
        }
      }
      if (node.regeneratesCodecMessageId === undefined && event.regenerates !== undefined) {
        node.regeneratesCodecMessageId = event.regenerates;
        this._structuralVersion++;
      }
      // Adopt the agent-minted invocation-id onto the optimistic node. The
      // agent mints it, so a node created from an optimistic insert (or an
      // assistant wire that arrived before run-start) carries an empty id
      // until the agent's run-start delivers it. Metadata, not structure —
      // consumers re-read it on the `run` emit, so no structural-version
      // bump.
      if (node.invocationId === '' && event.invocationId !== '') {
        node.invocationId = event.invocationId;
      }
      // The run's serial floor is now observed: no older history page can
      // deliver further wires for this node. With a terminal status this
      // makes the node structurally complete — eligible for log retention
      // sweeping once the reorder window lapses.
      existing.runStartSeen = true;
      this._recordActivity(existing, event.timestamp);
      this._maybeQueueSweep(existing);
    } else if (!existing) {
      const run = this._createRunFromLifecycle(event);
      this._insertNode(event.runId, run, run.node.parentCodecMessageId);
      this._indexReplyRun(run.node, event.runId);
      this._recordActivity(run, event.timestamp);
    }
  }

  /**
   * Apply a run-suspend lifecycle event: pause the run without ending it —
   * mark the node 'suspended' and record the serial it paused at, but keep the
   * Run live so a resume under the same runId resumes it. Status/endSerial are
   * content, not structure, so this never mutates `_structuralVersion`; the
   * caller owns the emits.
   *
   * Retired-invocation guard: skip the suspend when a later invocation has
   * already resumed this run (`lastResumeInvocationId` is set and doesn't
   * match the incoming event's invocation-id). This suppresses the race
   * where the previous invocation's suspend publish loses to the next
   * invocation's resume publish in wire order, so applying the suspend
   * afterwards would wrongly flip a legitimately-active run back to
   * `suspended`.
   * @param event - The run-suspend lifecycle event.
   */
  private _applyRunSuspend(event: RunLifecycleEvent & { type: 'suspend' }): void {
    const run = this._nodeIndex.get(event.runId);
    if (run?.node.kind !== 'run') return;
    if (
      run.node.lastResumeInvocationId !== undefined &&
      event.invocationId !== '' &&
      run.node.lastResumeInvocationId !== event.invocationId
    ) {
      return;
    }
    run.node.state = { status: 'suspended' };
    run.node.endSerial = event.serial;
    this._recordActivity(run, event.timestamp);
  }

  /**
   * Apply a run-resume lifecycle event: re-enter an already-started run by
   * flipping a suspended run back to 'active'. Pure re-entry — it carries no
   * parent/forkOf and does not promote startSerial (the original run-start owns
   * the run's structure). Only a suspended run flips status: a no-op state
   * transition when the run isn't known (e.g. a resume replayed from a newer
   * history page before its run-start) and a no-op for an already-active or
   * terminal (complete/cancelled/error) run — a stray resume must never
   * resurrect a run that has ended.
   *
   * Regardless of whether the state transitions, the resume's invocation-id
   * is recorded as `lastResumeInvocationId` so `_applyRunSuspend` can filter
   * out a retired invocation's late suspend. The caller owns the emits.
   * @param event - The run-resume lifecycle event.
   */
  private _applyRunResume(event: RunLifecycleEvent & { type: 'resume' }): void {
    const run = this._nodeIndex.get(event.runId);
    if (run?.node.kind !== 'run') return;
    if (event.invocationId !== '') {
      run.node.lastResumeInvocationId = event.invocationId;
    }
    if (run.node.state.status === 'suspended') {
      run.node.state = { status: 'active' };
      this._recordActivity(run, event.timestamp);
    }
  }

  /**
   * Apply a run-end lifecycle event: record the terminal reason (and, for an
   * error end, the error) as the node's state, plus the serial it ended at.
   * State/endSerial are content, not structure, so this never mutates
   * `_structuralVersion`; the caller owns the emits.
   *
   * A run-end for an unknown runId is a no-op: nothing else is known about the
   * run yet, so there is no node to mark. When that happens during history
   * replay (a page boundary falling just before the run-end, so the run's
   * other wires arrive in later pages), the run is never marked terminal and
   * its event log is retained for the Tree's lifetime — over-retention, never
   * corruption.
   * @param event - The run-end lifecycle event.
   */
  private _applyRunEnd(event: RunLifecycleEvent & { type: 'end' }): void {
    const run = this._nodeIndex.get(event.runId);
    if (run?.node.kind === 'run') {
      run.node.state = event.reason === 'error' ? { status: 'error', error: event.error } : { status: event.reason };
      run.node.endSerial = event.serial;
      this._recordActivity(run, event.timestamp);
      this._maybeQueueSweep(run);
    }
  }

  delete(key: string): void {
    const entry = this._nodeIndex.get(key);
    if (!entry) return;

    this._logger.debug('Tree.delete();', { key });

    this._removeFromParentIndex(entry.node.parentCodecMessageId, key);
    this._removeSortedNode(entry);
    this._nodeIndex.delete(key);
    // Drop the reply→input reverse edge.
    if (entry.node.kind === 'run' && entry.node.parentCodecMessageId !== undefined) {
      deleteFromSetMap(this._replyRunsByInput, entry.node.parentCodecMessageId, key);
    }
    // _codecMessageIdToNodeKey entries pointing at this node linger but are
    // harmless; they'll be overwritten if the node is re-created and remain
    // dangling otherwise. Cleanup not worth the index walk.

    this._structuralVersion++;
    this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Build a fresh RunNode from a wire message's headers. Used when an
   * inbound message arrives before any run-start event for its runId.
   * @param runId - The run-id from the inbound wire.
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _createRunFromHeaders(
    runId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): InternalNode<TInput, TOutput, TProjection> {
    const forkOfMsgId = headers[HEADER_FORK_OF];
    return this._buildRunNode({
      runId,
      parentCodecMessageId: headers[HEADER_PARENT],
      // forkOf is resolved to the fork target's node key (an input node's
      // codec-message-id, or a run's id) — the same space `_isSiblingOf` walks.
      forkOf: forkOfMsgId ? this._codecMessageIdToNodeKey.get(forkOfMsgId) : undefined,
      regeneratesCodecMessageId: headers[HEADER_MSG_REGENERATE],
      clientId: headers[HEADER_RUN_CLIENT_ID] ?? '',
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      startSerial: serial,
      // Created from a content wire — the run's ai-run-start has not been
      // observed (it may still be in an unloaded older history page).
      runStartSeen: false,
    });
  }

  /**
   * Wrap a freshly-built conversation node in its internal envelope — sort
   * sequence, event log, and retention/promotion state. The single home for
   * those per-node fields, so a new field is added in one place rather than at
   * every node-construction site.
   * @param node - The conversation node to wrap.
   * @param runStartSeen - Whether the run's ai-run-start has been observed
   *   (run nodes only; always false for input nodes).
   * @returns A newly-allocated internal node ready for insertion.
   */
  private _wrapNode(
    node: ConversationNode<TProjection>,
    runStartSeen = false,
  ): InternalNode<TInput, TOutput, TProjection> {
    return {
      node,
      insertSeq: this._seqCounter++,
      log: new WireLog<CodecEvent<TInput, TOutput>>(),
      lastActivityTs: 0,
      runStartSeen,
      sweepQueued: false,
      optimistic: false,
    };
  }

  /**
   * Allocate a RunNode from already-resolved fields. Shared by the
   * header-driven and lifecycle-driven run creators: both build the identical
   * RunNode literal and stamp an insert sequence.
   * @param params - The resolved run fields.
   * @param params.runId - The run's id (its primary key).
   * @param params.parentCodecMessageId - Structural parent codec-message-id, or undefined for a root.
   * @param params.forkOf - The resolved fork target's node key (already mapped through the codec-message-id index), or undefined.
   * @param params.regeneratesCodecMessageId - The codec-message-id this run regenerates, or undefined.
   * @param params.clientId - The publishing client's id.
   * @param params.invocationId - The agent invocation id.
   * @param params.startSerial - Ably channel serial; undefined for optimistic inserts.
   * @param params.runStartSeen - Whether the run's ai-run-start has been observed (true only for lifecycle-created runs).
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _buildRunNode(params: {
    runId: string;
    parentCodecMessageId: string | undefined;
    forkOf: string | undefined;
    regeneratesCodecMessageId: string | undefined;
    clientId: string;
    invocationId: string;
    startSerial: string | undefined;
    runStartSeen: boolean;
  }): InternalNode<TInput, TOutput, TProjection> {
    const node: RunNode<TProjection> = {
      kind: 'run',
      runId: params.runId,
      parentCodecMessageId: params.parentCodecMessageId,
      forkOf: params.forkOf,
      regeneratesCodecMessageId: params.regeneratesCodecMessageId,
      clientId: params.clientId,
      invocationId: params.invocationId,
      lastResumeInvocationId: undefined,
      state: { status: 'active' },
      projection: this._codec.init(),
      startSerial: params.startSerial,
      endSerial: undefined,
      steps: [],
    };

    return this._wrapNode(node, params.runStartSeen);
  }

  /**
   * Build a fresh InputNode from a run-less user input wire's headers.
   * @param codecMessageId - The input's codec-message-id (its primary key).
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   * @returns A newly-allocated internal input node ready for insertion.
   */
  private _createInputNodeFromHeaders(
    codecMessageId: string,
    headers: Record<string, string>,
    serial: string | undefined,
  ): InternalNode<TInput, TOutput, TProjection> {
    const forkOfMsgId = headers[HEADER_FORK_OF];
    const node: InputNode<TProjection> = {
      kind: 'input',
      codecMessageId,
      parentCodecMessageId: headers[HEADER_PARENT],
      // An edit's fork-of names the original prompt's codec-message-id, which
      // IS that input node's key — no resolution needed.
      forkOf: forkOfMsgId,
      projection: this._codec.init(),
      serial,
    };
    return this._wrapNode(node);
  }

  /**
   * Build a fresh RunNode from a run-start lifecycle event. Used when a
   * run-start event arrives before any message for its runId.
   * @param event - The run-start lifecycle event from the agent, including
   *   its channel serial.
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _createRunFromLifecycle(
    event: RunLifecycleEvent & { type: 'start' },
  ): InternalNode<TInput, TOutput, TProjection> {
    const forkOfMsgId = event.forkOf;
    return this._buildRunNode({
      runId: event.runId,
      parentCodecMessageId: event.parent,
      forkOf: forkOfMsgId ? this._codecMessageIdToNodeKey.get(forkOfMsgId) : undefined,
      regeneratesCodecMessageId: event.regenerates,
      clientId: event.clientId,
      invocationId: event.invocationId,
      startSerial: event.serial,
      // Created from the run-start itself — the serial floor is observed.
      runStartSeen: true,
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // Spec: AIT-CT8b, AIT-CT8e
  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(event: 'output', handler: (event: OutputEvent<TOutput>) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run' | 'output',
    handler:
      | (() => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((event: RunLifecycleEvent) => void)
      | ((event: OutputEvent<TOutput>) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: TreeEventsMap<TOutput>[keyof TreeEventsMap<TOutput>]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  /**
   * Forward a raw Ably message event to tree subscribers. Also indexes the
   * Ably message by `event-id` header (if present) for
   * {@link findAblyMessageByEventId} lookups.
   * @param msg - The raw Ably message to emit.
   */
  emitAblyMessage(msg: Ably.InboundMessage): void {
    this._logger.trace('DefaultTree.emitAblyMessage();');
    const headers = getTransportHeaders(msg);
    const eventId = headers[HEADER_EVENT_ID];
    if (eventId !== undefined && !this._eventIdIndex.has(eventId)) {
      this._eventIdIndex.set(eventId, msg);
    }
    this._emitter.emit('ably-message', msg);
  }

  findAblyMessageByEventId(eventId: string): Ably.InboundMessage | undefined {
    return this._eventIdIndex.get(eventId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Tree that materializes branching conversation history from a flat
 * oplog of Ably messages as a two-node-per-turn forest (input node + reply run).
 * @param codec - Codec used to fold inbound events into per-Run projections.
 * @param logger - Logger for diagnostic output.
 * @param reorderWindowMs - Event-log retention window in ms; defaults to
 *   {@link REORDER_WINDOW_MS}. Raise it for a long-backoff durable agent (so a
 *   late superseding step-start still finds the dead attempt's log), lower it
 *   for deterministic tests.
 * @returns A new {@link DefaultTree} instance. The session uses DefaultTree
 *   directly for internal methods (applyMessage, applyRunLifecycle,
 *   emitAblyMessage). Public consumers see the narrower {@link Tree} interface.
 */
export const createTree = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection>(
  codec: Reducer<CodecEvent<TInput, TOutput>, TProjection>,
  logger: Logger,
  reorderWindowMs?: number,
): DefaultTree<TInput, TOutput, TProjection> =>
  new DefaultTree<TInput, TOutput, TProjection>(codec, logger, reorderWindowMs);
