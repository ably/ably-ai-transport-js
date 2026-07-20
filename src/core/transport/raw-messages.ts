/**
 * Helpers for sharing a session channel with plain Ably Pub/Sub traffic.
 *
 * The transport reserves the `ai-` message-name prefix and the `extras.ai`
 * envelope for its own wire traffic; everything else on the channel is
 * "foreign" — application-owned raw messages (e.g. a human-handoff window
 * recorded alongside the AI conversation). Four pieces make that record
 * usable:
 *
 * - {@link isForeignMessage} / {@link isTransportMessage} — classify a channel
 *   message as raw application traffic or transport wire traffic.
 * - {@link fetchRawHistory} — read the raw record back off the channel by
 *   paging history, so a cold-started client or agent can always (re-)fetch
 *   raw messages without having observed them live.
 * - {@link mergeBySerial} — interleave a View's conversation messages with raw
 *   messages into one serial-ordered transcript.
 * - {@link runStartSerialOf} — the canonical `serialOf` lookup for the merge,
 *   built from a View and its Tree.
 */

import * as Ably from 'ably';

import { TRANSPORT_NAME_PREFIX } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { getAiEnvelope } from '../../utils.js';
import type { CodecMessage, CodecOutputEvent } from '../codec/types.js';
import { loadHistoryPages } from './load-history-pages.js';
import type { Tree, View } from './types.js';

/** Wire messages per history page fetched by {@link fetchRawHistory}. */
const RAW_HISTORY_PAGE_LIMIT = 100;

/** Default cap on history pages read by {@link fetchRawHistory}. */
const DEFAULT_MAX_PAGES = 50;

/**
 * Whether a channel message is transport wire traffic. The SDK reserves the
 * `ai-` message-name prefix and the `extras.ai` envelope; a message carrying
 * either is transport traffic.
 * @param message - The channel message to classify.
 * @returns True when the message is transport wire traffic.
 */
export const isTransportMessage = (message: Ably.InboundMessage): boolean => {
  if (typeof message.name === 'string' && message.name.startsWith(TRANSPORT_NAME_PREFIX)) return true;
  return getAiEnvelope(message) != undefined;
};

/**
 * Whether a channel message is plain Pub/Sub traffic — anything that is not
 * transport wire traffic. Use this to filter a raw channel subscription or
 * history read down to application messages.
 * @param message - The channel message to classify.
 * @returns True when the message is not transport wire traffic.
 */
export const isForeignMessage = (message: Ably.InboundMessage): boolean => !isTransportMessage(message);

/** Options for {@link fetchRawHistory}. */
export interface FetchRawHistoryOptions {
  /**
   * Keep only messages matching this predicate. Defaults to
   * {@link isForeignMessage}.
   */
  filter?: (message: Ably.InboundMessage) => boolean;
  /**
   * Stop paging once messages older than this channel serial are reached, and
   * exclude them from the result. The bound is inclusive: a message with
   * exactly this serial is included. Omit to read to the start of retained
   * history.
   */
  sinceSerial?: string;
  /**
   * Exclude messages newer than this channel serial from the result. The
   * bound is inclusive: a message with exactly this serial is included.
   * Together with {@link sinceSerial} this fetches a closed serial window
   * (e.g. one recorded handoff window). Omit for no upper bound.
   */
  untilSerial?: string;
  /**
   * Bound the read at the channel attach point (`untilAttach` history), so a
   * live subscription registered before calling this composes with the result
   * without a gap or overlap. Defaults to true; set false to read up to the
   * present regardless of the attach point.
   */
  untilAttach?: boolean;
  /**
   * Safety cap on history pages read. Reaching the cap with pages still
   * remaining rejects with `HistoryFetchFailed` rather than returning a
   * silently truncated record; raise the cap (or bound the read with
   * {@link sinceSerial}) to read deeper. Defaults to 50.
   */
  maxPages?: number;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

/**
 * Read raw messages back off the channel by paging history internally,
 * returning them oldest-first. This is the reliable read path for the raw
 * message record: unlike a live subscription (delivery dependent on
 * subscription timing), any client or agent — cold-started or long-lived —
 * can always (re-)fetch the messages it needs.
 *
 * Attaches the channel first (idempotent), so the default `untilAttach` bound
 * is always valid — callers need not sequence an attach themselves.
 * @param channel - The channel to read history from.
 * @param options - Filtering and paging options.
 * @returns The matching messages, oldest-first.
 * @throws {Ably.ErrorInfo} `HistoryFetchFailed` when a history page fetch
 * exhausts its retries, or when `maxPages` is reached with history still
 * remaining (the result would otherwise be silently truncated). A failed
 * channel attach rejects with the underlying attach error.
 */
export const fetchRawHistory = async (
  channel: Ably.RealtimeChannel,
  options: FetchRawHistoryOptions = {},
): Promise<Ably.InboundMessage[]> => {
  const {
    filter = isForeignMessage,
    sinceSerial,
    untilSerial,
    untilAttach = true,
    maxPages = DEFAULT_MAX_PAGES,
    logger,
  } = options;
  logger?.trace('fetchRawHistory();');

  const cursor = await loadHistoryPages(channel, { pageLimit: RAW_HISTORY_PAGE_LIMIT, untilAttach, logger });
  const collected: Ably.InboundMessage[] = [];
  let pagesRead = 0;
  let reachedFloor = false;

  outer: while (pagesRead < maxPages && cursor.hasNext()) {
    const items = await cursor.next();
    if (!items) break;
    pagesRead += 1;
    // History pages are newest-first.
    for (const message of items) {
      if (sinceSerial !== undefined && message.serial !== undefined && message.serial < sinceSerial) {
        reachedFloor = true;
        break outer;
      }
      if (untilSerial !== undefined && message.serial !== undefined && message.serial > untilSerial) continue;
      if (filter(message)) collected.push(message);
    }
  }

  if (!reachedFloor && cursor.hasNext()) {
    throw new Ably.ErrorInfo(
      `unable to fetch raw history; history exceeds maxPages (${String(maxPages)}) before ${
        sinceSerial === undefined ? 'the start of retained history' : 'sinceSerial'
      } was reached`,
      ErrorCode.HistoryFetchFailed,
      500,
    );
  }

  logger?.debug('fetchRawHistory(); read complete', { pagesRead, collected: collected.length });
  return collected.toReversed();
};

/** A merged-transcript entry holding a conversation message from the View. */
export interface MergedConversationItem<TMessage> {
  /** Discriminant: this entry is a conversation message. */
  kind: 'conversation';
  /** The codec-message-id pairing this entry back to the View. */
  codecMessageId: string;
  /** The domain message, in the codec's per-message type. */
  message: TMessage;
}

/** A merged-transcript entry holding a raw Pub/Sub message from the channel. */
export interface MergedRawItem {
  /** Discriminant: this entry is a raw channel message. */
  kind: 'raw';
  /** The raw Ably message. */
  message: Ably.InboundMessage;
}

/**
 * A merged transcript entry — one element of {@link mergeBySerial}'s result.
 * @template TMessage - The codec's per-message domain type.
 */
export type MergedItem<TMessage> = MergedConversationItem<TMessage> | MergedRawItem;

/**
 * Build the canonical `serialOf` lookup for {@link mergeBySerial}: resolves a
 * codec-message-id to the start serial of the run that owns it, composing the
 * View's run lookup with the Tree's run-node record (run start serials are
 * carried on the Tree's {@link RunNode}, not on the View-facing
 * {@link RunInfo} snapshot).
 * @param view - The View whose messages are being merged.
 * @param tree - The Tree backing that View.
 * @returns A `serialOf` function for {@link mergeBySerial}; it returns
 * `undefined` for a codec-message-id whose run is unknown or has no start
 * serial yet (an optimistic local message).
 */
export const runStartSerialOf =
  <TMessage, TOutput extends CodecOutputEvent, TProjection>(
    view: View<TMessage>,
    tree: Tree<TOutput, TProjection>,
  ): ((codecMessageId: string) => string | undefined) =>
  (codecMessageId) => {
    const runId = view.runOf(codecMessageId)?.runId;
    return runId === undefined ? undefined : tree.getRunNode(runId)?.startSerial;
  };

/**
 * Interleave a View's conversation messages with raw channel messages into
 * one serial-ordered transcript.
 *
 * `conversation` must already be in View order (as returned by
 * `view.getMessages()`). Each conversation message is positioned by the serial
 * `serialOf` returns for its codec-message-id — the owning run's start serial,
 * via {@link runStartSerialOf}. A conversation message with no serial yet (an
 * optimistic local message whose run has not started) stays in place without
 * consuming raw messages, which is where it belongs: it is the newest thing in
 * the conversation.
 *
 * `raw` must be sorted by serial ascending (as {@link fetchRawHistory}
 * returns). Raw messages without a serial are dropped — a raw message read
 * from history or a live subscription always carries one.
 * @param conversation - The View's messages, in View order.
 * @param serialOf - Maps a codec-message-id to the channel serial that positions it, or undefined when it has none yet.
 * @param raw - Raw channel messages, sorted by serial ascending.
 * @returns One serial-ordered transcript of both message kinds.
 */
export const mergeBySerial = <TMessage>(
  conversation: readonly CodecMessage<TMessage>[],
  serialOf: (codecMessageId: string) => string | undefined,
  raw: readonly Ably.InboundMessage[],
): MergedItem<TMessage>[] => {
  const merged: MergedItem<TMessage>[] = [];
  let rawIndex = 0;

  const emitRawUpTo = (serial?: string): void => {
    while (rawIndex < raw.length) {
      const message = raw[rawIndex];
      if (message === undefined) break;
      if (message.serial === undefined) {
        rawIndex += 1;
        continue;
      }
      if (serial !== undefined && message.serial >= serial) break;
      merged.push({ kind: 'raw', message });
      rawIndex += 1;
    }
  };

  for (const entry of conversation) {
    const serial = serialOf(entry.codecMessageId);
    if (serial !== undefined) emitRawUpTo(serial);
    merged.push({ kind: 'conversation', codecMessageId: entry.codecMessageId, message: entry.message });
  }
  emitRawUpTo();

  return merged;
};
