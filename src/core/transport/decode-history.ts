/**
 * decodeHistory — load conversation history from an Ably channel and
 * return decoded messages as a paginated HistoryPage result.
 *
 * Uses a fresh decoder (not shared with the live subscription) to avoid
 * state conflicts. Per-turn accumulators handle interleaved turns correctly.
 *
 * The `limit` option controls the number of **messages** returned,
 * not the number of Ably wire messages fetched. The implementation pages
 * back through Ably history until `limit` complete messages have
 * been assembled. Partial turns (incomplete at the page boundary) are
 * buffered internally and completed when `next()` fetches more pages.
 *
 * Only completed messages appear in `items`. A message is complete when
 * its terminal event (finish/abort/error) has been received.
 *
 * Because Ably history returns newest-first while the decoder requires
 * chronological order, all collected Ably messages are re-decoded from
 * oldest to newest at the point a result is built. This handles turns
 * that span page boundaries correctly. The fetch loop uses a cheap
 * header-based completion counter to decide when to stop paging, so the
 * full decode runs exactly once per traversal regardless of page count.
 */

import type * as Ably from 'ably';

import {
  HEADER_AMEND,
  HEADER_DISCRETE,
  HEADER_MSG_ID,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_TURN_ID,
} from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec, DecoderOutput, MessageAccumulator } from '../codec/types.js';
import type { HistoryPage, LoadHistoryOptions } from './types.js';

// ---------------------------------------------------------------------------
// Shared state across pages within one history traversal
// ---------------------------------------------------------------------------

interface HistoryState<TEvent, TMessage> {
  codec: Codec<TEvent, TMessage>;
  /** All raw Ably messages collected so far, in newest-first order (as received from Ably). */
  rawMessages: Ably.InboundMessage[];
  /** How many completed messages have been returned to the consumer so far. */
  returnedCount: number;
  /** How many raw Ably messages have been returned to the consumer so far. */
  returnedRawCount: number;
  /** The last Ably page cursor for continued pagination. */
  lastAblyPage: Ably.PaginatedResult<Ably.InboundMessage> | undefined;
  /**
   * Cached result of the last {@link decodeAll} call, reused while
   * `rawMessages` is unchanged. Invalidated implicitly by comparing
   * {@link cachedAtRawLength} against `rawMessages.length`; `rawMessages`
   * is append-only within a traversal so length is a sufficient key.
   */
  cachedDecode: DecodedItem<TMessage>[] | undefined;
  /** `rawMessages.length` at the time {@link cachedDecode} was produced. */
  cachedAtRawLength: number;
  /**
   * `x-ably-msg-id`s for which the decoder has something to produce output
   * from: any `message.create` / `message.update` / `message.append` with
   * `x-ably-stream: "true"` (establishes a tracker via create or
   * first-contact), or a `message.create` carrying `x-ably-discrete` (a
   * discrete message, created and terminated in one wire message).
   */
  startedMsgIds: Set<string>;
  /**
   * `x-ably-msg-id`s with a terminal wire signal: either `x-ably-discrete`
   * on a `message.create` (discrete message) or `x-ably-status: "finished"`
   * / `"aborted"` on any action (closed stream).
   */
  terminatedMsgIds: Set<string>;
  /**
   * `x-ably-msg-id`s that are both started AND terminated - ready to appear
   * in the decoded output. The fetch loop reads this set's size to decide
   * when to stop paging, avoiding a full decode per page. Maintained
   * incrementally by {@link countNewCompletions}. Grows monotonically.
   */
  completedMsgIds: Set<string>;
  logger: Logger;
}

/** A completed message paired with its canonical wire headers and serial. */
interface DecodedItem<TMessage> {
  message: TMessage;
  headers: Record<string, string>;
  /** Ably serial from the first Ably message for this domain message. */
  serial: string;
}

// ---------------------------------------------------------------------------
// Decode all collected messages from scratch (chronological order)
// ---------------------------------------------------------------------------

/**
 * Re-decode all collected raw messages into completed domain messages.
 * @param state - The shared history traversal state.
 * @returns Completed messages in newest-first order.
 */
const decodeAll = <TEvent, TMessage>(state: HistoryState<TEvent, TMessage>): DecodedItem<TMessage>[] => {
  // Reverse to chronological (oldest first)
  const chronological = [...state.rawMessages].toReversed();

  // Fresh decoder and per-turn accumulators for each full re-decode.
  const decoder = state.codec.createDecoder();
  const turns = new Map<
    string,
    {
      accumulator: MessageAccumulator<TEvent, TMessage>;
      firstSeen: number;
      /** Headers from the first Ably message per x-ably-msg-id within this turn. */
      msgHeaders: Map<string, Record<string, string>>;
      /** Ably serial from the first Ably message per x-ably-msg-id within this turn. */
      msgSerials: Map<string, string>;
    }
  >();
  const defaultAccumulator = state.codec.createAccumulator();
  let orderCounter = 0;

  // Headers and serials for non-turn discrete messages, keyed by x-ably-msg-id.
  const discreteHeaders = new Map<string, Record<string, string>>();
  const discreteSerials = new Map<string, string>();
  // Track which msgId produced each non-turn discrete message output (in order).
  const discreteMsgIds: string[] = [];

  // Cross-turn event targets to complete after all events are processed.
  // Deferred so that finish/abort events that follow the update in serial
  // order can still process on the active message (e.g. applying messageMetadata).
  const deferredCompletions: { accumulator: MessageAccumulator<TEvent, TMessage>; messageId: string }[] = [];

  for (const msg of chronological) {
    const outputs: DecoderOutput<TEvent, TMessage>[] = decoder.decode(msg);
    const headers = getHeaders(msg);
    const turnId = headers[HEADER_TURN_ID];
    const msgId = headers[HEADER_MSG_ID];
    const serial = msg.serial;
    const amendTarget = headers[HEADER_AMEND];

    // Cross-turn events target an existing message from a different turn.
    // Route to the owning turn's accumulator via initMessage lifecycle.
    if (amendTarget) {
      for (const turn of turns.values()) {
        if (turn.msgHeaders.has(amendTarget)) {
          const headerKeys = [...turn.msgHeaders.keys()];
          const msgIndex = headerKeys.indexOf(amendTarget);
          const currentMsg = msgIndex === -1 ? undefined : turn.accumulator.messages[msgIndex];
          if (currentMsg) {
            turn.accumulator.initMessage(amendTarget, currentMsg);
          }
          turn.accumulator.processOutputs(outputs);
          deferredCompletions.push({ accumulator: turn.accumulator, messageId: amendTarget });
          break;
        }
      }
      continue;
    }

    if (turnId) {
      let turn = turns.get(turnId);
      if (!turn) {
        turn = {
          accumulator: state.codec.createAccumulator(),
          firstSeen: orderCounter++,
          msgHeaders: new Map(),
          msgSerials: new Map(),
        };
        turns.set(turnId, turn);
      }
      // Capture headers per msg-id within this turn. Update on later
      // messages too (e.g. closing append overrides status from
      // "streaming" to "finished"/"aborted"). Only merge when the
      // incoming message has non-empty headers.
      if (msgId) {
        const existing = turn.msgHeaders.get(msgId);
        if (!existing) {
          turn.msgHeaders.set(msgId, { ...headers });
          if (serial) turn.msgSerials.set(msgId, serial);
        } else if (Object.keys(headers).length > 0) {
          Object.assign(existing, headers);
        }
      }
      turn.accumulator.processOutputs(outputs);
    } else {
      defaultAccumulator.processOutputs(outputs);

      // Capture headers and serial for non-turn discrete messages by x-ably-msg-id.
      for (const output of outputs) {
        if (output.kind === 'message' && msgId) {
          discreteMsgIds.push(msgId);
          const existingDiscrete = discreteHeaders.get(msgId);
          if (!existingDiscrete) {
            discreteHeaders.set(msgId, { ...headers });
            if (serial) discreteSerials.set(msgId, serial);
          } else if (Object.keys(headers).length > 0) {
            Object.assign(existingDiscrete, headers);
          }
        }
      }
    }
  }

  // Complete any messages that were re-activated for cross-turn updates.
  // Idempotent — if finish already removed the message from active tracking,
  // completeMessage is a no-op.
  for (const { accumulator, messageId } of deferredCompletions) {
    accumulator.completeMessage(messageId);
  }

  // Collect completed messages in chronological order (oldest first) by turn.
  const completed: DecodedItem<TMessage>[] = [];

  // Default accumulator messages: pair with their discrete headers by position.
  for (const [i, msg] of defaultAccumulator.completedMessages.entries()) {
    const mid = discreteMsgIds[i];
    completed.push({
      message: msg,
      headers: mid ? (discreteHeaders.get(mid) ?? {}) : {},
      serial: mid ? (discreteSerials.get(mid) ?? '') : '',
    });
  }

  const sorted = [...turns.values()].toSorted((a, b) => a.firstSeen - b.firstSeen);
  for (const turn of sorted) {
    // Assign headers and serials to each completed message in this turn.
    // The turn's msgHeaders map is keyed by x-ably-msg-id and ordered by
    // first-seen. Completed messages are matched positionally.
    const headerEntries = [...turn.msgHeaders.entries()];
    let headerIdx = 0;

    for (const msg of turn.accumulator.completedMessages) {
      const entry = headerEntries[headerIdx];
      if (entry) {
        const [mid, hdrs] = entry;
        completed.push({
          message: msg,
          headers: hdrs,
          serial: turn.msgSerials.get(mid) ?? '',
        });
        headerIdx++;
      } else {
        completed.push({ message: msg, headers: {}, serial: '' });
      }
    }
  }

  // Reverse to newest-first. The consumer slices from the front for the
  // most recent page, and progressively deeper for older pages.
  return completed.toReversed();
};

/**
 * Cached wrapper around {@link decodeAll}. Returns the previous result when
 * `rawMessages` hasn't changed since the last decode; otherwise re-decodes
 * and updates the cache. The cache key is `rawMessages.length` because
 * `rawMessages` is append-only within a traversal.
 * @param state - The shared history traversal state.
 * @returns Completed messages in newest-first order.
 */
const decodeAllCached = <TEvent, TMessage>(state: HistoryState<TEvent, TMessage>): DecodedItem<TMessage>[] => {
  if (state.cachedDecode && state.cachedAtRawLength === state.rawMessages.length) {
    return state.cachedDecode;
  }
  const result = decodeAll(state);
  state.cachedDecode = result;
  state.cachedAtRawLength = state.rawMessages.length;
  return result;
};

// ---------------------------------------------------------------------------
// Incremental completion counting (avoids full decode inside the fetch loop)
// ---------------------------------------------------------------------------

/**
 * Scan newly-added raw messages and track which `x-ably-msg-id`s have
 * become complete. Used by {@link fetchUntilLimit} to decide when enough
 * completed messages have been collected, without running the decoder.
 *
 * A msg-id is considered complete only when BOTH of these have been seen:
 * - a "start" signal: either `x-ably-discrete` on a `message.create`
 *   (discrete messages are created and terminated by the same wire
 *   message), OR any `message.create` / `message.update` / `message.append`
 *   with `x-ably-stream: "true"` (the decoder establishes a tracker via
 *   create or first-contact).
 * - a "terminal" signal: `x-ably-discrete` on the create, or
 *   `x-ably-status: "finished"` / `"aborted"` on any later action.
 *
 * Why update and append count as starts: Ably history can compact a live
 * `create + append + ... + append{status:finished}` sequence into a single
 * `message.update` with `STREAM=true` and `STATUS=finished`. The decoder
 * handles that in {@link _decodeUpdate} via first-contact. Counting only
 * `message.create` as a start would cause the fetch loop to page past a
 * compacted turn without ever marking it complete.
 *
 * Requiring both halves matters when a streaming turn spans a page
 * boundary: the terminal arrives in the newer page (fetched first) while
 * the start sits in an older page. Counting the terminal alone would stop
 * the fetch loop prematurely - the decoder would have no stream state to
 * resolve, and the message wouldn't make it into the result.
 *
 * Messages skipped for counting:
 * - Missing `x-ably-msg-id`: lifecycle events not tied to a domain message.
 * - `x-ably-amend` set: amendments target an existing message, not a new
 *   completion.
 * - `message.delete`: clears the tracker, doesn't produce output.
 *
 * Known edge case: if Ably history is truncated and a terminal survives
 * while every start signal for its msg-id has rolled off, the counter will
 * never mark that `msg-id` complete. The loop keeps fetching until it runs
 * out of pages, then returns whatever the decoder actually produced.
 * Matches the existing behaviour for the same truncation scenario.
 * @param state - The shared history traversal state.
 * @param newMessages - The Ably messages just pushed onto `state.rawMessages`.
 */
const countNewCompletions = <TEvent, TMessage>(
  state: HistoryState<TEvent, TMessage>,
  newMessages: readonly Ably.InboundMessage[],
): void => {
  for (const msg of newMessages) {
    const headers = getHeaders(msg);
    const msgId = headers[HEADER_MSG_ID];
    if (!msgId) continue;
    // Amendments target an existing message, not a new completion.
    // Defensive: no current encoder path produces an amendment carrying
    // HEADER_STREAM=true, HEADER_STATUS, or HEADER_DISCRETE.
    if (headers[HEADER_AMEND]) continue;

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
    const isTerminal = status === 'finished' || status === 'aborted';

    if (isDiscreteCreate || hasStreamContent) state.startedMsgIds.add(msgId);
    if (isDiscreteCreate || isTerminal) state.terminatedMsgIds.add(msgId);
    if (state.startedMsgIds.has(msgId) && state.terminatedMsgIds.has(msgId)) {
      state.completedMsgIds.add(msgId);
    }
  }
};

// ---------------------------------------------------------------------------
// Fetch Ably pages until we have enough completed messages
// ---------------------------------------------------------------------------

/**
 * Fetch Ably history pages until we have enough completed messages.
 *
 * The loop uses {@link countNewCompletions} to decide when to stop -
 * a cheap O(new messages) header scan - rather than running the full
 * decoder per page. The decoder runs exactly once later, in
 * {@link buildResult}, against the fully-collected `rawMessages`.
 * @param state - The shared history traversal state.
 * @param ablyPage - The current Ably paginated result to start from.
 * @param limit - Target number of completed messages beyond what has already been returned.
 */
const fetchUntilLimit = async <TEvent, TMessage>(
  state: HistoryState<TEvent, TMessage>,
  ablyPage: Ably.PaginatedResult<Ably.InboundMessage>,
  limit: number,
): Promise<void> => {
  state.rawMessages.push(...ablyPage.items);
  state.lastAblyPage = ablyPage;
  countNewCompletions(state, ablyPage.items);

  const target = state.returnedCount + limit;
  while (state.completedMsgIds.size < target && ablyPage.hasNext()) {
    state.logger.debug('decodeHistory.fetchUntilLimit(); fetching next page', {
      collected: state.rawMessages.length,
      completed: state.completedMsgIds.size,
    });
    const nextPage = await ablyPage.next();
    if (!nextPage) break;
    ablyPage = nextPage;
    state.rawMessages.push(...nextPage.items);
    state.lastAblyPage = nextPage;
    countNewCompletions(state, nextPage.items);
  }
};

// ---------------------------------------------------------------------------
// Build HistoryPage result from current state
// ---------------------------------------------------------------------------

/**
 * Build a HistoryPage from the current decode state.
 * @param state - The shared history traversal state.
 * @param limit - Max messages per page.
 * @returns A page of decoded history with a `next()` cursor.
 */
const buildResult = <TEvent, TMessage>(state: HistoryState<TEvent, TMessage>, limit: number): HistoryPage<TMessage> => {
  // allCompleted is newest-first. Slice from returnedCount for this page,
  // then reverse to chronological for display.
  const allCompleted = decodeAllCached(state);

  const pageSlice = allCompleted.slice(state.returnedCount, state.returnedCount + limit);
  const chronSlice = [...pageSlice].toReversed();
  state.returnedCount += pageSlice.length;

  const moreCompleted = allCompleted.length > state.returnedCount;
  const moreAblyPages = state.lastAblyPage?.hasNext() ?? false;

  // Raw Ably messages for this page in chronological order.
  const newRawCount = state.rawMessages.length - state.returnedRawCount;
  const rawSlice = newRawCount > 0 ? state.rawMessages.slice(state.returnedRawCount).toReversed() : [];
  state.returnedRawCount = state.rawMessages.length;

  return {
    items: chronSlice.map((d) => ({ message: d.message, headers: d.headers, serial: d.serial })),
    rawMessages: rawSlice,
    hasNext: () => moreCompleted || moreAblyPages,
    next: async () => {
      if (moreCompleted) {
        return buildResult(state, limit);
      }
      if (!moreAblyPages || !state.lastAblyPage) return;
      const nextAbly = await state.lastAblyPage.next();
      if (!nextAbly) return;
      await fetchUntilLimit(state, nextAbly, limit);
      return buildResult(state, limit);
    },
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load conversation history from a channel and return decoded messages.
 *
 * Attaches the channel if not already attached, then calls
 * `channel.history({ untilAttach: true })` to guarantee no gap between
 * historical and live messages. The attach is idempotent.
 *
 * The `limit` option controls the number of complete messages
 * returned per page, not the number of Ably wire messages fetched.
 * @param channel - The Ably channel to load history from.
 * @param codec - The codec for decoding wire messages into domain messages.
 * @param options - Pagination options.
 * @param logger - Logger for diagnostic output.
 * @returns The first page of decoded history.
 */
// Spec: AIT-CT11, AIT-CT11b
export const decodeHistory = async <TEvent, TMessage>(
  channel: Ably.RealtimeChannel,
  codec: Codec<TEvent, TMessage>,
  options: LoadHistoryOptions | undefined,
  logger: Logger,
): Promise<HistoryPage<TMessage>> => {
  const limit = options?.limit ?? 100;
  const state: HistoryState<TEvent, TMessage> = {
    codec,
    rawMessages: [],
    returnedCount: 0,
    returnedRawCount: 0,
    lastAblyPage: undefined,
    cachedDecode: undefined,
    cachedAtRawLength: 0,
    startedMsgIds: new Set<string>(),
    terminatedMsgIds: new Set<string>(),
    completedMsgIds: new Set<string>(),
    logger,
  };

  logger.trace('decodeHistory();', { limit });

  // Request more Ably messages than the domain limit to account for
  // the many-to-one ratio (multiple wire messages per message).
  const wireLimit = limit * 10;

  await channel.attach();
  const ablyPage = await channel.history({ untilAttach: true, limit: wireLimit });
  await fetchUntilLimit(state, ablyPage, limit);
  return buildResult(state, limit);
};
