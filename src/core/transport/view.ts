/**
 * DefaultView — a read-only, paginated, branch-aware projection over the Tree,
 * and DefaultClientView — the client's navigable, writable view that composes it.
 *
 * `DefaultView` owns the invariant machinery every view needs: a pagination
 * window over the visible node chain, scoped event re-emission, and the read
 * surface (`getMessages`/`runs`/`hasOlder`/`loadOlder`/`runOf`/`run`). It reads
 * the branch through an injected {@link BranchSource} — the strategy that
 * resolves which nodes are on the branch and how they flatten — so the same base
 * can serve both the client's whole-tree navigation and a leaf-pinned read (the
 * latter planned for the agent's `run.view`). `getMessages()` concatenates each
 * visible node's
 * `codec.getMessages(node.projection)` (with non-head-regenerate substitution the
 * source applies) into the flat `CodecMessage<TMessage>[]` the UI renders.
 *
 * `DefaultClientView` adds the client's navigation + write path
 * (`branchSelection` / `send` / `regenerate` / `edit`) on top, composing a
 * `DefaultView` base and the {@link NavigableBranchSource} that base reads
 * through. Each view owns its own source (its own selection state and pagination
 * window), allowing multiple independent views over the same Tree.
 *
 * Events are scoped to the visible window — 'update' only fires when the
 * visible output changes, 'ably-message' only for messages corresponding to
 * visible Runs, and 'run' only for runs with visible content.
 */

import * as Ably from 'ably';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecMessage, CodecOutputEvent } from '../codec/types.js';
import { type BranchSource, NavigableBranchSource } from './branch-source.js';
import { messageTailSplitIndex } from './conversation-projection.js';
import type { HistoryHydrator } from './history-hydrator.js';
import type { LeafBranchSource } from './leaf-branch-source.js';
import { nodeKey, type TreeInternal } from './tree.js';
import type {
  BranchHandle,
  ClientRun,
  ClientView,
  ConversationNode,
  OutputEvent,
  RunInfo,
  RunLifecycleEvent,
  RunNode,
  SendOptions,
  View,
} from './types.js';

// ---------------------------------------------------------------------------
// Events map
// ---------------------------------------------------------------------------

interface ViewEventsMap {
  update: undefined;
  'ably-message': Ably.InboundMessage;
  run: RunLifecycleEvent;
}

// ---------------------------------------------------------------------------
// Send delegate
// ---------------------------------------------------------------------------

/**
 * Internal delegate function provided by the session for executing sends.
 * The View pre-computes the visible branch's flat message list and the
 * codec-message-id of its tail (for auto-parent routing) before calling
 * the delegate, so the delegate has no back-reference to the View.
 *
 * Each TInput carries its own routing metadata (`parent` / `target` /
 * `codecMessageId`) via the {@link CodecInputEvent} base; the delegate
 * reads those fields directly without runtime classification.
 *
 * `parentCodecMessageId` is the codec-message-id of the last message in
 * the visible branch (extracted from the tail Run's projection per codec
 * convention), or `undefined` for an empty conversation. The session
 * uses it as the auto-parent for fresh user messages.
 */
export type SendDelegate<TInput extends CodecInputEvent, TMessage> = (
  input: TInput[],
  options: SendOptions | undefined,
  parentCodecMessageId: string | undefined,
) => Promise<ClientRun<TMessage>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating the read-only {@link DefaultView} base. */
interface ViewOptions<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The tree to project. */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The codec used to project messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /**
   * The session's shared history hydrator. `loadOlder` drives it to fold older
   * channel pages into the Tree; it is owned by the session and shared by every
   * view, so the channel is paged once across views.
   */
  hydrator: HistoryHydrator;
  /**
   * The branch strategy this view reads through — the client's
   * {@link NavigableBranchSource} today (a leaf-pinned agent source is planned).
   * Resolves the visible node chain and flattens it; the View layers pagination
   * + events on top.
   */
  branchSource: BranchSource<TProjection, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Called when the view is closed, allowing the owner to clean up references. */
  onClose?: () => void;
}

/** Options for creating a client View — the navigable, writable {@link DefaultClientView}. */
interface ClientViewOptions<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /** The tree to project and navigate. */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The codec used to project messages and mint regenerate inputs. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** The session's shared history hydrator (see {@link ViewOptions.hydrator}). */
  hydrator: HistoryHydrator;
  /** Delegate for executing sends through the session. */
  sendDelegate: SendDelegate<TInput, TMessage>;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Called when the view is closed, allowing the owner to clean up references. */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Send-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the two input shapes `ClientView.send` accepts (a single TInput
 * or an array) into the array shape the SendDelegate consumes.
 * @param input - The raw input from `ClientView.send`.
 * @returns The normalised input array.
 */
const _normaliseSend = <TInput extends CodecInputEvent>(input: TInput | TInput[]): TInput[] =>
  Array.isArray(input) ? input : [input];

/**
 * Project a Tree `RunNode` down to the View-facing `RunInfo` shape:
 * drop the codec projection and the structural fields that callers
 * reach via `session.tree` when they need them.
 * @param run - The tree's RunNode.
 * @returns A projection-free RunInfo.
 */
const _toRunInfo = <TProjection>(run: RunNode<TProjection>): RunInfo => ({
  runId: run.runId,
  clientId: run.clientId,
  invocationId: run.invocationId,
  steps: run.steps,
  ...run.state,
});

// ---------------------------------------------------------------------------
// Read-only base
// ---------------------------------------------------------------------------

/**
 * The read-only {@link View} base: pagination window, scoped events, and the
 * read surface, over an injected {@link BranchSource}. `recomputeAndEmit` /
 * `recomputeAndEmitIfChanged` are public so a composing client view can trigger
 * a refresh after mutating the source's selection state; they are not part of
 * the public {@link View} contract.
 */
class DefaultView<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements View<TMessage> {
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _hydrator: HistoryHydrator;
  private readonly _branchSource: BranchSource<TProjection, TMessage>;
  private readonly _logger: Logger;
  private readonly _emitter: EventEmitter<ViewEventsMap>;
  private readonly _onClose?: () => void;

  /** Spec: AIT-CT11c — runIds loaded from history but not yet revealed to the UI. */
  private readonly _withheldRunIds = new Set<string>();

  /** Snapshot of visible node keys — used to detect structural changes and for selection pinning. */
  private _lastVisibleNodeKeys: string[] = [];

  /**
   * Snapshot of visible projection references — used to detect in-place
   * projection updates (streaming). One entry per visible Run.
   */
  private _lastVisibleProjections: TProjection[] = [];

  /**
   * Snapshot of the visible flat message chain with codec-message-ids —
   * exposed verbatim via `getMessages()` and the internal correlation
   * source for parent/branch routing.
   */
  private _lastVisibleMessagePairs: CodecMessage<TMessage>[] = [];

  /** Cached visible node-key Set — for O(1) lookup in event scoping. */
  private _lastVisibleNodeKeySet = new Set<string>();

  /** Buffer of withheld nodes (input + reply), drained newest-first by successive loadOlder() calls. */
  private readonly _withheldBuffer: ConversationNode<TProjection>[] = [];

  /**
   * Message-level trim on top of the run-level pagination window. Runs are
   * revealed whole (via `_withheldRunIds`/`_withheldBuffer`), so a `loadOlder`
   * may surface more messages than asked; this is the count of OLDEST messages
   * of the visible node chain to hide from `getMessages()` so a page lands on
   * exactly `limit` messages. The boundary run still appears in `runs()` (it's
   * a revealed node); only its oldest messages are trimmed from the flat list.
   * Live messages append at the newest end and are never trimmed.
   */
  private _hiddenMessageCount = 0;

  /** Unsubscribe functions for tree event subscriptions. */
  private readonly _unsubs: (() => void)[] = [];

  /**
   * Cached result of the last flat-nodes computation. Drives the visible
   * message snapshot exposed via `getMessages()`; refreshed by
   * `_computeFlatNodes()` on structural changes, selection changes,
   * and history reveal.
   */
  private _cachedNodes: ConversationNode<TProjection>[] = [];

  private _loadingOlder = false;
  /**
   * The in-flight {@link loadOlder} promise while one is running, else
   * `undefined`. A concurrent {@link loadUntil} awaits this to yield to the
   * running load instead of busy-spinning on `loadOlder`'s synchronous `[]`
   * return (which would starve the microtask queue — see {@link loadUntil}).
   * Awaited purely as a barrier — its resolved value is never read — so it is
   * typed `unknown`.
   */
  private _loadInFlight: Promise<unknown> | undefined;
  private _processingHistory = false;
  private _closed = false;

  /**
   * Whether a {@link loadUntil} walk is currently running. While one is, `update`
   * emission is suppressed (the snapshot is still kept current) and a single
   * settled `update` is emitted when the walk leaves. A walk pages the window
   * back through the seam one reveal at a time, so every pre-trim reveal holds
   * the seam (and older) — messages a seeded subscriber already has. Surfacing
   * those would briefly compose a list with duplicate ids before the trim lands;
   * suppressing them means a subscriber that mirrors `getMessages()` only ever
   * sees the trimmed tail. Walks are serialized (see {@link loadUntil}), so at
   * most one runs at a time — a boolean, not a counter.
   */
  private _walkInProgress = false;

  /**
   * The in-flight {@link loadUntil} walk's (rejection-swallowed) promise while
   * one is running, else `undefined`. A concurrent walk chains after it so the
   * two never interleave on the shared trim state; an idle walk (this
   * `undefined`) starts synchronously, preserving single-walk timing. Awaited
   * purely as an ordering barrier — its resolved value is never read.
   */
  private _walkTail: Promise<void> | undefined;

  constructor(options: ViewOptions<TInput, TOutput, TProjection, TMessage>) {
    this._tree = options.tree;
    this._codec = options.codec;
    this._hydrator = options.hydrator;
    this._branchSource = options.branchSource;
    this._onClose = options.onClose;
    this._logger = options.logger.withContext({ component: 'View' });
    this._logger.trace('DefaultView();');
    this._emitter = new EventEmitter<ViewEventsMap>(this._logger);

    // Compute initial cache and snapshot visible state
    this._cachedNodes = this._computeFlatNodes();
    this._updateVisibleSnapshot(this._cachedNodes);

    // Subscribe to tree events and re-emit scoped versions
    this._unsubs.push(
      this._tree.on('update', () => {
        this._onTreeUpdate();
      }),
      this._tree.on('ably-message', (msg) => {
        this._onTreeAblyMessage(msg);
      }),
      this._tree.on('run', (event) => {
        this._onTreeRun(event);
      }),
      this._tree.on('output', (event) => {
        this._onTreeOutput(event);
      }),
    );
  }

  /**
   * Handle decoded outputs folded into a Run (streaming delta). If the run
   * is on the visible chain, recompute the flat message list and emit
   * `update`.
   * @param event - The output event from the Tree.
   */
  private _onTreeOutput(event: OutputEvent<TOutput>): void {
    if (this._processingHistory) return;
    // The fold target may be a reply run (event.runId) or a user input node
    // (event.runId undefined — the agent mints run-ids, so an input fold has
    // none). Gate on whichever key the visible set holds.
    const folded =
      (event.runId !== undefined && this._lastVisibleNodeKeySet.has(event.runId)) ||
      (event.inputCodecMessageId !== undefined && this._lastVisibleNodeKeySet.has(event.inputCodecMessageId));
    if (!folded) return;

    // The Tree emits `output` once per inbound message fold (with empty
    // `events` for inputs-only folds), so it fires whenever a visible Run's
    // projection changed and we always re-emit. The Reducer contract permits
    // in-place mutation, which means we cannot use projection-ref or
    // TMessage-ref equality to detect change: a streaming chunk legitimately
    // mutates the same UIMessage object, and a ref-equality short-circuit
    // would suppress every update. React state setters at the subscriber
    // boundary already dedup by array reference, so a redundant emit is a
    // no-op for unchanged hook consumers.
    this._lastVisibleProjections = this._cachedNodes.map((n) => n.projection);
    this._lastVisibleMessagePairs = this._branchSource
      .extractMessages(this._cachedNodes)
      .slice(this._hiddenMessageCount);
    this._emitUpdate();
  }

  /**
   * Emit the `update` event unless a {@link loadUntil} walk is in progress, in
   * which case it is suppressed (see {@link _walkInProgress}) — the snapshot is
   * still refreshed by the caller, only the notification is held until the walk
   * settles on the trimmed tail.
   */
  private _emitUpdate(): void {
    if (!this._walkInProgress) this._emitter.emit('update');
  }

  // -------------------------------------------------------------------------
  // Public query methods
  // -------------------------------------------------------------------------

  getMessages(): CodecMessage<TMessage>[] {
    return this._lastVisibleMessagePairs;
  }

  runs(): RunInfo[] {
    // `_cachedNodes` is the visible node chain (inputs + reply runs) with
    // pagination and sibling selection already applied. RunInfo is reply-run
    // shaped, so filter to runs before projecting.
    return this._cachedNodes
      .filter((node): node is RunNode<TProjection> => node.kind === 'run')
      .map((node) => _toRunInfo(node));
  }

  /**
   * Compute the fresh visible node chain. The branch source already applies
   * kind-blind reachability and sibling selection (edit versions / regenerate
   * runs collapse to the selected member), so the View only layers its
   * pagination window on top: drop nodes whose key is currently withheld.
   * @returns A fresh array of visible nodes (inputs + reply runs).
   */
  private _computeFlatNodes(): ConversationNode<TProjection>[] {
    const treeNodes = this._branchSource.visibleNodes();
    if (this._withheldRunIds.size === 0) return treeNodes;
    return treeNodes.filter((node) => !this._withheldRunIds.has(nodeKey(node)));
  }

  /**
   * Recompute the visible node chain, refresh the cache + snapshot, and emit
   * `update` unconditionally. Use after a mutation that always changes the
   * visible output (e.g. an explicit selection or a withheld-batch reveal).
   */
  recomputeAndEmit(): void {
    this._cachedNodes = this._computeFlatNodes();
    this._updateVisibleSnapshot(this._cachedNodes);
    this._emitUpdate();
  }

  /**
   * Recompute the visible node chain and, only if it differs from the current
   * snapshot, refresh the cache + snapshot and emit `update`. Use after a
   * mutation that may or may not move the visible window (e.g. a structural
   * tree update, or a deferred regenerate promotion that may already match).
   */
  recomputeAndEmitIfChanged(): void {
    const nodes = this._computeFlatNodes();
    if (this._visibleChanged(nodes)) {
      this._cachedNodes = nodes;
      this._updateVisibleSnapshot(nodes);
      this._emitUpdate();
    }
  }

  hasOlder(): boolean {
    return this._hiddenMessageCount > 0 || this._withheldBuffer.length > 0 || this._hydrator.hasNext();
  }

  /**
   * Reveal `limit` more older codecMessages in this view — fewer only when
   * channel history is exhausted.
   *
   * Internally runs are revealed WHOLE (run-granular withholding), counting
   * codecMessages to decide how many runs to bring in, then the flat list
   * returned by {@link getMessages} is trimmed to exactly `limit` more
   * messages. So a run straddling the boundary still appears in {@link runs}
   * (it's a revealed node) while only its newest messages show in
   * `getMessages`. Live messages append at the newest end and are never
   * trimmed.
   * @param limit - Number of older codecMessages to reveal. Must be a positive
   *   integer. Defaults to 10.
   * @returns The revealed codecMessages, oldest-first; `[]` when nothing older was revealed.
   * @throws {Ably.ErrorInfo} `InvalidArgument` if `limit` is not a positive integer.
   */
  async loadOlder(limit = 10): Promise<CodecMessage<TMessage>[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Ably.ErrorInfo(
        `unable to load older messages; limit must be a positive integer, got ${String(limit)}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    if (this._closed || this._loadingOlder) return [];
    this._loadingOlder = true;
    this._logger.trace('DefaultView.loadOlder();', { limit });
    // Publish the in-flight promise (set synchronously, before the first await,
    // so a concurrent caller that observes `_loadingOlder === true` always finds
    // it) so `loadUntil` can await this load rather than busy-spinning.
    const inFlight = this._doLoadOlder(limit);
    this._loadInFlight = inFlight;
    return inFlight;
  }

  /**
   * The body of {@link loadOlder}, run once the single-flight guard is held.
   * Split out so `loadOlder` can publish the in-flight promise synchronously.
   * `loadOlder` sets the `_loadingOlder` / `_loadInFlight` guard pair; this
   * method owns clearing both (in its `finally`), so the set/clear is a
   * deliberate wrapper-sets / body-clears pair.
   * @param limit - Number of older codecMessages to reveal.
   * @returns The revealed codecMessages, oldest-first; `[]` when nothing older was revealed.
   */
  private async _doLoadOlder(limit: number): Promise<CodecMessage<TMessage>[]> {
    // Anchor the revealed page on the current oldest visible codec-message-id:
    // the page is "everything now above the previous oldest message". For a
    // non-empty window this is robust to a live message folding in at the tail
    // during the await below — live arrivals append at the newest end, so they
    // fall after the anchor and are excluded from the older page returned here.
    // (On a first load over an empty window there is no anchor, so the whole
    // revealed window is returned — see `_revealedSince`.)
    const prevOldestId = this._lastVisibleMessagePairs[0]?.codecMessageId;

    try {
      // Phase A: the boundary run is already revealed (a previous loadOlder
      // pulled in a whole run that overshot the message limit); reveal more of
      // its trimmed-off oldest messages without fetching or revealing new runs.
      if (this._hiddenMessageCount >= limit) {
        this._hiddenMessageCount -= limit;
        this.recomputeAndEmit();
        return this._revealedSince(prevOldestId);
      }

      // Phase B: reveal whole older runs covering the remaining message budget,
      // then re-trim so exactly `limit` new messages surface. Runs are revealed
      // whole (node granularity); the trim makes the message count exact.
      const need = limit - this._hiddenMessageCount;
      const before = this._branchSource.extractMessages(this._computeFlatNodes()).length;
      const revealedSoFar = (): number => this._branchSource.extractMessages(this._computeFlatNodes()).length - before;

      // Drain the withheld buffer toward `need` (whole older runs, newest-first).
      if (this._withheldBuffer.length > 0) {
        const splitIdx = messageTailSplitIndex(this._withheldBuffer, need, (p) => this._codec.getMessages(p));
        const batch = this._withheldBuffer.splice(splitIdx);
        this._releaseWithheld(batch);
      }

      // If the buffer was empty or fell short of `need` (e.g. it held a
      // zero-message run), fetch channel history for the remainder. The fetch
      // path loops over pages internally until it covers its target or history
      // is exhausted, so a single call here suffices.
      if (revealedSoFar() < need) {
        await this._fetchOlder(need - revealedSoFar());
        // close() may fire during the await above.
        if (this._closed) return [];
      }

      const after = this._branchSource.extractMessages(this._computeFlatNodes()).length;
      // `after - before` whole-run messages were added at the oldest end; show
      // `limit` of them (newest), hiding the overshoot plus what was already
      // trimmed. `<= 0` when history is exhausted before `limit` is reached.
      this._hiddenMessageCount = Math.max(0, this._hiddenMessageCount + (after - before) - limit);
      this.recomputeAndEmit();
      return this._revealedSince(prevOldestId);
    } catch (error) {
      this._logger.error('DefaultView.loadOlder(); failed', { error });
      throw error;
    } finally {
      this._loadingOlder = false;
      this._loadInFlight = undefined;
    }
  }

  async loadUntil(
    predicate: (message: CodecMessage<TMessage>) => boolean,
    signal?: AbortSignal,
  ): Promise<CodecMessage<TMessage>[]> {
    this._logger.trace('DefaultView.loadUntil();');

    // Already aborted before we start — resolve to `[]` (the documented aborted
    // result) without queueing or scanning. The in-loop check catches an abort
    // mid-walk, and `_walk` re-checks for one that fires while queued; this
    // catches one that fired before the walk was even scheduled.
    if (signal?.aborted) return [];

    // Serialize walks. React StrictMode double-invokes the hook effect, starting
    // two walks over one view (the first aborted on cleanup, the second live). A
    // plain concurrent run interleaves them on the shared trim state
    // (`_hiddenMessageCount` + the withheld buffer) and the single-flight
    // `loadOlder` — one walk's reveal un-hides what the other just hid — leaving
    // the window UNTRIMMED (the whole conversation rather than the post-seam
    // tail), so a seeded subscriber composes `seed ⧺ window` with every id
    // duplicated. Chaining each walk after the previous means only one mutates
    // the window at a time; the later walk re-walks from the trimmed state and
    // converges on the same tail.
    // When idle, start the walk synchronously (so an un-contended walk reaches
    // its first history fetch in the same tick, as a single walk always has);
    // when a walk is already in flight, chain this one after it (`prior` is
    // already rejection-swallowed, so `.then` runs regardless of its outcome).
    const prior = this._walkTail;
    const run =
      prior === undefined ? this._walk(predicate, signal) : prior.then(async () => this._walk(predicate, signal));
    // Track the in-flight tail (rejection-swallowed so a failed walk can't reject
    // the next), and clear it once the queue drains so the next idle walk starts
    // synchronously again.
    const tail = run.then(
      () => {
        /* outcome surfaces to the caller via `run`; the queue only needs ordering */
      },
      () => {
        /* same — a rejected walk must not reject the next queued walk */
      },
    );
    this._walkTail = tail;
    void tail.finally(() => {
      if (this._walkTail === tail) this._walkTail = undefined;
    });
    return run;
  }

  /**
   * Run one seam walk exclusively (serialized by {@link loadUntil}). Suppresses
   * intermediate `update` emission for the walk's duration (see
   * {@link _walkInProgress}) and emits a single settled `update` once the window
   * is the trimmed tail. Scans the warm window for the seam, else pages back one
   * reveal at a time until the seam is found (trimming it and everything older
   * into the withheld region) or history is exhausted.
   * @param predicate - Identifies the seam — the newest message the caller already holds.
   * @param signal - Optional abort signal; an abort resolves the walk to `[]`.
   * @returns The not-yet-seeded tail (messages strictly newer than the seam), oldest-first.
   */
  private async _walk(
    predicate: (message: CodecMessage<TMessage>) => boolean,
    signal: AbortSignal | undefined,
  ): Promise<CodecMessage<TMessage>[]> {
    // The signal may have fired while this walk waited behind another in the
    // queue. (A close mid-walk is handled by the walk loop and the `finally`.)
    if (signal?.aborted) return [];
    this._walkInProgress = true;
    // Terminal outcome for the exit log; defaults to the abort/close path, which
    // returns `[]` below without setting it.
    let outcome: 'seam' | 'exhausted' | 'aborted' = 'aborted';
    try {
      // The seam may already be visible (a warm window): trim to it and return
      // without paging. Scanning here also covers the page the first reveal
      // returns whole.
      const tailAtSeam = (page: CodecMessage<TMessage>[]): CodecMessage<TMessage>[] | undefined => {
        const idx = page.findIndex((m) => predicate(m));
        if (idx === -1) return undefined;
        // `page` is always the window's oldest-end prefix (the initial window, or
        // the slice `loadOlder` just prepended), so the match's index within it is
        // its index within the window. Trim the window to exclude the seam and
        // everything older: the seam is the single overlap the caller already holds,
        // and any history a reveal fetched beyond it (the initial attach window, or a
        // wider earlier `loadOlder`) sits in the caller's store too. Hiding it leaves
        // `getMessages()` reporting exactly the not-yet-seeded tail — equal to this
        // method's result — rather than the over-fetched history below the seam.
        this._hiddenMessageCount += idx + 1;
        this.recomputeAndEmit();
        // The window is now the tail: the messages strictly newer than the seam.
        return [...this._lastVisibleMessagePairs];
      };

      const initial = tailAtSeam(this._lastVisibleMessagePairs);
      if (initial !== undefined) {
        outcome = 'seam';
        return initial;
      }

      // Page back one codecMessage at a time, inspecting only each revealed page.
      // Locating-aware: keep paging while older history remains even when a reveal
      // surfaces nothing yet (the pin is unanchored / the trigger hasn't folded).
      // The `_closed` re-check is load-bearing: `loadOlder` returns `[]` on a closed
      // view while `hasOlder()` may still report true, so without it this loop would
      // spin.
      while (this.hasOlder()) {
        if (this._closed || signal?.aborted) return [];
        // Another loadOlder is already running — e.g. a second loadUntil walk from
        // the same view (React StrictMode double-invokes the hook effect, starting
        // two concurrent walks). `loadOlder` returns `[]` synchronously to a
        // concurrent caller, so calling it here would spin a tight microtask loop
        // that never yields to the running load's network fetch — starving the
        // event loop and hanging the page. Await the in-flight load instead, then
        // re-evaluate from its result.
        if (this._loadingOlder) {
          await this._loadInFlight;
          continue;
        }
        const tail = tailAtSeam(await this.loadOlder(1));
        if (tail !== undefined) {
          outcome = 'seam';
          return tail;
        }
      }

      // History exhausted with no seam (no seed, or a seam absent from the
      // channel): the whole window is the tail.
      outcome = 'exhausted';
      return [...this._lastVisibleMessagePairs];
    } finally {
      this._walkInProgress = false;
      this._logger.debug('DefaultView.loadUntil(); walk settled', { outcome });
      // One settled emit when the walk leaves. Skip on abort/close: an aborted
      // walk may leave a partial, not-yet-trimmed window, and the next queued
      // walk (or a `skip`-driven reset in the hook) settles it.
      if (!this._closed && !signal?.aborted) this._emitUpdate();
    }
  }

  /**
   * The slice of the current visible window that sits above `prevOldestId` — the
   * codecMessages this `loadOlder` revealed at the oldest end, oldest-first.
   * Older messages are prepended, so `prevOldestId`'s new index is the count of
   * what was revealed; everything before it is the page. Returns the whole
   * window when there was no anchor (it was empty before the reveal), and `[]`
   * when nothing was revealed. A fresh array (its `CodecMessage` elements are
   * shared with `getMessages()`, as that accessor also returns them by
   * reference).
   * @param prevOldestId - codec-message-id of the oldest visible message before this reveal.
   * @returns The revealed page, oldest-first.
   */
  private _revealedSince(prevOldestId: string | undefined): CodecMessage<TMessage>[] {
    const visible = this._lastVisibleMessagePairs;
    if (prevOldestId === undefined) return [...visible];
    // `loadOlder` only ever prepends, so the previous oldest message is still
    // present: `findIndex` is its count of newly-revealed predecessors. `idx`
    // of 0 (still oldest → nothing revealed) and the unreachable -1 both fold
    // to the empty page.
    const idx = visible.findIndex((m) => m.codecMessageId === prevOldestId);
    return idx > 0 ? visible.slice(0, idx) : [];
  }

  /**
   * Fetch older channel history covering at least `target` more codecMessages by
   * driving the shared hydrator, then reveal the newest whole runs it surfaced
   * and withhold the rest. The withheld buffer is assumed already drained by the
   * caller. The hydrator folds each page straight into the Tree and owns cursor
   * exhaustion, so this stops at `target` new visible codecMessages or when the
   * channel is exhausted. No-op once channel history is exhausted.
   * @param target - Minimum additional codecMessages this fetch aims to cover.
   */
  private async _fetchOlder(target: number): Promise<void> {
    if (!this._hydrator.hasNext()) return;

    // Snapshot before folding: every node already in the tree stays visible, so
    // only nodes the hydrator newly surfaces count toward `target`.
    const beforeKeys = new Set(this._branchSource.visibleNodes().map((n) => nodeKey(n)));
    const newVisibleCount = (): number => {
      let count = 0;
      for (const n of this._branchSource.visibleNodes()) {
        if (!beforeKeys.has(nodeKey(n))) count += this._codec.getMessages(n.projection).length;
      }
      return count;
    };

    // Suppress per-message tree events while the hydrator folds: the withheld
    // window isn't set up yet, so subscribers must not briefly see raw history.
    // `_splitReveal` emits the single settled `update` afterwards.
    this._processingHistory = true;
    try {
      await this._hydrator.foldUntil(() => newVisibleCount() >= target);
    } finally {
      this._processingHistory = false;
    }
    if (this._closed) return;

    const newVisible = this._branchSource.visibleNodes().filter((n) => !beforeKeys.has(nodeKey(n)));
    this._splitReveal(newVisible, target);
  }

  // -------------------------------------------------------------------------
  // Run lookup
  // -------------------------------------------------------------------------

  runOf(codecMessageId: string): RunInfo | undefined {
    this._logger.trace('DefaultView.runOf();', { codecMessageId });
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (!node) return undefined;
    if (node.kind === 'run') return _toRunInfo(node);
    // Input node: resolve to its selected reply run (undefined if none started).
    const reply = this._branchSource.selectedReplyRun(node.codecMessageId);
    return reply ? _toRunInfo(reply) : undefined;
  }

  run(runId: string): RunInfo | undefined {
    this._logger.trace('DefaultView.run();', { runId });
    const run = this._tree.getRunNode(runId);
    return run ? _toRunInfo(run) : undefined;
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  // Spec: AIT-CT8a, AIT-CT8b, AIT-CT8e
  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run',
    handler: (() => void) | ((msg: Ably.InboundMessage) => void) | ((event: RunLifecycleEvent) => void),
  ): () => void {
    // CAST: overload signatures enforce correct handler types per event name.
    const cb = handler as (arg: ViewEventsMap[keyof ViewEventsMap]) => void;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    if (this._closed) return;
    this._logger.info('DefaultView.close();');
    this._closed = true;
    this._loadingOlder = false;
    this._loadInFlight = undefined;
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._emitter.off();
    this._withheldRunIds.clear();
    this._withheldBuffer.length = 0;
    this._hiddenMessageCount = 0;
    this._onClose?.();
  }

  // -------------------------------------------------------------------------
  // Private: history loading
  // -------------------------------------------------------------------------

  /**
   * Reveal the newest whole runs covering `target` codecMessages from
   * `newVisible` and withhold the rest so subsequent `loadOlder` calls can
   * drain them. Reveal granularity is the whole run; the caller trims the flat
   * message list (via `_hiddenMessageCount`) to make the visible message count
   * exact. Called by {@link _fetchOlder}.
   * @param newVisible - Newly observed nodes (inputs + reply runs) from the history fetch, chronological.
   * @param target - Minimum codecMessages the revealed batch must cover.
   */
  private _splitReveal(newVisible: ConversationNode<TProjection>[], target: number): void {
    const splitIdx = messageTailSplitIndex(newVisible, target, (p) => this._codec.getMessages(p));
    const batch = newVisible.slice(splitIdx);
    const withheld = newVisible.slice(0, splitIdx);
    for (const n of withheld) {
      this._withheldRunIds.add(nodeKey(n));
    }
    this._withheldBuffer.push(...withheld);
    this._releaseWithheld(batch);
  }

  // Spec: AIT-CT11a
  private _releaseWithheld(nodes: ConversationNode<TProjection>[]): void {
    for (const n of nodes) {
      this._withheldRunIds.delete(nodeKey(n));
    }
    if (nodes.length > 0) {
      this.recomputeAndEmit();
    }
  }

  // -------------------------------------------------------------------------
  // Private: scoped event forwarding
  // -------------------------------------------------------------------------

  private _updateVisibleSnapshot(nodes?: ConversationNode<TProjection>[]): void {
    const resolved = nodes ?? this._cachedNodes;
    // Identity key = nodeKey (runId for reply runs, codecMessageId for inputs),
    // so the visible set scopes events for both kinds and input-node parents.
    this._lastVisibleNodeKeys = resolved.map((n) => nodeKey(n));
    this._lastVisibleNodeKeySet = new Set(this._lastVisibleNodeKeys);
    this._lastVisibleProjections = resolved.map((n) => n.projection);
    // Run-level reveal, message-level trim: drop the oldest `_hiddenMessageCount`
    // messages so a `loadOlder` page lands on exactly `limit` messages even
    // though whole runs were revealed.
    this._lastVisibleMessagePairs = this._branchSource.extractMessages(resolved).slice(this._hiddenMessageCount);
  }

  private _onTreeUpdate(): void {
    // Suppress update forwarding while the hydrator folds history pages. Each
    // fold fires this handler synchronously — but _withheldRunIds hasn't been
    // populated yet, so _computeFlatNodes() would return unfiltered history.
    // Without this guard, subscribers briefly see all history Runs before the
    // pagination window is applied. The final update is emitted by
    // _releaseWithheld after withholding is set up.
    if (this._processingHistory) return;

    // The Tree emits `update` only on structural change (new/removed Run,
    // sort-reorder, startSerial promotion, run-start backfill), so every
    // update reaching here warrants a full re-walk. Content-only folds flow
    // through `output` (_onTreeOutput) instead.

    // Let the branch source reconcile its selection state against the new tree
    // (pin previously-visible forks that gained siblings, roll pending
    // regenerate selections forward) before the window is recomputed.
    this._branchSource.onVisibleNodesChanged(this._lastVisibleNodeKeys);

    this.recomputeAndEmitIfChanged();
  }

  private _onTreeAblyMessage(msg: Ably.InboundMessage): void {
    // The hydrator folds history wires into the Tree and emits them through its
    // `ably-message` channel for the input-event locator's benefit; the View
    // must not surface those (the event is scoped to visible runs, and a folded
    // run isn't revealed yet). `isFolding()` is true only during the hydrator's
    // synchronous per-page fold, so a live message arriving between page fetches
    // — or any time outside a fold — is still forwarded. A visible-set check
    // alone is not enough: `_onTreeRun` adds a history run-start to the visible
    // set mid-fold (its parent sits in an older, not-yet-folded page, so it
    // reads as visible), which would otherwise let that run's folds leak.
    if (this._hydrator.isFolding()) return;

    // Re-emit only if the message corresponds to a visible Run
    const headers = getTransportHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    const runId = headers[HEADER_RUN_ID];

    if (!codecMessageId && !runId) {
      // Lifecycle / control events with no run/message identity (cancel, error)
      // are always forwarded.
      this._emitter.emit('ably-message', msg);
      return;
    }

    if (runId && this._lastVisibleNodeKeySet.has(runId)) {
      this._emitter.emit('ably-message', msg);
    }
  }

  private _onTreeRun(event: RunLifecycleEvent): void {
    // Suppress history-folded run lifecycle: the hydrator folds older runs into
    // the Tree, and `_isRunStartVisible` reads an as-yet-unresolved parent (it
    // sits in an older, not-yet-folded page) as visible — which would fire a
    // spurious `run` and add the run to the visible set, leaking its folds as
    // `ably-message`. `isFolding()` is true only during the synchronous fold, so
    // a live run-start arriving between page fetches is still added and forwarded.
    if (this._hydrator.isFolding()) return;

    // Check if the run is already on the visible branch.
    if (this._lastVisibleNodeKeySet.has(event.runId)) {
      this._emitter.emit('run', event);
      return;
    }

    // For run-start, use branch metadata to predict visibility before
    // messages arrive. Own runs have optimistic inserts (caught above).
    // Remote runs carry parent/forkOf from the agent.
    if (event.type === 'start' && this._isRunStartVisible(event)) {
      this._lastVisibleNodeKeySet.add(event.runId);
      this._emitter.emit('run', event);
    }
  }

  /**
   * Predict whether a run-start's messages will be visible on this view's
   * branch using the parent/forkOf metadata from the event.
   * @param event - The run-start lifecycle event.
   * @returns True if the run is expected to be visible on this view's branch.
   */
  private _isRunStartVisible(event: RunLifecycleEvent & { type: 'start' }): boolean {
    const { parent } = event;

    // No parent metadata — can't determine branch, forward as default.
    if (parent === undefined) return true;

    // The wire `parent` is a codec-message-id (the prior message). Resolve it
    // kind-blind to its owning NODE — an input node (the user prompt this run
    // replies to) or a prior reply run — and check that node's key against the
    // visible set. Input-node keys are populated into the set by
    // _updateVisibleSnapshot.
    const parentNode = this._tree.getNodeByCodecMessageId(parent);
    if (!parentNode) return true; // unknown parent: forward conservatively
    return this._lastVisibleNodeKeySet.has(nodeKey(parentNode));
  }

  private _visibleChanged(newNodes: ConversationNode<TProjection>[]): boolean {
    if (newNodes.length !== this._lastVisibleNodeKeys.length) return true;
    for (const [i, node] of newNodes.entries()) {
      if (nodeKey(node) !== this._lastVisibleNodeKeys[i]) return true;
      if (node.projection !== this._lastVisibleProjections[i]) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Client view — navigation + write path over the base
// ---------------------------------------------------------------------------

/**
 * The client's navigable, writable {@link ClientView}: composes a read-only
 * {@link DefaultView} base (for pagination + events + reads) and the
 * {@link NavigableBranchSource} that base reads through, adding branch
 * navigation and the write path (`send`/`regenerate`/`edit`). Navigation/write
 * mutate the source's selection state, then ask the base to recompute.
 */
class DefaultClientView<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements ClientView<TInput, TMessage> {
  private readonly _base: DefaultView<TInput, TOutput, TProjection, TMessage>;
  private readonly _branchSource: NavigableBranchSource<TInput, TOutput, TProjection, TMessage>;
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _sendDelegate: SendDelegate<TInput, TMessage>;
  private readonly _logger: Logger;
  private _closed = false;

  constructor(options: {
    base: DefaultView<TInput, TOutput, TProjection, TMessage>;
    branchSource: NavigableBranchSource<TInput, TOutput, TProjection, TMessage>;
    tree: TreeInternal<TInput, TOutput, TProjection>;
    codec: Codec<TInput, TOutput, TProjection, TMessage>;
    sendDelegate: SendDelegate<TInput, TMessage>;
    logger: Logger;
  }) {
    this._base = options.base;
    this._branchSource = options.branchSource;
    this._tree = options.tree;
    this._codec = options.codec;
    this._sendDelegate = options.sendDelegate;
    this._logger = options.logger.withContext({ component: 'ClientView' });
    this._logger.trace('DefaultClientView();');
  }

  // -------------------------------------------------------------------------
  // Read surface — delegated to the base
  // -------------------------------------------------------------------------

  getMessages(): CodecMessage<TMessage>[] {
    return this._base.getMessages();
  }

  runs(): RunInfo[] {
    return this._base.runs();
  }

  hasOlder(): boolean {
    return this._base.hasOlder();
  }

  async loadOlder(limit?: number): Promise<CodecMessage<TMessage>[]> {
    return this._base.loadOlder(limit);
  }

  async loadUntil(
    predicate: (message: CodecMessage<TMessage>) => boolean,
    signal?: AbortSignal,
  ): Promise<CodecMessage<TMessage>[]> {
    return this._base.loadUntil(predicate, signal);
  }

  runOf(codecMessageId: string): RunInfo | undefined {
    return this._base.runOf(codecMessageId);
  }

  run(runId: string): RunInfo | undefined {
    return this._base.run(runId);
  }

  on(event: 'update', handler: () => void): () => void;
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;
  on(
    event: 'update' | 'ably-message' | 'run',
    handler: (() => void) | ((msg: Ably.InboundMessage) => void) | ((event: RunLifecycleEvent) => void),
  ): () => void {
    // CAST: forward the discriminated overloads to the base unchanged; the base's
    // own overloads re-narrow per event name.
    return this._base.on(event as 'update', handler as () => void);
  }

  // -------------------------------------------------------------------------
  // Branch navigation (msg-anchored)
  // -------------------------------------------------------------------------

  branchSelection(codecMessageId: string): BranchHandle<TMessage> {
    // The handle's `select` records the selection on the branch source and, when
    // a selection was actually recorded (the id anchors a group), recomputes the
    // visible window. Non-anchor / unknown-id handles get this same closure; the
    // source no-ops and returns false, so the recompute is skipped.
    const select = (index: number): void => {
      if (this._branchSource.recordSelection(codecMessageId, index)) this._base.recomputeAndEmit();
    };
    return this._branchSource.branchSelection(codecMessageId, select);
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  // Spec: AIT-CT3, AIT-CT4
  async send(input: TInput | TInput[], options?: SendOptions): Promise<ClientRun<TMessage>> {
    this._logger.trace('DefaultClientView.send();');
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to send; view is closed', ErrorCode.InvalidArgument, 400);
    }

    const normalised = _normaliseSend<TInput>(input);

    // The codec-message-id of the visible branch tail — the delegate uses it
    // for auto-parent routing on fresh user messages.
    const parentCodecMessageId = this._base.getMessages().at(-1)?.codecMessageId;

    const result = await this._sendDelegate(normalised, options, parentCodecMessageId);
    // Auto-select the new fork branch; recompute only when a fork was set.
    if (this._branchSource.applyForkAutoSelect(result, options)) this._base.recomputeAndEmit();
    return result;
  }

  // Spec: AIT-CT5, AIT-CT13d
  async regenerate(messageId: string, options?: SendOptions): Promise<ClientRun<TMessage>> {
    this._logger.trace('DefaultClientView.regenerate();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to regenerate; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // `messageId` is the assistant being regenerated. The new Run is a
    // continuation of the regenerated message's Run, not a fork: the
    // message-level replacement (new assistant supersedes the original)
    // happens at projection extraction time. We still resolve the parent
    // user prompt so the new assistant's wire `parent` is correct,
    // and we send the truncated history (through the parent inclusive)
    // so the LLM re-answers the right message.
    const targetRun = this._runByCodecMessageId(messageId);
    if (!targetRun) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentCodecMessageId = this._findParentMsgId(targetRun, messageId);
    if (!parentCodecMessageId) {
      throw new Ably.ErrorInfo(
        `unable to regenerate; parent user message not found for ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // Canonical regen anchor: when the user clicks Regenerate on an
    // already-regenerated assistant, the new alternative SHOULD belong
    // to the SAME branch point as the previous regen — but ONLY when
    // the target is the position-equivalent of the group anchor (the
    // head message of the regenerator Run). For a trailing follow-up
    // message inside a regenerator Run (e.g. the LLM text after the
    // regenerated tool call), the user expects the regen to anchor at
    // the specific message they clicked, not roll up to the group root.
    // Rebasing trailing regens to the group root produces a confusing
    // "N+1 / N+1" counter on the tool-call bubble and runs the whole
    // turn from scratch instead of just regenerating the text.
    let regenAnchorMsgId = messageId;
    if (targetRun.regeneratesCodecMessageId !== undefined) {
      const firstMsg = this._codec.getMessages(targetRun.projection).at(0);
      if (firstMsg?.codecMessageId === messageId) {
        regenAnchorMsgId = targetRun.regeneratesCodecMessageId;
      }
    }

    const sendOptions: SendOptions = {
      ...options,
      parent: parentCodecMessageId,
    };

    // Mint a regenerate input via the codec. The codec's well-known
    // `Regenerate` carries `target: regenAnchorMsgId` and `parent:
    // parentCodecMessageId`; the session reads those fields off the input
    // directly when building transport headers (`fork-of` and
    // `parent`). The agent's input-event lookup catches the wire signal;
    // no tree-upsert / projection fold runs locally.
    const regenerate = this._codec.createRegenerate(regenAnchorMsgId, parentCodecMessageId);
    const result = await this._sendDelegate([regenerate], sendOptions, parentCodecMessageId);
    // Defer the regenerate group to the new run; promote/recompute if it changed
    // the visible window (the run may have raced ahead into the tree already).
    if (this._branchSource.applyRegenerateAutoSelect(result, regenAnchorMsgId)) this._base.recomputeAndEmitIfChanged();
    return result;
  }

  // Spec: AIT-CT6
  async edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ClientRun<TMessage>> {
    this._logger.trace('DefaultClientView.edit();', { messageId });

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to edit; view is closed', ErrorCode.InvalidArgument, 400);
    }

    // The edit target is a user prompt — a run-less INPUT node — so resolve
    // it kind-blind, not via the reply-run-only lookup.
    const targetNode = this._tree.getNodeByCodecMessageId(messageId);
    if (!targetNode) {
      throw new Ably.ErrorInfo(
        `unable to edit; message not found in tree: ${messageId}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const parentCodecMessageId = this._findParentMsgId(targetNode, messageId);

    return this.send(inputs, {
      ...options,
      forkOf: messageId,
      parent: parentCodecMessageId,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._branchSource.clear();
    this._base.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the reply Run that owns a codec-message-id, narrowing the Tree's
   * node union to a {@link RunNode}. A user-input codec-message-id resolves to
   * an input node and yields `undefined` here.
   * @param codecMessageId - The codec-message-id to resolve.
   * @returns The owning RunNode, or undefined if absent or not a reply Run.
   */
  private _runByCodecMessageId(codecMessageId: string): RunNode<TProjection> | undefined {
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    return node?.kind === 'run' ? node : undefined;
  }

  /**
   * Find the codec-message-id of the message immediately preceding `targetMsgId` in
   * the visible conversation.
   *
   * Consults the View's visible message chain first so message-level
   * replacements (regenerate) are respected: regenerating an
   * already-regenerated assistant lands the predecessor on the user
   * prompt the regen is responding to, NOT on the hidden original
   * assistant that occupies the same conversation slot. Falls back to a
   * projection-walk for the rare case where `targetMsgId` isn't on the
   * visible chain (e.g. caller is operating on a Run that's selection-
   * hidden by the current branch).
   * @param targetNode - The node (input node or reply run) that owns `targetMsgId`.
   * @param targetMsgId - The codec-message-id to find the parent of.
   * @returns The parent codec-message-id, or undefined if no predecessor exists.
   */
  private _findParentMsgId(targetNode: ConversationNode<TProjection>, targetMsgId: string): string | undefined {
    const visible = this._base.getMessages();
    const visIdx = visible.findIndex((m) => m.codecMessageId === targetMsgId);
    if (visIdx > 0) {
      return visible[visIdx - 1]?.codecMessageId;
    }
    if (visIdx === 0) return undefined;

    const messages = this._codec.getMessages(targetNode.projection);
    const idx = messages.findIndex((m) => m.codecMessageId === targetMsgId);
    if (idx > 0) {
      return messages[idx - 1]?.codecMessageId;
    }
    if (idx === 0 && targetNode.parentCodecMessageId !== undefined) {
      // The structural predecessor is the node owning parentCodecMessageId
      // (an input node, or a prior reply run). Its tail message is the parent.
      const parentNode = this._tree.getNodeByCodecMessageId(targetNode.parentCodecMessageId);
      if (parentNode) {
        return this._codec.getMessages(parentNode.projection).at(-1)?.codecMessageId;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a client View — a paginated, navigable, writable window over a Tree.
 * Wires a {@link NavigableBranchSource} (the client branch strategy) into a
 * read-only {@link DefaultView} base, then layers the navigation + write path on
 * top as a {@link DefaultClientView}.
 * @param options - The tree, codec, hydrator, send delegate, and logger to use.
 * @returns A new client view, typed as the public {@link ClientView}.
 */
export const createClientView = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: ClientViewOptions<TInput, TOutput, TProjection, TMessage>,
): ClientView<TInput, TMessage> => {
  const branchSource = new NavigableBranchSource<TInput, TOutput, TProjection, TMessage>({
    tree: options.tree,
    codec: options.codec,
    logger: options.logger,
  });
  const base = new DefaultView<TInput, TOutput, TProjection, TMessage>({
    tree: options.tree,
    codec: options.codec,
    hydrator: options.hydrator,
    branchSource,
    logger: options.logger,
    onClose: options.onClose,
  });
  return new DefaultClientView<TInput, TOutput, TProjection, TMessage>({
    base,
    branchSource,
    tree: options.tree,
    codec: options.codec,
    sendDelegate: options.sendDelegate,
    logger: options.logger,
  });
};

/**
 * Create a read-only leaf View — a paginated window over a Tree pinned to one
 * branch via the supplied {@link LeafBranchSource} (the agent's leaf-pinned
 * source). No navigation or write path: this is the shared read base, used for
 * the agent's `run.view`. Wires the source's `setNotify` to the view's recompute
 * so a `setPin` refreshes the snapshot.
 * @param options - The tree, codec, hydrator, leaf branch source, and logger to use.
 * @returns A new read-only {@link View}.
 */
export const createLeafView = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  options: Omit<ViewOptions<TInput, TOutput, TProjection, TMessage>, 'branchSource'> & {
    branchSource: LeafBranchSource<TInput, TOutput, TProjection, TMessage>;
  },
): View<TMessage> => {
  const base = new DefaultView<TInput, TOutput, TProjection, TMessage>(options);
  options.branchSource.setNotify(() => {
    base.recomputeAndEmit();
  });
  return base;
};
