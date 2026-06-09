/**
 * loadHistory — load conversation history from an Ably channel and return
 * the raw Ably messages as a paginated HistoryPage result.
 *
 * This does NOT decode: it pages back through Ably history via the shared
 * {@link loadHistoryPages} primitive until `limit` complete messages are
 * present, then hands the raw Ably messages (oldest-first) to the caller.
 * The View re-decodes them into the Tree itself, so load-history only needs
 * a cheap, header-based completion counter to decide when to stop paging.
 *
 * The `limit` option controls the number of complete **messages** per page,
 * not the number of Ably messages fetched. A message is complete when
 * its terminal wire signal — `status: "complete"` / `"cancelled"`, or a
 * `discrete` create — has been seen. Runs that span a page boundary are
 * handled by the counter requiring both a start and a terminal signal
 * before counting a message complete.
 *
 * Because Ably history returns newest-first, each page's `rawMessages` are
 * reversed to chronological (oldest-first) so the caller can fold them in
 * order.
 *
 * Spec: AIT-CT11, AIT-CT11b.
 */

import type * as Ably from 'ably';

import { HEADER_CODEC_MESSAGE_ID, HEADER_DISCRETE, HEADER_STATUS, HEADER_STREAM } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';
import type { HistoryPage, LoadHistoryOptions } from './types.js';

// ---------------------------------------------------------------------------
// Shared state across pages within one history traversal
// ---------------------------------------------------------------------------

interface HistoryState {
  /** Cursor over the shared `loadHistoryPages` primitive; each `next()` returns one Ably page's messages (newest-first within the page). */
  cursor: HistoryPagesCursor;
  /** All raw Ably messages collected so far, in newest-first order (as received from Ably). */
  rawMessages: Ably.InboundMessage[];
  /**
   * How many complete messages have been served to the consumer so far.
   * Drives the buffered-page logic: when a single fetch gathers more than
   * `limit` completions, later pages are served from the buffer without
   * fetching, advancing this counter `limit` at a time.
   */
  returnedCount: number;
  /** How many raw Ably messages have been served to the consumer so far. */
  returnedRawCount: number;
  /**
   * `codec-message-id`s for which a start signal has been seen: any
   * `message.create` / `message.update` / `message.append` with
   * `stream: "true"` (the decoder establishes a tracker via create or
   * first-contact), or a `message.create` carrying `discrete` (a discrete
   * message, created and terminated in one Ably message).
   */
  startedCodecMessageIds: Set<string>;
  /**
   * `codec-message-id`s with a terminal wire signal: either `discrete`
   * on a `message.create` (discrete message) or `status: "complete"`
   * / `"cancelled"` on any action (closed stream).
   */
  terminatedCodecMessageIds: Set<string>;
  /**
   * `codec-message-id`s that are both started AND terminated — counted as
   * complete. The fetch loop reads this set's size to decide when to stop
   * paging. Maintained incrementally by {@link countNewCompletions}. Grows
   * monotonically.
   */
  completedCodecMessageIds: Set<string>;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Incremental completion counting (header scan, no decode)
// ---------------------------------------------------------------------------

/**
 * Scan newly-added raw messages and track which `codec-message-id`s have
 * become complete. Used by {@link fetchUntilLimit} to decide when enough
 * completed messages have been collected, without running the decoder.
 *
 * A codec-message-id is considered complete only when BOTH of these have been seen:
 * - a "start" signal: either `discrete` on a `message.create`
 *   (discrete messages are created and terminated by the same Ably message
 *   message), OR any `message.create` / `message.update` / `message.append`
 *   with `stream: "true"` (the decoder establishes a tracker via
 *   create or first-contact).
 * - a "terminal" signal: `discrete` on the create, or
 *   `status: "complete"` / `"cancelled"` on any later action.
 *
 * Why update and append count as starts: Ably history can compact a live
 * `create + append + ... + append{status:complete}` sequence into a single
 * `message.update` with `STREAM=true` and `STATUS=complete`. The decoder
 * handles that via first-contact. Counting only `message.create` as a start
 * would cause the fetch loop to page past a compacted run without ever
 * marking it complete.
 *
 * Requiring both halves matters when a streaming run spans a page
 * boundary: the terminal arrives in the newer page (fetched first) while
 * the start sits in an older page. Counting the terminal alone would stop
 * the fetch loop prematurely - the decoder would have no stream state to
 * resolve, and the message wouldn't make it into the result.
 *
 * Messages skipped for counting:
 * - Missing `codec-message-id`: lifecycle events not tied to a domain message.
 * - `message.delete`: clears the tracker, doesn't produce output.
 *
 * Amend-class Ably messages (events targeting an existing message via
 * `HEADER_CODEC_MESSAGE_ID`) flow through the same counter — the Sets naturally
 * dedup so a tool-output amend on an already-seen codec-message-id is idempotent.
 *
 * Known edge case: if Ably history is truncated and a terminal survives
 * while every start signal for its codec-message-id has rolled off, the counter will
 * never mark that `codec-message-id` complete. The loop keeps fetching until it runs
 * out of pages, then returns whatever raw messages it collected.
 * @param state - The shared history traversal state.
 * @param newMessages - The Ably messages just pushed onto `state.rawMessages`.
 */
const countNewCompletions = (state: HistoryState, newMessages: readonly Ably.InboundMessage[]): void => {
  for (const msg of newMessages) {
    const headers = getTransportHeaders(msg);
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    if (!codecMessageId) continue;

    const action = msg.action;
    const isDiscreteCreate = action === 'message.create' && HEADER_DISCRETE in headers;
    // Any content-producing action on a streamed serial counts as a start:
    // the decoder uses create or first-contact (update/append) to establish
    // its tracker. Delete clears tracker state and emits nothing, so it
    // never counts as a start.
    const hasStreamContent =
      headers[HEADER_STREAM] === 'true' &&
      (action === 'message.create' || action === 'message.update' || action === 'message.append');
    const status = headers[HEADER_STATUS];
    const isTerminal = status === 'complete' || status === 'cancelled';

    if (isDiscreteCreate || hasStreamContent) state.startedCodecMessageIds.add(codecMessageId);
    if (isDiscreteCreate || isTerminal) state.terminatedCodecMessageIds.add(codecMessageId);
    if (state.startedCodecMessageIds.has(codecMessageId) && state.terminatedCodecMessageIds.has(codecMessageId)) {
      state.completedCodecMessageIds.add(codecMessageId);
    }
  }
};

// ---------------------------------------------------------------------------
// Pull pages from the shared iterator until we have enough completions
// ---------------------------------------------------------------------------

/**
 * Pull chunks from the shared {@link loadHistoryPages} iterator until enough
 * completed messages have been collected (target = already-returned +
 * `limit`) or the iterator is exhausted.
 *
 * Uses {@link countNewCompletions} — a cheap O(new messages) header scan —
 * to decide when to stop, rather than running the decoder per page.
 * @param state - The shared history traversal state.
 * @param limit - Target number of completed messages beyond what has already been returned.
 */
const fetchUntilLimit = async (state: HistoryState, limit: number): Promise<void> => {
  const target = state.returnedCount + limit;
  while (state.completedCodecMessageIds.size < target && state.cursor.hasNext()) {
    state.logger.debug('loadHistory.fetchUntilLimit(); pulling next page', {
      collected: state.rawMessages.length,
      completed: state.completedCodecMessageIds.size,
    });
    const chunk = await state.cursor.next();
    if (!chunk) break;
    state.rawMessages.push(...chunk);
    countNewCompletions(state, chunk);
  }
};

// ---------------------------------------------------------------------------
// Build HistoryPage result from current state
// ---------------------------------------------------------------------------

/**
 * Build a HistoryPage of raw Ably messages from the current fetch state.
 * @param state - The shared history traversal state.
 * @param limit - Max complete messages per page.
 * @returns A page of raw history messages with a `next()` cursor.
 */
const buildResult = (state: HistoryState, limit: number): HistoryPage => {
  // Advance the served-completion counter by up to `limit`, mirroring the
  // page granularity the consumer asked for. `rawMessages` for this page are
  // all messages fetched since the previous page (empty for buffered pages).
  const totalCompleted = state.completedCodecMessageIds.size;
  const served = Math.min(limit, Math.max(0, totalCompleted - state.returnedCount));
  state.returnedCount += served;

  const moreCompleted = totalCompleted > state.returnedCount;
  const moreFromCursor = state.cursor.hasNext();

  // Raw Ably messages for this page in chronological order (oldest first).
  const newRawCount = state.rawMessages.length - state.returnedRawCount;
  const rawMessages = newRawCount > 0 ? state.rawMessages.slice(state.returnedRawCount).toReversed() : [];
  state.returnedRawCount = state.rawMessages.length;

  return {
    rawMessages,
    hasNext: () => moreCompleted || moreFromCursor,
    next: async () => {
      if (moreCompleted) {
        return buildResult(state, limit);
      }
      if (!moreFromCursor) return;
      await fetchUntilLimit(state, limit);
      return buildResult(state, limit);
    },
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load conversation history from a channel and return the raw Ably messages.
 *
 * Drives the shared {@link loadHistoryPages} primitive with
 * `untilAttach: true` (gapless continuity with the live subscription) and a
 * Ably message page limit that overprovisions for the many-Ably-messages-per-domain-message
 * ratio. Each `HistoryPage` returned covers up to `limit` complete domain
 * messages; subsequent pages drain over-collected messages from the buffer
 * before pulling more from the iterator.
 *
 * The `limit` option controls the number of complete messages returned per
 * page, not the number of Ably messages fetched.
 * @param channel - The Ably channel to load history from.
 * @param options - Pagination options.
 * @param logger - Logger for diagnostic output.
 * @returns The first page of raw history messages.
 */
// Spec: AIT-CT11, AIT-CT11b
export const loadHistory = async (
  channel: Ably.RealtimeChannel,
  options: LoadHistoryOptions | undefined,
  logger: Logger,
): Promise<HistoryPage> => {
  const limit = options?.limit ?? 100;

  logger.trace('loadHistory();', { limit });

  // Request more Ably messages per page than the domain-message limit to
  // account for the many-to-one ratio (multiple Ably messages per domain message).
  // The wire pagination is internal to the iterator; the consumer-visible
  // pagination is by complete domain messages.
  const wireLimit = limit * 10;

  const cursor = await loadHistoryPages(channel, {
    pageLimit: wireLimit,
    untilAttach: true,
    logger,
  });

  const state: HistoryState = {
    cursor,
    rawMessages: [],
    returnedCount: 0,
    returnedRawCount: 0,
    startedCodecMessageIds: new Set<string>(),
    terminatedCodecMessageIds: new Set<string>(),
    completedCodecMessageIds: new Set<string>(),
    logger,
  };

  await fetchUntilLimit(state, limit);
  return buildResult(state, limit);
};
