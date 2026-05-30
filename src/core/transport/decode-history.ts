/**
 * decodeHistory — load conversation history from an Ably channel and
 * return decoded messages as a paginated HistoryPage result.
 *
 * Uses a fresh decoder (not shared with the live subscription) to avoid
 * state conflicts. Per-run accumulators handle interleaved runs correctly.
 *
 * The `limit` option controls the number of **messages** returned,
 * not the number of Ably wire messages fetched. The implementation pages
 * back through Ably history until `limit` complete messages have
 * been assembled. Partial runs (incomplete at the page boundary) are
 * buffered internally and completed when `next()` fetches more pages.
 *
 * Only completed messages appear in `items`. A message is complete when
 * its terminal event (finish/cancel/error) has been received.
 *
 * Because Ably history returns newest-first while the decoder requires
 * chronological order, all collected Ably messages are re-decoded from
 * oldest to newest at the point a result is built. This handles runs
 * that span page boundaries correctly. The fetch loop uses a cheap
 * header-based completion counter to decide when to stop paging, so the
 * full decode runs exactly once per traversal regardless of page count.
 */

import type * as Ably from 'ably';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_STATUS,
  HEADER_STREAM,
} from '../../constants.js';

/**
 * Headers that define a message's identity in the tree (role, parent,
 * fork-of). They are set by the FIRST wire for an `codec-message-id` and
 * must NOT be overwritten by later wires targeting the same codec-message-id.
 *
 * Why: amendment wires legitimately publish under an existing codec-message-id
 * (Option X continuation tool-resolutions and agent-side redirected
 * tool-output chunks) but carry their own continuation-scoped headers.
 * For tool-resolution publishes the amend has `role: user, parent: <self>`;
 * for agent amendments the parent points at the assistant itself. Merging
 * those over the original message's stored headers in decode-history
 * poisons `parentId` and `role` so `tree.upsert` records a self-loop
 * parent and `flattenNodes` skips the node as unreachable.
 *
 * Live channel flow doesn't have this problem because `tree.upsert`
 * already preserves `parentId` (set once on insert) and `role`
 * on re-upsert; decode-history aggregates headers per codec-message-id BEFORE
 * the first upsert, so the protection has to live here too.
 */
const IDENTITY_HEADERS: ReadonlySet<string> = new Set([HEADER_ROLE, HEADER_PARENT, HEADER_FORK_OF]);

/**
 * Merge `incoming` headers onto `existing` for the same `codec-message-id`.
 * Identity headers (see {@link IDENTITY_HEADERS}) are sticky — only set
 * when absent on `existing`; never overwritten. Everything else
 * (`status`, domain headers, etc.) merges last-wins so a closing append
 * can update `status: streaming → complete`.
 * @param existing - The accumulated headers for the codec-message-id.
 * @param incoming - The headers from a subsequent wire targeting the same codec-message-id.
 */
const mergePreservingIdentity = (existing: Record<string, string>, incoming: Record<string, string>): void => {
  for (const [key, value] of Object.entries(incoming)) {
    if (IDENTITY_HEADERS.has(key) && existing[key] !== undefined) continue;
    existing[key] = value;
  }
};
import type { Logger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import type { Codec, CodecInputEvent, CodecOutputEvent } from '../codec/types.js';
import type { HistoryPage, LoadHistoryOptions } from './types.js';

// ---------------------------------------------------------------------------
// Shared state across pages within one history traversal
// ---------------------------------------------------------------------------

interface HistoryState<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage> {
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
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
   * `codec-message-id`s for which the decoder has something to produce output
   * from: any `message.create` / `message.update` / `message.append` with
   * `stream: "true"` (establishes a tracker via create or
   * first-contact), or a `message.create` carrying `discrete` (a
   * discrete message, created and terminated in one wire message).
   */
  startedCodecMessageIds: Set<string>;
  /**
   * `codec-message-id`s with a terminal wire signal: either `discrete`
   * on a `message.create` (discrete message) or `status: "complete"`
   * / `"cancelled"` on any action (closed stream).
   */
  terminatedCodecMessageIds: Set<string>;
  /**
   * `codec-message-id`s that are both started AND terminated - ready to appear
   * in the decoded output. The fetch loop reads this set's size to decide
   * when to stop paging, avoiding a full decode per page. Maintained
   * incrementally by {@link countNewCompletions}. Grows monotonically.
   */
  completedCodecMessageIds: Set<string>;
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
const decodeAll = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  state: HistoryState<TInput, TOutput, TProjection, TMessage>,
): DecodedItem<TMessage>[] => {
  // Reverse to chronological (oldest first)
  const chronological = [...state.rawMessages].toReversed();

  // Fresh decoder and per-run projections for each full re-decode.
  const decoder = state.codec.createDecoder();
  const runs = new Map<
    string,
    {
      projection: TProjection;
      firstSeen: number;
      /** Headers from the first Ably message per codec-message-id within this run. */
      msgHeaders: Map<string, Record<string, string>>;
      /** Ably serial from the first Ably message per codec-message-id within this run. */
      msgSerials: Map<string, string>;
    }
  >();
  // Projection for non-run discrete messages (e.g. seed user-messages).
  let defaultProjection = state.codec.init();
  let orderCounter = 0;

  // Headers and serials for non-run discrete messages, keyed by codec-message-id.
  // Recorded in publication order so messages and headers can be paired
  // positionally after fold.
  const discreteCodecMessageIds: string[] = [];
  const discreteHeaders = new Map<string, Record<string, string>>();
  const discreteSerials = new Map<string, string>();

  for (const msg of chronological) {
    const { inputs, outputs } = decoder.decode(msg);
    const events: (TInput | TOutput)[] = [...inputs, ...outputs];
    const headers = getHeaders(msg);
    const runId = headers[HEADER_RUN_ID];
    const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
    const serial = msg.serial ?? '';

    // Wire `HEADER_CODEC_MESSAGE_ID` is the reducer's routing key. Events that
    // modify a previously-published message carry the original message's
    // id here (the encoder stamps `messageId` accordingly for client
    // tool outputs / approval responses / agent's redirected
    // approved-tool outputs).
    const routingCodecMessageId = codecMessageId;

    if (runId) {
      let run = runs.get(runId);
      if (!run) {
        run = {
          projection: state.codec.init(),
          firstSeen: orderCounter++,
          msgHeaders: new Map(),
          msgSerials: new Map(),
        };
        runs.set(runId, run);
      }
      // Capture headers per codec-message-id within this run. Update on later
      // messages too (e.g. closing append overrides status from
      // "streaming" to "complete"/"cancelled"). Only merge when the
      // incoming message has non-empty headers.
      if (codecMessageId) {
        const existing = run.msgHeaders.get(codecMessageId);
        if (!existing) {
          run.msgHeaders.set(codecMessageId, { ...headers });
          if (serial) run.msgSerials.set(codecMessageId, serial);
        } else if (Object.keys(headers).length > 0) {
          mergePreservingIdentity(existing, headers);
        }
      }
      for (const event of events) {
        run.projection = state.codec.fold(run.projection, event, { serial, messageId: routingCodecMessageId });
      }
    } else {
      const beforeCount = state.codec.getMessages(defaultProjection).length;
      for (const event of events) {
        defaultProjection = state.codec.fold(defaultProjection, event, { serial, messageId: routingCodecMessageId });
      }
      const afterCount = state.codec.getMessages(defaultProjection).length;
      // Record headers/serial in publication order for any newly-folded messages.
      for (let i = beforeCount; i < afterCount; i++) {
        if (codecMessageId) {
          discreteCodecMessageIds.push(codecMessageId);
          const existing = discreteHeaders.get(codecMessageId);
          if (!existing) {
            discreteHeaders.set(codecMessageId, { ...headers });
            if (serial) discreteSerials.set(codecMessageId, serial);
          } else if (Object.keys(headers).length > 0) {
            mergePreservingIdentity(existing, headers);
          }
        }
      }
    }
  }

  // Collect completed messages in chronological order (oldest first).
  const completed: DecodedItem<TMessage>[] = [];

  for (const [i, msg] of state.codec.getMessages(defaultProjection).entries()) {
    const mid = discreteCodecMessageIds[i];
    completed.push({
      message: msg,
      headers: mid ? (discreteHeaders.get(mid) ?? {}) : {},
      serial: mid ? (discreteSerials.get(mid) ?? '') : '',
    });
  }

  const sorted = [...runs.values()].toSorted((a, b) => a.firstSeen - b.firstSeen);
  for (const run of sorted) {
    // Defensive latest-serial-wins rule: within a runId, the user-message
    // with the highest Ably serial is canonical. Messages whose serial
    // precedes the winning user-message's serial belong to a losing
    // invocation and are dropped from the materialised history.
    // Continuation user-messages (`run-continue: 'true'`) are
    // skipped — they publish under the original run-id but represent
    // tool-resolution traffic and would incorrectly supersede the
    // original prompt's serial.
    let winningSerial: string | undefined;
    for (const [mid, hdrs] of run.msgHeaders) {
      if (hdrs[HEADER_ROLE] !== 'user') continue;
      if (hdrs[HEADER_RUN_CONTINUE] === 'true') continue;
      if (!hdrs[HEADER_INVOCATION_ID]) continue;
      const s = run.msgSerials.get(mid);
      if (!s) continue;
      if (winningSerial === undefined || s > winningSerial) {
        winningSerial = s;
      }
    }

    const headerEntries = [...run.msgHeaders.entries()];
    let headerIdx = 0;

    for (const message of state.codec.getMessages(run.projection)) {
      const entry = headerEntries[headerIdx];
      if (entry) {
        const [mid, hdrs] = entry;
        const serial = run.msgSerials.get(mid) ?? '';
        headerIdx++;
        if (winningSerial !== undefined && serial && serial < winningSerial) {
          // Loser: belongs to an earlier invocation under this run.
          continue;
        }
        completed.push({ message, headers: hdrs, serial });
      } else {
        completed.push({ message, headers: {}, serial: '' });
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
const decodeAllCached = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  state: HistoryState<TInput, TOutput, TProjection, TMessage>,
): DecodedItem<TMessage>[] => {
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
 * Scan newly-added raw messages and track which `codec-message-id`s have
 * become complete. Used by {@link fetchUntilLimit} to decide when enough
 * completed messages have been collected, without running the decoder.
 *
 * A codec-message-id is considered complete only when BOTH of these have been seen:
 * - a "start" signal: either `discrete` on a `message.create`
 *   (discrete messages are created and terminated by the same wire
 *   message), OR any `message.create` / `message.update` / `message.append`
 *   with `stream: "true"` (the decoder establishes a tracker via
 *   create or first-contact).
 * - a "terminal" signal: `discrete` on the create, or
 *   `status: "complete"` / `"cancelled"` on any later action.
 *
 * Why update and append count as starts: Ably history can compact a live
 * `create + append + ... + append{status:complete}` sequence into a single
 * `message.update` with `STREAM=true` and `STATUS=complete`. The decoder
 * handles that in {@link _decodeUpdate} via first-contact. Counting only
 * `message.create` as a start would cause the fetch loop to page past a
 * compacted run without ever marking it complete.
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
 * Amend-class wire messages (events targeting an existing message via
 * `HEADER_CODEC_MESSAGE_ID`) flow through the same counter — the Sets naturally
 * dedup so a tool-output amend on an already-seen codec-message-id is idempotent.
 * If an amend is encountered before any chunks for its target codec-message-id
 * (newest-first scan), the codec-message-id gets counted as one new completion;
 * subsequent pages still produce the correct decoded output because the
 * decoder runs once on the full collected log.
 *
 * Known edge case: if Ably history is truncated and a terminal survives
 * while every start signal for its codec-message-id has rolled off, the counter will
 * never mark that `codec-message-id` complete. The loop keeps fetching until it runs
 * out of pages, then returns whatever the decoder actually produced.
 * Matches the existing behaviour for the same truncation scenario.
 * @param state - The shared history traversal state.
 * @param newMessages - The Ably messages just pushed onto `state.rawMessages`.
 */
const countNewCompletions = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  state: HistoryState<TInput, TOutput, TProjection, TMessage>,
  newMessages: readonly Ably.InboundMessage[],
): void => {
  for (const msg of newMessages) {
    const headers = getHeaders(msg);
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
const fetchUntilLimit = async <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  state: HistoryState<TInput, TOutput, TProjection, TMessage>,
  ablyPage: Ably.PaginatedResult<Ably.InboundMessage>,
  limit: number,
): Promise<void> => {
  state.rawMessages.push(...ablyPage.items);
  state.lastAblyPage = ablyPage;
  countNewCompletions(state, ablyPage.items);

  const target = state.returnedCount + limit;
  while (state.completedCodecMessageIds.size < target && ablyPage.hasNext()) {
    state.logger.debug('decodeHistory.fetchUntilLimit(); fetching next page', {
      collected: state.rawMessages.length,
      completed: state.completedCodecMessageIds.size,
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
const buildResult = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>(
  state: HistoryState<TInput, TOutput, TProjection, TMessage>,
  limit: number,
): HistoryPage<TMessage> => {
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
export const decodeHistory = async <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  channel: Ably.RealtimeChannel,
  codec: Codec<TInput, TOutput, TProjection, TMessage>,
  options: LoadHistoryOptions | undefined,
  logger: Logger,
): Promise<HistoryPage<TMessage>> => {
  const limit = options?.limit ?? 100;
  const state: HistoryState<TInput, TOutput, TProjection, TMessage> = {
    codec,
    rawMessages: [],
    returnedCount: 0,
    returnedRawCount: 0,
    lastAblyPage: undefined,
    cachedDecode: undefined,
    cachedAtRawLength: 0,
    startedCodecMessageIds: new Set<string>(),
    terminatedCodecMessageIds: new Set<string>(),
    completedCodecMessageIds: new Set<string>(),
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
