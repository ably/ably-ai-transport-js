/**
 * Tree — materializes a branching conversation as a forest of Runs,
 * keyed by `run-id`.
 *
 * Each Run holds a per-Run codec {@link TProjection} which the Tree folds
 * from inbound events. The Tree owns the complete conversation state across
 * every observed Run. The {@link View} walks the parent chain to extract a
 * flat message list for rendering.
 *
 * `applyMessage()` is the entry point for inbound channel messages — it
 * routes by `run-id`, folds events into the Run's projection, and
 * maintains a secondary `codecMessageId -> runId` index. `applyRunLifecycle()`
 * handles run-start / run-end events.
 *
 * Sibling structure (edits / regenerates) is derived from RunNode.forkOf,
 * which the Tree resolves from the wire's `fork-of` header via the
 * codecMessageId index.
 */

import type * as Ably from 'ably';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../constants.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import type { Reducer } from '../codec/types.js';
import type { RunLifecycleEvent, RunNode, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

interface InternalRunNode<TProjection> {
  node: RunNode<TProjection>;
  /** Insertion sequence — tiebreaker for null-startSerial Runs (optimistic). */
  insertSeq: number;
}

// ---------------------------------------------------------------------------
// Internal interface — extended surface consumed by View / ClientSession
// ---------------------------------------------------------------------------

/** Internal tree surface used by View and ClientSession — not part of the public Tree API. */
export interface TreeInternal<TEvent, TProjection> extends Tree<TProjection> {
  /**
   * Monotonic counter that increments on structural changes (Run insert,
   * delete, startSerial promotion/reorder) but NOT on projection updates
   * (existing Run's projection mutated by fold). Allows the View to skip
   * full tree walks when only projection content changed.
   */
  readonly structuralVersion: number;

  /**
   * Flatten the tree along selected branches into a linear Run list.
   * The `selections` map provides the selected sibling's runId at each
   * fork point, keyed by group-root runId. Fork points not present in the
   * map default to the latest sibling. If a selectedRunId is not found in
   * the sibling group (stale/deleted), falls back to latest.
   */
  flattenNodes(selections: Map<string, string>): RunNode<TProjection>[];

  /**
   * Get the "group root" runId for a sibling group — the original Run that
   * all forks in the group trace back to.
   */
  getGroupRoot(runId: string): string;

  /**
   * Resolve the regenerate sibling group anchored at `codecMessageId`.
   *
   * Returned in chronological order: the Run that owns `codecMessageId` first
   * (lowest startSerial), then every Run with `regeneratesCodecMessageId === codecMessageId`
   * in serial order. Empty when neither the owner nor any regenerator has
   * been observed yet.
   * @param codecMessageId - The codec-message-id that anchors the group.
   * @returns Member Runs (owner first, then regenerators).
   */
  getRegenerateGroupByMsgId(codecMessageId: string): RunNode<TProjection>[];

  /**
   * Apply an inbound channel message to the tree.
   *
   * Three message kinds flow through here:
   * 1. Fresh user prompt: creates Run if missing, folds events.
   * 2. Continuation tool-resolution (`run-continue: 'true'`): routes to
   *    existing Run via codecMessageIdToRunId, folds events.
   * 3. Assistant/agent events: routes to existing Run by runId, folds events.
   * @param events - Decoded codec events to fold into the Run's projection.
   * @param headers - Transport headers from the inbound Ably message.
   * @param serial - Ably channel serial; undefined for optimistic inserts.
   */
  applyMessage(events: TEvent[], headers: Record<string, string>, serial?: string): void;

  /**
   * Apply a run-lifecycle event.
   *
   * - `ai-run-start`: creates the Run (if missing) or sets status to 'active'.
   *   Tracks the run as active.
   * - `ai-run-end`: sets RunNode.status to the end reason and `endSerial`.
   *   Untracks the run from active.
   *
   * Always emits a 'run' event to subscribers.
   * @param event - Lifecycle event payload.
   * @param serial - Ably channel serial of the lifecycle message.
   */
  applyRunLifecycle(event: RunLifecycleEvent, serial?: string): void;

  /**
   * Remove a Run from the tree. Children become unreachable in `flattenNodes()`
   * because their parent is no longer on the active path.
   * @param runId - The Run to remove.
   */
  delete(runId: string): void;

  /** Forward a raw Ably message event to tree subscribers. */
  emitAblyMessage(msg: Ably.InboundMessage): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** EventEmitter events map for the tree. */
interface TreeEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
  'run-projection-updated': { runId: string };
}

// Spec: AIT-CT13
export class DefaultTree<TEvent, TProjection> implements TreeInternal<TEvent, TProjection> {
  private readonly _codec: Reducer<TEvent, TProjection>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<TreeEventsMap>;

  /** All Run nodes indexed by runId. */
  private readonly _runIndex = new Map<string, InternalRunNode<TProjection>>();

  /**
   * Maps observed `codec-message-id` values to their owning runId. Used to
   * resolve fork-of codec-message-ids and parent codec-message-ids to run-ids, route
   * continuation amend wires to existing Runs, and back UI lookups that
   * hold a codec-message-id.
   */
  private readonly _codecMessageIdToRunId = new Map<string, string>();

  /**
   * All Runs sorted by startSerial (lexicographic). Null-startSerial Runs
   * (optimistic) sort after all serial-bearing Runs, ordered among themselves
   * by insertion sequence.
   */
  private readonly _sortedRuns: InternalRunNode<TProjection>[] = [];

  /**
   * Parent index: parentRunId to set of child runIds.
   * Root Runs (no parent) are indexed under the key `undefined`.
   */
  private readonly _parentIndex = new Map<string | undefined, Set<string>>();

  /**
   * Regenerated codec-message-id -> set of runIds that regenerate it. A Run with
   * `regeneratesCodecMessageId` set inserts here on creation; the View uses this
   * index to resolve message-level regenerate sibling groups in one lookup.
   */
  private readonly _regenerateByMsgId = new Map<string, Set<string>>();

  /**
   * Most recent continuation invocation observed per run-id: runId ->
   * invocationId. Updated on every `ai-run-start` carrying
   * `isContinuation: true`. Consulted by the ClientSession run-end gate so
   * observer clients (no `_ownRunIds` entry, no router stream) can still
   * accept the terminal `run-end` of a continuation.
   */
  private readonly _latestContinuationInvocations = new Map<string, string>();

  /** Monotonically increasing counter for insertion sequence. */
  private _seqCounter = 0;

  /** Incremented on structural changes; unchanged on projection-only updates. */
  private _structuralVersion = 0;

  /**
   * Cached sibling-group lookups keyed by runId. The walk over forkOf
   * chains and the per-parent fan-out are pure functions of the Run
   * graph, so the cache is keyed against {@link _structuralVersion}:
   * any topology mutation drops the cache and the next lookup
   * recomputes. Hits matter most during a single render pass where
   * the View calls `getSiblingRuns` once per visible Run plus extra
   * per-message branch-anchor probes from React components.
   */
  private _siblingCache = new Map<string, InternalRunNode<TProjection>[]>();
  private _siblingCacheVersion = -1;

  get structuralVersion(): number {
    return this._structuralVersion;
  }

  constructor(codec: Reducer<TEvent, TProjection>, logger: Logger) {
    this._codec = codec;
    this._logger = logger;
    this._emitter = new EventEmitter<TreeEventsMap>(logger);
  }

  // -------------------------------------------------------------------------
  // Sorted list maintenance
  // -------------------------------------------------------------------------

  /**
   * Compare two Runs for sorted list ordering.
   * Serial-bearing Runs sort by startSerial (lexicographic).
   * Null-startSerial Runs sort after all serial-bearing Runs.
   * Among null-startSerial Runs, sort by insertion sequence.
   *
   * Optimistic (null-serial) Runs intentionally tail-sort so they reorder
   * into place when the server relay arrives and `applyMessage` promotes
   * startSerial — see {@link applyMessage}'s `_removeSortedRun` /
   * `_insertSortedRun` pair on the promotion path.
   * @param a - First Run to compare.
   * @param b - Second Run to compare.
   * @returns Negative if a sorts before b, positive if after, zero if equal.
   */
  // Spec: AIT-CT13a
  private _compareRuns(a: InternalRunNode<TProjection>, b: InternalRunNode<TProjection>): number {
    const sa = a.node.startSerial;
    const sb = b.node.startSerial;
    if (sa === undefined && sb === undefined) return a.insertSeq - b.insertSeq;
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.insertSeq - b.insertSeq;
  }

  /**
   * Insert a Run into sortedRuns at the correct position via binary search.
   * @param internal - The Run to insert.
   */
  private _insertSortedRun(internal: InternalRunNode<TProjection>): void {
    const startSerial = internal.node.startSerial;

    // Fast path: null-startSerial always appends to end.
    if (startSerial === undefined) {
      this._sortedRuns.push(internal);
      return;
    }

    let lo = 0;
    let hi = this._sortedRuns.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midRun = this._sortedRuns[mid];
      if (!midRun) break; // unreachable
      if (this._compareRuns(midRun, internal) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this._sortedRuns.splice(lo, 0, internal);
  }

  /**
   * Remove a Run from sortedRuns.
   * @param internal - The Run to remove.
   */
  private _removeSortedRun(internal: InternalRunNode<TProjection>): void {
    const idx = this._sortedRuns.indexOf(internal);
    if (idx !== -1) this._sortedRuns.splice(idx, 1);
  }

  // -------------------------------------------------------------------------
  // Parent index maintenance
  // -------------------------------------------------------------------------

  private _addToParentIndex(parentRunId: string | undefined, runId: string): void {
    let set = this._parentIndex.get(parentRunId);
    if (!set) {
      set = new Set();
      this._parentIndex.set(parentRunId, set);
    }
    set.add(runId);
  }

  private _removeFromParentIndex(parentRunId: string | undefined, runId: string): void {
    const set = this._parentIndex.get(parentRunId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this._parentIndex.delete(parentRunId);
    }
  }

  // -------------------------------------------------------------------------
  // Sibling grouping
  // -------------------------------------------------------------------------

  /**
   * Get the sibling group that `runId` belongs to.
   *
   * A sibling group is: the original Run + all Runs whose `forkOf.runId`
   * points to the original (or transitively to a sibling). We find the
   * group root by following `forkOf` chains to the earliest ancestor that
   * has no `forkOf` (or whose `forkOf` target doesn't share the same
   * parentRunId).
   * @param runId - The runId to look up the sibling group for.
   * @returns The ordered list of sibling Runs.
   */
  // Spec: AIT-CT13b
  private _getSiblingGroup(runId: string): InternalRunNode<TProjection>[] {
    if (this._siblingCacheVersion !== this._structuralVersion) {
      this._siblingCache.clear();
      this._siblingCacheVersion = this._structuralVersion;
    }
    const cached = this._siblingCache.get(runId);
    if (cached) return cached;

    const entry = this._runIndex.get(runId);
    if (!entry) return [];

    // Find the "original" — the Run at the root of the fork chain that
    // shares the same parentRunId. Guard against cycles in forkOf chains.
    let original = entry.node;
    const visitedGroup = new Set<string>([original.runId]);
    while (original.forkOf) {
      if (visitedGroup.has(original.forkOf)) break;
      const forkTarget = this._runIndex.get(original.forkOf);
      if (!forkTarget || forkTarget.node.parentRunId !== original.parentRunId) break;
      original = forkTarget.node;
      visitedGroup.add(original.runId);
    }

    // Collect all siblings: Runs with the same parentRunId that either ARE
    // the original or have a forkOf chain leading to the original.
    const parentRunId = original.parentRunId;
    const originalRunId = original.runId;
    const siblings: InternalRunNode<TProjection>[] = [];

    const candidateIds = this._parentIndex.get(parentRunId);
    if (candidateIds) {
      for (const childRunId of candidateIds) {
        const childEntry = this._runIndex.get(childRunId);
        if (childEntry && this._isSiblingOf(childEntry.node, originalRunId)) {
          siblings.push(childEntry);
        }
      }
    }

    siblings.sort((a, b) => this._compareRuns(a, b));
    // Cache against the queried runId AND every member of the group:
    // a single sibling group is the same array regardless of which
    // member triggered the lookup, so subsequent queries against any
    // member hit without recomputing.
    for (const sib of siblings) {
      this._siblingCache.set(sib.node.runId, siblings);
    }
    this._siblingCache.set(runId, siblings);
    return siblings;
  }

  /**
   * Check if `node` belongs to the sibling group rooted at `originalRunId`.
   * A Run is a sibling if it IS the original or its forkOf chain leads
   * to the original (with the same parentRunId).
   * @param node - The Run to check.
   * @param originalRunId - The group root to match against.
   * @returns True if the Run belongs to the sibling group.
   */
  private _isSiblingOf(node: RunNode<TProjection>, originalRunId: string): boolean {
    if (node.runId === originalRunId) return true;
    let current = node;
    const visited = new Set<string>([current.runId]);
    while (current.forkOf) {
      if (current.forkOf === originalRunId) return true;
      if (visited.has(current.forkOf)) break;
      const target = this._runIndex.get(current.forkOf);
      if (!target) break;
      current = target.node;
      visited.add(current.runId);
    }
    return false;
  }

  /**
   * Get the "group root" runId for a sibling group — the original Run
   * that all forks trace back to.
   * @param runId - Any runId in the sibling group.
   * @returns The runId of the group root.
   */
  getGroupRoot(runId: string): string {
    const entry = this._runIndex.get(runId);
    if (!entry) return runId;

    let current = entry.node;
    const visited = new Set<string>([current.runId]);
    while (current.forkOf) {
      if (visited.has(current.forkOf)) break;
      const forkTarget = this._runIndex.get(current.forkOf);
      if (!forkTarget || forkTarget.node.parentRunId !== current.parentRunId) break;
      current = forkTarget.node;
      visited.add(current.runId);
    }
    return current.runId;
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  flattenNodes(selections: Map<string, string>): RunNode<TProjection>[] {
    this._logger.trace('DefaultTree.flattenNodes();');
    const result: RunNode<TProjection>[] = [];
    const currentPath = new Set<string>();
    // Track which sibling groups we've already resolved to avoid
    // re-resolving for every member of the group.
    const resolvedGroups = new Map<string, string>(); // groupRootRunId -> selected runId

    for (const internal of this._sortedRuns) {
      const node = internal.node;
      const { runId, parentRunId } = node;

      // Step 1: Parent reachability.
      if (parentRunId !== undefined && !currentPath.has(parentRunId)) {
        continue;
      }

      // Step 2: Sibling selection.
      const group = this._getSiblingGroup(runId);
      if (group.length > 1) {
        const groupRootRunId = this.getGroupRoot(runId);
        let selectedRunId = resolvedGroups.get(groupRootRunId);
        if (selectedRunId === undefined) {
          const preferredRunId = selections.get(groupRootRunId);
          if (preferredRunId && group.some((n) => n.node.runId === preferredRunId)) {
            selectedRunId = preferredRunId;
          } else {
            const latest = group.at(-1);
            if (!latest) break; // unreachable: group.length > 1
            selectedRunId = latest.node.runId;
          }
          resolvedGroups.set(groupRootRunId, selectedRunId);
        }
        if (runId !== selectedRunId) {
          continue;
        }
      }

      currentPath.add(runId);
      result.push(node);
    }

    return result;
  }

  getRunNode(runId: string): RunNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getRunNode();', { runId });
    return this._runIndex.get(runId)?.node;
  }

  getRunByCodecMessageId(codecMessageId: string): RunNode<TProjection> | undefined {
    this._logger.trace('DefaultTree.getRunByCodecMessageId();', { codecMessageId });
    const runId = this._codecMessageIdToRunId.get(codecMessageId);
    return runId ? this._runIndex.get(runId)?.node : undefined;
  }

  getSiblingRuns(runId: string): RunNode<TProjection>[] {
    this._logger.trace('DefaultTree.getSiblingRuns();', { runId });
    return this._getSiblingGroup(runId).map((n) => n.node);
  }

  hasSiblingRuns(runId: string): boolean {
    return this._getSiblingGroup(runId).length > 1;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  applyMessage(events: TEvent[], headers: Record<string, string>, serial?: string): void {
    const wireRunId = headers[HEADER_RUN_ID];
    if (!wireRunId) {
      this._logger.warn('Tree.applyMessage(); message missing run-id header; skipping');
      return;
    }

    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    const isContinuation = headers[HEADER_RUN_CONTINUE] === 'true';

    // Wire-only metadata-carrier messages (e.g. `ait-regenerate`) decode to
    // zero events and don't need a Run at the tree level — the eventual
    // assistant Run is created later by run-start, and any regenerate /
    // parent information the wire carried is reread from the run-start
    // headers. Skipping here avoids a phantom Run with empty projection
    // that would otherwise inflate sibling-group counts.
    if (events.length === 0 && !this._runIndex.has(wireRunId)) {
      return;
    }

    const runId = wireRunId;

    let run = this._runIndex.get(runId);
    if (!run) {
      run = this._createRunFromHeaders(runId, headers, serial);
      this._runIndex.set(runId, run);
      this._addToParentIndex(run.node.parentRunId, runId);
      this._insertSortedRun(run);
      this._structuralVersion++;
      this._logger.debug('Tree.applyMessage(); created new Run', { runId, wireRunId, isContinuation });
    } else if (serial && !run.node.startSerial) {
      // Promote optimistic startSerial when the relay arrives.
      this._logger.debug('Tree.applyMessage(); promoting startSerial', { runId, serial });
      run.node.startSerial = serial;
      this._removeSortedRun(run);
      this._insertSortedRun(run);
      this._structuralVersion++;
    }

    if (codecMessageId) this._codecMessageIdToRunId.set(codecMessageId, runId);

    for (const event of events) {
      try {
        run.node.projection = this._codec.fold(run.node.projection, event, {
          serial: serial ?? '',
          messageId: codecMessageId,
        });
      } catch (error) {
        this._logger.error('Tree.applyMessage(); fold threw', { runId, err: error });
      }
    }

    this._emitter.emit('run-projection-updated', { runId });
    this._emitter.emit('update');
  }

  applyRunLifecycle(event: RunLifecycleEvent, serial?: string): void {
    this._logger.trace('DefaultTree.applyRunLifecycle();', { type: event.type, runId: event.runId });
    if (event.type === 'ai-run-start') {
      if (event.isContinuation && event.invocationId) {
        this._latestContinuationInvocations.set(event.runId, event.invocationId);
      }
      let run = this._runIndex.get(event.runId);
      if (run) {
        if (run.node.status !== 'active') {
          run.node.status = 'active';
        }
        if (serial && !run.node.startSerial) {
          run.node.startSerial = serial;
          this._removeSortedRun(run);
          this._insertSortedRun(run);
          this._structuralVersion++;
        }
        // Backfill structural metadata if the Run was created from an
        // assistant wire that arrived before run-start (history pagination
        // boundary or out-of-order delivery). The lifecycle event is the
        // canonical source for parent/forkOf/regenerates; only fill in
        // fields the wire didn't already populate.
        //
        // Continuation run-starts (`run-continue: 'true'`) are
        // NOT authoritative for structural metadata: the parent / forkOf
        // / regenerates carried on the wire are read from the client's
        // tool-resolution wire (whose parent points back at a message in
        // the current run itself), so backfilling here would produce a
        // self-parent cycle and the Run drops out of flattenNodes as
        // unreachable. The original run-start already set these fields.
        if (!event.isContinuation) {
          if (run.node.parentRunId === undefined && event.parent !== undefined) {
            const parentRunId = this._codecMessageIdToRunId.get(event.parent);
            if (parentRunId !== undefined && parentRunId !== event.runId) {
              this._removeFromParentIndex(undefined, event.runId);
              run.node.parentRunId = parentRunId;
              this._addToParentIndex(parentRunId, event.runId);
              this._structuralVersion++;
            }
          }
          if (run.node.forkOf === undefined && event.forkOf !== undefined) {
            const forkOfRunId = this._codecMessageIdToRunId.get(event.forkOf);
            if (forkOfRunId !== undefined && forkOfRunId !== event.runId) {
              run.node.forkOf = forkOfRunId;
              this._structuralVersion++;
            }
          }
          if (run.node.regeneratesCodecMessageId === undefined && event.regenerates !== undefined) {
            run.node.regeneratesCodecMessageId = event.regenerates;
            this._indexRegenerate(event.runId, event.regenerates);
            this._structuralVersion++;
          }
        }
      } else {
        run = this._createRunFromLifecycle(event, serial);
        this._runIndex.set(event.runId, run);
        this._addToParentIndex(run.node.parentRunId, event.runId);
        this._insertSortedRun(run);
        this._structuralVersion++;
      }
      this._emitter.emit('run', event);
      this._emitter.emit('update');
      return;
    }

    // ai-run-end
    const run = this._runIndex.get(event.runId);
    if (run) {
      run.node.status = event.reason;
      run.node.endSerial = serial;
    }
    this._emitter.emit('run', event);
    this._emitter.emit('update');
  }

  delete(runId: string): void {
    const entry = this._runIndex.get(runId);
    if (!entry) return;

    this._logger.debug('Tree.delete();', { runId });

    this._removeFromParentIndex(entry.node.parentRunId, runId);
    this._removeSortedRun(entry);
    this._runIndex.delete(runId);
    this._latestContinuationInvocations.delete(runId);
    if (entry.node.regeneratesCodecMessageId !== undefined) {
      const set = this._regenerateByMsgId.get(entry.node.regeneratesCodecMessageId);
      if (set) {
        set.delete(runId);
        if (set.size === 0) this._regenerateByMsgId.delete(entry.node.regeneratesCodecMessageId);
      }
    }
    // codecMessageIdToRunId entries pointing at this run linger but are harmless;
    // they'll be overwritten if the Run is re-created and remain dangling
    // otherwise. Cleanup not worth the index walk.

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
  ): InternalRunNode<TProjection> {
    const parentCodecMessageId = headers[HEADER_PARENT];
    const parentRunId = parentCodecMessageId ? this._codecMessageIdToRunId.get(parentCodecMessageId) : undefined;
    const forkOfMsgId = headers[HEADER_FORK_OF];
    const forkOf = forkOfMsgId ? this._codecMessageIdToRunId.get(forkOfMsgId) : undefined;
    const regeneratesCodecMessageId = headers[HEADER_MSG_REGENERATE];

    const node: RunNode<TProjection> = {
      runId,
      parentRunId,
      forkOf,
      regeneratesCodecMessageId,
      clientId: headers[HEADER_RUN_CLIENT_ID] ?? '',
      invocationId: headers[HEADER_INVOCATION_ID] ?? '',
      status: 'active',
      projection: this._codec.init(),
      startSerial: serial,
      endSerial: undefined,
    };

    if (regeneratesCodecMessageId !== undefined) {
      this._indexRegenerate(runId, regeneratesCodecMessageId);
    }

    return { node, insertSeq: this._seqCounter++ };
  }

  /**
   * Build a fresh RunNode from a run-start lifecycle event. Used when a
   * run-start event arrives before any message for its runId.
   * @param event - The run-start lifecycle event from the agent.
   * @param serial - Ably channel serial of the run-start message.
   * @returns A newly-allocated internal run node ready for insertion.
   */
  private _createRunFromLifecycle(
    event: RunLifecycleEvent & { type: 'ai-run-start' },
    serial: string | undefined,
  ): InternalRunNode<TProjection> {
    const parentCodecMessageId = event.parent;
    const parentRunId = parentCodecMessageId ? this._codecMessageIdToRunId.get(parentCodecMessageId) : undefined;
    const forkOfMsgId = event.forkOf;
    const forkOf = forkOfMsgId ? this._codecMessageIdToRunId.get(forkOfMsgId) : undefined;
    const regeneratesCodecMessageId = event.regenerates;

    const node: RunNode<TProjection> = {
      runId: event.runId,
      parentRunId,
      forkOf,
      regeneratesCodecMessageId,
      clientId: event.clientId,
      invocationId: event.invocationId,
      status: 'active',
      projection: this._codec.init(),
      startSerial: serial,
      endSerial: undefined,
    };

    if (regeneratesCodecMessageId !== undefined) {
      this._indexRegenerate(event.runId, regeneratesCodecMessageId);
    }

    return { node, insertSeq: this._seqCounter++ };
  }

  /**
   * Track a Run as a regenerator of the given codec-message-id. Maintained as a
   * forward map (`regenerated codec-message-id -> set of runIds that regenerate it`)
   * so the View can resolve regenerate sibling groups in one lookup.
   * @param runId - The runId of the regenerating Run.
   * @param regeneratesCodecMessageId - The codec-message-id the Run regenerates.
   */
  private _indexRegenerate(runId: string, regeneratesCodecMessageId: string): void {
    let set = this._regenerateByMsgId.get(regeneratesCodecMessageId);
    if (!set) {
      set = new Set();
      this._regenerateByMsgId.set(regeneratesCodecMessageId, set);
    }
    set.add(runId);
  }

  /**
   * Get all Runs (including the Run that owns the codec-message-id) that participate
   * in the regenerate sibling group rooted at `codecMessageId`. Returns an empty
   * array when neither the owner Run nor any regenerator is observed.
   * @param codecMessageId - The codec-message-id that anchors the group (the "original" message).
   * @returns Members ordered chronologically by startSerial — owner first
   *   (it has the lowest serial), regenerators after.
   */
  getRegenerateGroupByMsgId(codecMessageId: string): RunNode<TProjection>[] {
    const result: RunNode<TProjection>[] = [];

    const ownerRunId = this._codecMessageIdToRunId.get(codecMessageId);
    if (ownerRunId) {
      const owner = this._runIndex.get(ownerRunId);
      if (owner) result.push(owner.node);
    }

    const regenIds = this._regenerateByMsgId.get(codecMessageId);
    if (regenIds) {
      for (const id of regenIds) {
        const entry = this._runIndex.get(id);
        if (entry) result.push(entry.node);
      }
    }

    result.sort((a, b) => {
      const ai = this._runIndex.get(a.runId)?.insertSeq ?? 0;
      const bi = this._runIndex.get(b.runId)?.insertSeq ?? 0;
      const sa = a.startSerial;
      const sb = b.startSerial;
      if (sa === undefined && sb === undefined) return ai - bi;
      if (sa === undefined) return 1;
      if (sb === undefined) return -1;
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return ai - bi;
    });

    return result;
  }

  /**
   * Resolve the regenerate sibling group containing `runId`.
   *
   * A Run participates in a regenerate group if either:
   * - the Run regenerates a known codec-message-id (the Run is a regenerator), or
   * - the Run owns a codec-message-id that has been regenerated by another Run.
   *
   * The group's anchor is the "original" codec-message-id — the one being
   * regenerated. The Run that owns that codec-message-id is the group's root.
   * @param runId - The runId to look up.
   * @returns The group's anchor codec-message-id and ordered members, or undefined
   *   if `runId` is not in any regenerate group.
   */
  getRegenerateGroup(runId: string):
    | {
        /** The codec-message-id this group regenerates — anchor of the group. */
        anchorCodecMessageId: string;
        /** Ordered group members (owner first, then regenerators by serial). */
        runs: RunNode<TProjection>[];
      }
    | undefined {
    const entry = this._runIndex.get(runId);
    if (!entry) return undefined;

    // Case 1: this Run regenerates a known codec-message-id.
    const regenTarget = entry.node.regeneratesCodecMessageId;
    if (regenTarget !== undefined) {
      const runs = this.getRegenerateGroupByMsgId(regenTarget);
      return runs.length > 0 ? { anchorCodecMessageId: regenTarget, runs } : undefined;
    }

    // Case 2: this Run owns a codec-message-id that has been regenerated. Iterate
    // the regenerate index and match ownership via `_codecMessageIdToRunId`. The
    // index is keyed by regenerated codec-message-id, so the search is bounded by
    // the number of distinct regen anchors in the tree (small in practice).
    for (const [anchorCodecMessageId, regenRunIds] of this._regenerateByMsgId) {
      if (regenRunIds.size === 0) continue;
      const ownerRunId = this._codecMessageIdToRunId.get(anchorCodecMessageId);
      if (ownerRunId !== runId) continue;
      const runs = this.getRegenerateGroupByMsgId(anchorCodecMessageId);
      if (runs.length > 1) return { anchorCodecMessageId, runs };
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  getLatestContinuationInvocation(runId: string): string | undefined {
    return this._latestContinuationInvocations.get(runId);
  }

  // Spec: AIT-CT8b, AIT-CT8e
  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(event: 'run-projection-updated', handler: (event: { runId: string }) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run' | 'run-projection-updated',
    handler:
      | (() => void)
      | ((msg: Ably.InboundMessage) => void)
      | ((event: RunLifecycleEvent) => void)
      | ((event: { runId: string }) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: TreeEventsMap[keyof TreeEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  /**
   * Forward a raw Ably message event to tree subscribers.
   * @param msg - The raw Ably message to emit.
   */
  emitAblyMessage(msg: Ably.InboundMessage): void {
    this._logger.trace('DefaultTree.emitAblyMessage();');
    this._emitter.emit('ably-message', msg);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Tree that materializes branching conversation history from a flat
 * oplog of Ably messages, keyed by run-id.
 * @param codec - Codec used to fold inbound events into per-Run projections.
 * @param logger - Logger for diagnostic output.
 * @returns A new {@link DefaultTree} instance. The session uses DefaultTree
 *   directly for internal methods (applyMessage, applyRunLifecycle,
 *   emitAblyMessage). Public consumers see the narrower {@link Tree} interface.
 */
export const createTree = <TEvent, TProjection>(
  codec: Reducer<TEvent, TProjection>,
  logger: Logger,
): DefaultTree<TEvent, TProjection> => new DefaultTree(codec, logger);
