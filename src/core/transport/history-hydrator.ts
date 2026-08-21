/**
 * HistoryHydrator — the single channel-history paging-and-fold engine.
 *
 * One backward `untilAttach` pagination over a channel that folds each wire
 * message straight into a Tree (through the Tree's shared {@link WireApplier},
 * via {@link foldAndEmit}) as it pages. Both the agent (input-event lookup +
 * ancestor hydration) and the client view drive this one engine, so the channel
 * is walked once across concurrent callers instead of each maintaining its own
 * paging loop, stop condition, and notion of exhaustion.
 *
 * The cursor is single-flight: concurrent {@link HistoryHydrator.foldUntil}
 * calls serialise behind one another so the cursor is advanced by one caller at
 * a time (never paged concurrently), and a follower resumes from where the
 * previous caller paused rather than re-paging from newest. A caller stops early
 * via its `shouldStop` predicate (polled before each page) — the stop criterion
 * lives entirely in caller code, never in a transport-side heuristic — and a
 * stop does not close the cursor, so a later caller continues from the paused
 * position. The hydrator owns and records its own exhaustion (the cursor
 * reaching attach), which it reports truthfully via
 * {@link HistoryHydrator.hasNext}.
 *
 * The hydrator follows the lifecycle of the Tree it folds into: the client
 * creates one per session; the agent recreates it alongside the Tree/applier on
 * a channel continuity-loss swap (a fresh cursor and fresh exhaustion state).
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import { type AblyMessageEmitter, foldAndEmit, type WireApplier } from './decode-fold.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';

/**
 * Default wire-message limit per Ably page fetched by the shared cursor, used
 * when the session does not set `historyPageSize`. Over-provisions for the
 * many-Ably-messages-per-domain-message ratio so a single round trip usually
 * covers several domain messages.
 */
const DEFAULT_HISTORY_PAGE_SIZE = 100;

/**
 * Wrap an unknown history-fetch failure as `Ably.ErrorInfo`, preserving the
 * original code/statusCode when the failure already carried them and attaching
 * the original as `cause`. Falls back to `SessionHistoryFetchFailed`.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
const wrapHistoryError = (error: unknown): Ably.ErrorInfo => {
  const errInfo = errorCause(error);
  return new Ably.ErrorInfo(
    `unable to fold channel history; ${errorMessage(error)}`,
    errInfo?.code ?? ErrorCode.SessionHistoryFetchFailed,
    errInfo?.statusCode ?? 500,
    errInfo,
  );
};

/**
 * The shared channel-history paging-and-fold engine. See the file header for the
 * single-flight cursor and exhaustion contract.
 */
export interface HistoryHydrator {
  /**
   * Page backward from the cursor's current position, folding each page into the
   * Tree (chronological order, oldest-first within the page) until `shouldStop`
   * returns true, the channel is exhausted, or `signal` aborts. The caller owns
   * the stop criterion entirely — there is no transport-side give-up heuristic;
   * the input-event lookup stops via a predicate wired to its "found" flag
   * (bounded by its own wait timeout), and conversation pagination stops via a
   * caller-supplied count.
   *
   * Single-flight: serialises behind any in-flight call so the shared cursor is
   * advanced by one caller at a time and resumes from where the previous caller
   * paused. A fetch failure (after the underlying per-page retries) rejects with
   * `Ably.ErrorInfo` (`SessionHistoryFetchFailed`, or the underlying code when the
   * failure carried one, with the original as `cause`).
   * @param shouldStop - Polled before each page; returning true pauses this walk.
   * @param signal - Optional abort signal, checked between pages. When it fires
   *   mid-drain the walk stops promptly, leaving the shared cursor resumable, and
   *   the call reports `exhausted: false`. The cursor itself carries no signal —
   *   it outlives any one caller — so cancellation is honoured here.
   * @returns `{ exhausted }` — true only when the cursor genuinely reached attach
   *   (never on a predicate pause or a signal abort).
   */
  foldUntil(shouldStop: () => boolean, signal?: AbortSignal): Promise<{ exhausted: boolean }>;

  /**
   * Whether the cursor may have more pages. Truthful against real exhaustion:
   * `false` once the cursor has reached attach, otherwise `true` (including
   * before the cursor is first opened, when more history may exist).
   */
  hasNext(): boolean;

  /**
   * Whether the hydrator is mid-fold: true only during the synchronous folding
   * of a fetched page (between the network awaits), false otherwise. A consumer
   * that subscribes to the Tree the hydrator folds into uses this to tell a
   * history-fold emission (suppress) from a live emission arriving between
   * fetches (forward) — the two are indistinguishable from the Tree event alone.
   */
  isFolding(): boolean;
}

/** Constructor dependencies for {@link createHistoryHydrator}. */
export interface HistoryHydratorOptions {
  /** The Ably channel to page history from. */
  channel: Ably.RealtimeChannel;
  /** The Tree to fold each paged wire into (notified via `emitAblyMessage`). */
  tree: AblyMessageEmitter;
  /** The Tree's decode-and-apply engine; each paged wire folds through it. */
  applier: WireApplier;
  /**
   * Wire-message limit per `channel.history()` round trip. Defaults to
   * {@link DEFAULT_HISTORY_PAGE_SIZE} when unset; set from the session-level
   * `historyPageSize` option.
   */
  pageSize?: number;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

/**
 * The shared channel-history paging-and-fold engine bound to one Tree/applier.
 * See the file header for the single-flight cursor and exhaustion contract.
 */
class DefaultHistoryHydrator implements HistoryHydrator {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _tree: AblyMessageEmitter;
  private readonly _applier: WireApplier;
  private readonly _pageSize: number;
  private readonly _logger?: Logger;

  /**
   * Tail of the single-flight chain. Each `foldUntil` links behind the current
   * tail and becomes the new tail, so concurrent calls serialise and share each
   * other's folded pages instead of each paging the channel. A link records its
   * own error locally rather than rejecting the chain, so a follower awaiting
   * the tail is isolated from a prior link's failure.
   */
  private _hydrationTail: Promise<void> | undefined;
  /**
   * The shared backward cursor for this hydrator's attach epoch. Opened lazily
   * on first use (capturing the attach serial then) and advanced by one caller
   * at a time under {@link _hydrationTail}. A continuity-loss swap recreates the
   * whole hydrator, so there is no in-place reset.
   */
  private _cursor: HistoryPagesCursor | undefined;
  /** True once the cursor genuinely reached attach (channel exhausted). */
  private _exhausted = false;
  /**
   * True only while synchronously folding a fetched page (never across a network
   * await). Lets a Tree subscriber discriminate a history fold from a live emit.
   */
  private _folding = false;

  constructor(options: HistoryHydratorOptions) {
    this._channel = options.channel;
    this._tree = options.tree;
    this._applier = options.applier;
    this._pageSize = options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    this._logger = options.logger?.withContext({ component: 'HistoryHydrator' });
  }

  hasNext(): boolean {
    if (this._exhausted) return false;
    // Cursor not yet opened — there may be history to fetch.
    if (this._cursor === undefined) return true;
    return this._cursor.hasNext();
  }

  isFolding(): boolean {
    return this._folding;
  }

  async foldUntil(shouldStop: () => boolean, signal?: AbortSignal): Promise<{ exhausted: boolean }> {
    this._logger?.trace('HistoryHydrator.foldUntil();');

    let fetchError: Ably.ErrorInfo | undefined;
    const prev = this._hydrationTail ?? Promise.resolve();
    // The chain link: it always awaits `prev` in full before walking, so the
    // cursor is advanced by one caller at a time (single-flight). It stays the
    // tail even if this caller is released early below, so a later caller that
    // links behind it still waits for the prior walk to finish — never paging
    // the cursor concurrently.
    const mine = (async (): Promise<void> => {
      await prev.catch(() => {
        /* a prior link's failure is its own to throw; this link fetches independently */
      });
      if (this._exhausted || signal?.aborted || shouldStop()) return;
      try {
        await this._walk(shouldStop, signal);
      } catch (error) {
        fetchError = wrapHistoryError(error);
      }
    })();
    this._hydrationTail = mine;

    // Release this caller when its link settles OR its own signal aborts — a
    // leader paging toward exhaustion (e.g. an input-event scan whose trigger
    // never matches, bounded only by the lookup timeout) can hold the chain for
    // a long time, and a queued caller whose own run is cancelled must not be
    // trapped behind it. `mine` remains the tail and finishes awaiting `prev` on
    // its own (then returns without walking, since the signal aborted), so
    // single-flight is preserved. The caller observes the abort itself.
    let onAbort: (() => void) | undefined;
    try {
      // `.then(...)` is a Promise.race discriminant: tag which branch settled
      // first so an early abort is distinguished from a completed walk.
      const aborted = await new Promise<boolean>((resolve) => {
        void mine.then(() => {
          resolve(false);
        });
        if (signal === undefined) return; // no signal — only `mine` can settle the race
        if (signal.aborted) {
          resolve(true);
          return;
        }
        onAbort = (): void => {
          resolve(true);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Surface a fetch failure only on the completed-walk path; on early abort
      // the caller handles its own cancellation.
      if (!aborted && fetchError !== undefined) throw fetchError;
    } finally {
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }

    // `_exhausted` is the single source of truth, so the reported exhaustion
    // always agrees with {@link hasNext} — including for a caller short-circuited
    // because the channel was already drained.
    return { exhausted: this._exhausted };
  }

  /**
   * Advance the shared cursor (opening it lazily once per attach epoch) and fold
   * each page into the Tree via {@link foldAndEmit}, stopping when `shouldStop`
   * returns true, the channel is exhausted, or the signal aborts. The cursor is
   * left paused (not closed) on a stop so a later caller resumes from here.
   * Records `_exhausted` when the cursor genuinely reaches attach.
   * @param shouldStop - Polled before each page; true pauses the walk.
   * @param signal - Optional abort signal, checked between pages.
   */
  private async _walk(shouldStop: () => boolean, signal: AbortSignal | undefined): Promise<void> {
    if (this._cursor === undefined) {
      this._cursor = await loadHistoryPages(this._channel, {
        pageLimit: this._pageSize,
        untilAttach: true,
        logger: this._logger,
      });
    }
    const cursor = this._cursor;

    while (cursor.hasNext() && !shouldStop()) {
      if (signal?.aborted) return;
      const chunk = await cursor.next();
      // `next()` returning undefined means the cursor is permanently spent —
      // genuine exhaustion.
      if (!chunk) break;
      // Ably returns history pages newest-first; fold in chronological order so
      // codec projections build oldest-to-newest (matching the live decode loop).
      // Mark the fold synchronously so a Tree subscriber can tell these emits
      // from a live one; the loop never awaits, so no live emit interleaves.
      this._folding = true;
      try {
        for (const wire of chunk.toReversed()) {
          foldAndEmit(this._applier, this._tree, wire);
        }
      } finally {
        this._folding = false;
      }
    }

    // Genuine exhaustion only: the cursor reached attach and the walk wasn't aborted.
    if (!cursor.hasNext() && !signal?.aborted) {
      this._exhausted = true;
      this._logger?.debug('HistoryHydrator._walk(); channel exhausted');
    }
  }
}

/**
 * Create a {@link HistoryHydrator} bound to a channel, Tree, and applier.
 * @param options - The channel, Tree, applier, and logger.
 * @returns A new hydrator.
 */
export const createHistoryHydrator = (options: HistoryHydratorOptions): HistoryHydrator =>
  new DefaultHistoryHydrator(options);
