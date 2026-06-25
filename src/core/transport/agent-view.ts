/**
 * AgentView — internal, server-side message-loading + input-event lookup for
 * AgentSession.
 *
 * Encapsulates everything the agent needs to read conversation state off the
 * channel: locating the triggering input event before `run-start`
 * ({@link AgentView.findInputEvent}), and reconstructing the ancestor chain for
 * an LLM prompt ({@link AgentView.loadConversation} / {@link AgentView.messages}).
 *
 * It does NOT own the materialisation Tree — AgentSession owns the Tree and the
 * applier (and swaps them on channel continuity loss) and injects them here as
 * `readonly` fields, the same way ClientSession wires `DefaultView`. Because
 * AgentSession swaps the Tree, it RECREATES the AgentView on continuity loss
 * (a fresh instance bound to the fresh Tree/applier) rather than mutating it —
 * so this class never needs a tree accessor or a reset hook.
 *
 * This is deliberately internal: it is not exported from any entry point and
 * does NOT implement the public `View` interface (that is the client-side
 * `DefaultView`, unrelated to this class).
 *
 * Both `findInputEvent` and `loadConversation` drive ONE history-walk mechanism
 * — the single-flight chain in {@link AgentView._driveHistoryChain} — so a
 * `start()` input scan and a concurrent `loadConversation` share folded pages
 * instead of each scanning the channel.
 */

import * as Ably from 'ably';

import { HEADER_EVENT_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import { foldAndEmit, type WireApplier } from './decode-fold.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';
import type { TreeInternal } from './tree.js';
import type { ConversationNode, Tree } from './types.js';

// ---------------------------------------------------------------------------
// Input-event lookup result
// ---------------------------------------------------------------------------

/**
 * Result of {@link AgentView.findInputEvent}. The lookup races the session's
 * Tree (`findAblyMessageByEventId` pre-scan + `'ably-message'` event for live
 * arrivals) against a bounded history scan; resolves with the single matched
 * input event.
 *
 * Run.start reads `headers` / `clientId` from the matched message to derive
 * per-run metadata (run-id, parent, forkOf, continuation flag, publisher
 * clientId). The Tree has already folded the message by the time the lookup
 * resolves, so callers do NOT need to decode the raw matched message
 * themselves.
 */
export interface InputEventLookupResult {
  /** Transport headers of the matched input event (run metadata). */
  headers?: Record<string, string>;
  /** Publisher's Ably channel-level `clientId` from the matched input event. */
  clientId?: string;
}

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

/**
 * Wrap an unknown history-walk failure as `Ably.ErrorInfo`, preserving the
 * original code/statusCode when the failure already carried them and
 * attaching the original as `cause`. Falls back to `HistoryFetchFailed`.
 * @param operation - The failed operation, phrased for an `unable to <operation>; <reason>` message.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
const wrapHistoryError = (operation: string, error: unknown): Ably.ErrorInfo => {
  const errInfo = errorCause(error);
  return new Ably.ErrorInfo(
    `unable to ${operation}; ${errorMessage(error)}`,
    errInfo?.code ?? ErrorCode.HistoryFetchFailed,
    errInfo?.statusCode ?? 500,
    errInfo,
  );
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor dependencies for {@link AgentView}, injected by AgentSession.
 *
 * AgentView holds `tree` + `applier` directly (like `DefaultView`). AgentSession
 * owns them and, because it SWAPS the Tree on continuity loss, recreates the
 * AgentView with the fresh Tree/applier rather than mutating them in place.
 */
export interface AgentViewOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The session's materialisation Tree (read for walks; folded into by history). */
  tree: TreeInternal<TInput, TOutput, TProjection>;
  /** The Ably channel to read history from. */
  channel: Ably.RealtimeChannel;
  /** Codec used to project per-node messages. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** The Tree's decode-and-apply engine; history pages fold through it. */
  applier: WireApplier;
  /** Logger for diagnostic output. */
  logger?: Logger;
  /**
   * Age bound for the input-event scan: the scan gives up paging once it
   * crosses `Date.now() - inputEventLookbackMs`. Applied only to
   * `findInputEvent`, never to the ancestor-hydration walk.
   */
  inputEventLookbackMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Internal server-side view: input-event lookup + conversation loading over the
 * session Tree. See the file header for the ownership boundary.
 */
export class AgentView<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  private readonly _tree: TreeInternal<TInput, TOutput, TProjection>;
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _applier: WireApplier;
  private readonly _logger?: Logger;
  private readonly _inputEventLookbackMs: number;

  /**
   * Tail of the single-flight history-hydration chain. Each walk links behind
   * the current tail and becomes the new tail, so concurrent calls serialise
   * and share each other's folded pages instead of each scanning the channel.
   * A link never rejects (it records its error locally), so a follower awaiting
   * the tail is isolated from a prior link's failure.
   */
  private _hydrationMutex: Promise<void> | undefined;
  /**
   * Shared history-walk cursor for this AgentView's attach epoch — ONE backward
   * `untilAttach` pagination that both `findInputEvent` and `loadConversation`
   * advance. `findInputEvent` pages it until the trigger is found (or its
   * lookback give-up point) and pauses; `loadConversation` resumes from that
   * position instead of re-paging from newest, so the channel is walked once.
   * Created lazily on first use (no per-caller signal, so it outlives any one
   * caller; no lookback, so it can reach attach). The single-flight chain
   * (`_hydrationMutex`) serialises access so it is never paged concurrently. A
   * continuity-loss swap recreates the whole AgentView, so there is no in-place
   * reset.
   */
  private _cursor: HistoryPagesCursor | undefined;
  /**
   * True once the shared cursor reached attach (channel exhausted). Because the
   * cursor carries no lookback, its exhaustion is always genuine (never a
   * lookback boundary), so either caller may record it; a lookback-bounded
   * `findInputEvent` scan stops via an early `break` that leaves the cursor
   * non-exhausted, so it never sets this.
   */
  private _historyExhausted = false;

  constructor(options: AgentViewOptions<TInput, TOutput, TProjection, TMessage>) {
    this._tree = options.tree;
    this._channel = options.channel;
    this._codec = options.codec;
    this._applier = options.applier;
    this._inputEventLookbackMs = options.inputEventLookbackMs;
    this._logger = options.logger?.withContext({ component: 'AgentView' });
  }

  /**
   * Fold a single wire message into the Tree: decode-and-apply via the applier,
   * then notify Tree subscribers and populate the event-id index. Mirrors
   * AgentSession's live `_foldWire`; history pages fold through this.
   * @param wire - The inbound Ably message to fold.
   */
  private _foldWire(wire: Ably.InboundMessage): void {
    foldAndEmit(this._applier, this._tree, wire);
  }

  // -------------------------------------------------------------------------
  // Input-event lookup
  // -------------------------------------------------------------------------

  /**
   * Find the single message whose `event-id` matches `expectedEventId`,
   * racing three sources:
   *
   *  1. A pre-scan of the Tree via `findAblyMessageByEventId` for a message
   *     already folded into it from a prior live arrival.
   *  2. A live listener on the Tree's `ably-message` event for new arrivals
   *     during the call.
   *  3. The shared history walk (lookback-bounded) — pages fold into the Tree
   *     and surface through the same `ably-message` event.
   *
   * Resolves when the expected event-id is matched — whichever source
   * surfaces it first wins. On timeout: cancels the in-flight history scan and
   * rejects with `InputEventNotFound`, wrapping any history-scan failure as
   * `cause` so a broken history fetch isn't masked behind the timeout. On
   * signal abort: rejects with `InvalidArgument`.
   *
   * `headers` and `clientId` are read from the matched message for downstream
   * run-level metadata (run-id, parent, forkOf, continuation flag, publisher
   * clientId).
   * @param opts - Lookup parameters.
   * @param opts.invocationId - The invocation id this lookup is for (logging / error messages).
   * @param opts.runId - The run id this lookup is for (logging / error messages).
   * @param opts.expectedEventId - The `event-id` the lookup must observe before resolving.
   * @param opts.timeoutMs - Maximum total wait across live + history sources.
   * @param opts.signal - AbortSignal that aborts the lookup if the run is cancelled.
   * @returns The matched message's transport headers and publisher clientId.
   */
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor; async would double-wrap it
  findInputEvent(opts: {
    invocationId: string;
    runId: string;
    expectedEventId: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<InputEventLookupResult> {
    const { invocationId, runId, expectedEventId, timeoutMs, signal } = opts;
    const logger = this._logger;

    // Bounded history fetch in parallel with the live wait; this controller
    // lets the lookup cancel the in-flight fetch on timeout / abort,
    // independently of the run signal.
    const historyController = new AbortController();

    return new Promise<InputEventLookupResult>((resolve, reject) => {
      let settled = false;
      // A genuine history-scan failure (not a cancel-induced abort) recorded
      // so the timeout rejection can surface it as `cause` — the live path
      // may still win the race, so the failure alone doesn't reject.
      let historyError: Ably.ErrorInfo | undefined;
      /* eslint-disable prefer-const -- forward-declared so cleanup() / onCancelled() can reference before the listener register or the timeout schedule has run. */
      let unregisterLive: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | number | undefined;
      /* eslint-enable */

      const cleanup = (): void => {
        if (unregisterLive) unregisterLive();
        if (timer !== undefined) clearTimeout(timer);
        historyController.abort();
        signal.removeEventListener('abort', onCancelled);
      };

      const onCancelled = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Ably.ErrorInfo(
            `unable to look up input event; run ${runId} was cancelled`,
            ErrorCode.InvalidArgument,
            400,
          ),
        );
      };

      const finishOk = (m: Ably.InboundMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        logger?.debug('AgentView.findInputEvent(); matched input event', {
          runId,
          invocationId,
        });
        resolve({ headers: getTransportHeaders(m), clientId: m.clientId });
      };

      // Whether a message is the expected input event.
      const matches = (m: Ably.InboundMessage): boolean => getTransportHeaders(m)[HEADER_EVENT_ID] === expectedEventId;

      signal.addEventListener('abort', onCancelled, { once: true });
      if (signal.aborted) {
        onCancelled();
        return;
      }

      // 1. Pre-scan the Tree's event-id index for an already-folded match.
      //    Multi-run sessions where a prior run folded the message hit here
      //    synchronously.
      const preScanned = this._tree.findAblyMessageByEventId(expectedEventId);
      if (preScanned) {
        finishOk(preScanned);
        return;
      }

      // 2. Subscribe to the Tree's `ably-message` event for live arrivals.
      //    The applier folds first; `emitAblyMessage` notifies subscribers
      //    AND populates the event-id index. Wires fed in by the parallel
      //    history fetch flow through the same event so the listener picks
      //    them up uniformly.
      unregisterLive = this._tree.on('ably-message', (msg) => {
        if (!settled && matches(msg)) finishOk(msg);
      });

      // 3. Drive the shared history walk in parallel, lookback-bounded so the
      //    scan gives up (pausing the cursor) once it pages past the window
      //    rather than walking the whole channel for a missing trigger. Each
      //    page folds into the Tree, triggering the listener above. The cursor
      //    stays paused at its position; a later loadConversation resumes it.
      //    The resolution is discarded — findInputEvent never records exhaustion
      //    (loadConversation does, if it drives the cursor to attach).
      this._driveHistoryChain(
        () => settled,
        historyController.signal,
        this._inputEventLookbackMs,
        'scan history for input event',
      ).catch((error: unknown) => {
        if (settled) return;
        historyError =
          error instanceof Ably.ErrorInfo ? error : wrapHistoryError('scan history for input event', error);
        logger?.warn('AgentView.findInputEvent(); history scan failed (continuing on live path)', {
          error: errorMessage(error),
        });
      });

      // 4. Overall timeout — cancels the in-flight history fetch and
      //    rejects with InputEventNotFound.
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Ably.ErrorInfo(
            `unable to look up input event; input event ${expectedEventId} for invocation ${invocationId} not found within ${String(timeoutMs)}ms`,
            ErrorCode.InputEventNotFound,
            504,
            historyError,
          ),
        );
      }, timeoutMs);
      // Node returns an unref-able Timeout; browsers return a number. Unref
      // so a parked lookup cannot keep a Node process alive by itself.
      if (typeof timer === 'object') timer.unref();
    });
  }

  // -------------------------------------------------------------------------
  // Conversation walk
  // -------------------------------------------------------------------------

  /**
   * Reconstruct the conversation by walking the parent chain from the run's
   * input node back to the conversation root, reading already-folded
   * projections off the Tree's nodes.
   *
   * Hydrates the Tree as needed via the shared history walk
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
  // Shared history walk
  // -------------------------------------------------------------------------

  /**
   * Single-flight chain entry shared by `findInputEvent` and `loadConversation`.
   * Serialises behind any in-flight walk so the shared cursor is advanced by one
   * caller at a time (never paged concurrently), then runs one
   * {@link AgentView._walkSharedHistory}. A link never rejects (it records its
   * error locally), so a follower awaiting the chain tail is isolated from a
   * prior link's failure; this method rethrows the wrapped error from its own
   * frame after awaiting.
   *
   * Returns `exhausted` but never records `_historyExhausted`; the caller records
   * it (both callers may, since the shared cursor's exhaustion is always genuine
   * — see {@link AgentView._historyExhausted}).
   * @param shouldStop - Polled before each page; true pauses this walk.
   * @param signal - Per-call abort signal (checked between pages).
   * @param lookbackMs - Optional give-up bound for the input scan (early break).
   * @param operationLabel - Verb for the wrapped error message.
   * @returns `{ exhausted }` — true only when the shared cursor reached attach.
   */
  private async _driveHistoryChain(
    shouldStop: () => boolean,
    signal: AbortSignal,
    lookbackMs: number | undefined,
    operationLabel: string,
  ): Promise<{ exhausted: boolean }> {
    let exhausted = false;
    let fetchError: Ably.ErrorInfo | undefined;
    const prev = this._hydrationMutex ?? Promise.resolve();
    const mine = (async (): Promise<void> => {
      await prev.catch(() => {
        /* a prior link's failure is its own to throw; this link fetches independently */
      });
      if (this._historyExhausted || signal.aborted || shouldStop()) return;
      try {
        exhausted = await this._walkSharedHistory(shouldStop, signal, lookbackMs);
      } catch (error) {
        fetchError = wrapHistoryError(operationLabel, error);
      }
    })();
    this._hydrationMutex = mine;
    await mine;
    if (fetchError !== undefined) throw fetchError;
    return { exhausted };
  }

  /**
   * Advance the SHARED history cursor (lazily opening it once per attach epoch)
   * and fold each page into the session Tree via the injected `fold`, stopping
   * when `shouldStop()` returns true, the channel is exhausted, the signal
   * aborts, a continuity-loss Tree swap abandons the walk, or — when `lookbackMs`
   * is given — the walk pages past the lookback window. The cursor is NOT closed
   * on stop: it stays paused at its current position so a later caller resumes
   * from there rather than re-paging from newest. Throws (caller-wrapped) on a
   * fetch failure after `loadHistoryPages`' per-page retries.
   * @param shouldStop - Polled before each page; true pauses the walk.
   * @param signal - Per-call abort signal (checked between pages; the shared cursor carries none).
   * @param lookbackMs - Optional give-up bound: stop paging once a page's oldest
   *   message predates `Date.now() - lookbackMs`. An early `break`, NOT a cursor
   *   bound, so the cursor stays resumable and exhaustion is never reported here.
   * @returns True only when the cursor genuinely reached attach — NOT when
   *   paused by the predicate / lookback, a Tree swap, or signal abort.
   */
  private async _walkSharedHistory(
    shouldStop: () => boolean,
    signal: AbortSignal,
    lookbackMs?: number,
  ): Promise<boolean> {
    if (this._cursor === undefined) {
      this._cursor = await loadHistoryPages(this._channel, {
        pageLimit: 200,
        untilAttach: true,
        logger: this._logger,
      });
    }
    const cursor = this._cursor;
    while (cursor.hasNext() && !shouldStop()) {
      if (signal.aborted) return false;
      const chunk = await cursor.next();
      // `next()` returning undefined means the cursor is permanently spent
      // (it has cleared its current page) — genuine exhaustion.
      if (!chunk) break;
      // Ably returns history pages newest-first; fold in chronological order so
      // codec projections build oldest-to-newest (matches the live decode loop).
      for (const wire of chunk.toReversed()) {
        this._foldWire(wire);
      }
      // findInputEvent's give-up bound: once this page predates the lookback
      // window, stop scanning. The cursor stays open (hasNext() still true), so
      // loadConversation can resume past here and this never reports exhaustion.
      if (lookbackMs !== undefined) {
        const oldest = chunk.at(-1);
        if (oldest?.timestamp !== undefined && oldest.timestamp < Date.now() - lookbackMs) break;
      }
    }
    // Genuine exhaustion only: the cursor reached attach and the walk wasn't aborted.
    return !cursor.hasNext() && !signal.aborted;
  }

  /**
   * Populate the Tree with enough ancestor coverage to walk from `anchor` to
   * root (or `maxRuns` reply runs back) by driving the shared history walk.
   * Records `_historyExhausted` only when a FULL (no-lookback) walk genuinely
   * exhausts the channel.
   * @param runId - The current run's id (when adopted, its node must be present in the Tree before the walk is complete).
   * @param anchor - The input codec-message-id to walk from. Undefined means no walk is needed (current run only).
   * @param signal - AbortSignal.
   * @param maxRuns - Optional bound on the ancestor walk.
   * @param runIdAdopted - Whether the run-id came from outside (override or continuation) and so may name a run present in channel history.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when `signal` aborts;
   *   `HistoryFetchFailed` — or the underlying Ably code when the failure
   *   carried one — (original as `cause`) when this caller's own history
   *   fetch fails after retries.
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

    // Already satisfied, or a prior full walk this epoch drove history to
    // exhaustion (fetching again cannot reveal more) — nothing to do.
    if (!needsFetch() || this._historyExhausted) return;

    let exhausted: boolean;
    try {
      // Full walk — NO lookback — so an exhausted return is authoritative for
      // the attach epoch and may be recorded.
      ({ exhausted } = await this._driveHistoryChain(() => !needsFetch(), signal, undefined, 'hydrate ancestors'));
    } catch (error) {
      this._logger?.error('AgentView._hydrateAncestors(); history fetch failed', {
        runId,
        error: errorMessage(error),
      });
      throw error;
    }
    if (exhausted) this._historyExhausted = true;
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
