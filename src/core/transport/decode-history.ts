/**
 * decodeHistory — load conversation history from an Ably channel and
 * return decoded messages as a PaginatedMessages result.
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
 * oldest to newest after each page fetch. This handles turns that span
 * page boundaries correctly.
 */

import type * as Ably from 'ably';

import { HEADER_MSG_ID, HEADER_TURN_ID } from '../../constants.js';
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec, DecoderOutput, MessageAccumulator } from '../codec/types.js';
import type { LoadHistoryOptions, PaginatedMessages } from './types.js';

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

  for (const msg of chronological) {
    const outputs: DecoderOutput<TEvent, TMessage>[] = decoder.decode(msg);
    const headers = getHeaders(msg);
    const turnId = headers[HEADER_TURN_ID];
    const msgId = headers[HEADER_MSG_ID];
    const serial = msg.serial;

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

// ---------------------------------------------------------------------------
// Fetch Ably pages until we have enough completed messages
// ---------------------------------------------------------------------------

/**
 * Fetch Ably history pages until we have enough completed messages.
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

  let decodedCount = decodeAll(state).length;
  while (decodedCount < state.returnedCount + limit && ablyPage.hasNext()) {
    state.logger.debug('decodeHistory.fetchUntilLimit(); fetching next page', {
      collected: state.rawMessages.length,
      decoded: decodedCount,
    });
    const nextPage = await ablyPage.next();
    if (!nextPage) break;
    ablyPage = nextPage;
    state.rawMessages.push(...nextPage.items);
    state.lastAblyPage = nextPage;
    decodedCount = decodeAll(state).length;
  }
};

// ---------------------------------------------------------------------------
// Build PaginatedMessages result from current state
// ---------------------------------------------------------------------------

/**
 * Build a PaginatedMessages page from the current decode state.
 * @param state - The shared history traversal state.
 * @param limit - Max messages per page.
 * @returns A page of decoded messages with a `next()` cursor.
 */
const buildResult = <TEvent, TMessage>(
  state: HistoryState<TEvent, TMessage>,
  limit: number,
): PaginatedMessages<TMessage> => {
  // allCompleted is newest-first. Slice from returnedCount for this page,
  // then reverse to chronological for display.
  const allCompleted = decodeAll(state);

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
    items: chronSlice.map((d) => d.message),
    itemHeaders: chronSlice.map((d) => d.headers),
    itemSerials: chronSlice.map((d) => d.serial),
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
 * @returns The first page of decoded history messages.
 */
// Spec: AIT-CT11, AIT-CT11b
export const decodeHistory = async <TEvent, TMessage>(
  channel: Ably.RealtimeChannel,
  codec: Codec<TEvent, TMessage>,
  options: LoadHistoryOptions | undefined,
  logger: Logger,
): Promise<PaginatedMessages<TMessage>> => {
  const limit = options?.limit ?? 100;
  const state: HistoryState<TEvent, TMessage> = {
    codec,
    rawMessages: [],
    returnedCount: 0,
    returnedRawCount: 0,
    lastAblyPage: undefined,
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
