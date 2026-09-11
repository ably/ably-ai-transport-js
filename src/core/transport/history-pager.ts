/**
 * The transport's history walk: a backward cursor from the channel's current
 * attach point, one Ably page per step, decoded through the transport's own
 * codec so a message history and live delivery both carry is decoded once.
 *
 * Each `history()` call opens a new walk at the attach point the channel has
 * now, and the page it returns leads to the older pages through `next()`. A
 * walk's steps are serialised: two `next()` calls on one page read in order.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../logger.js';
import type { Delivery } from '../codec/codec.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';

/** Options for {@link Transport.history}. */
export interface HistoryOptions {
  /** Messages per Ably page, for every page of the walk. */
  limit: number;
}

/**
 * One page of a history walk.
 * @template E - The codec's event union.
 */
export interface HistoryPage<E> {
  /** The page's deliveries, oldest first: one per event the codec decodes from a message, and one with `event: undefined` for a message it has nothing for. */
  items: Delivery<E>[];
  /** Whether an older page exists. */
  hasNext: boolean;
  /**
   * Read the next older page of the same walk. Past the end it resolves with
   * an empty page whose `hasNext` is false.
   * @returns The next older page.
   * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` when the page cannot be fetched after retries.
   */
  next(): Promise<HistoryPage<E>>;
}

/** Options for {@link openHistoryWalk}. */
export interface HistoryWalkOptions<E> {
  /** The channel to page. */
  channel: Ably.RealtimeChannel;
  /** Messages per Ably page. */
  limit: number;
  /**
   * Turn one raw message into its deliveries. The transport supplies its own
   * decode-and-report path, so a decode failure in history reaches the error
   * stream the same way a live one does.
   */
  toDeliveries: (message: Ably.InboundMessage) => Delivery<E>[];
  /** Logger for diagnostics. */
  logger?: Logger;
}

/**
 * One walk over a cursor. `next()` calls are single-flight: each links behind
 * the current tail, and a link's failure is its own caller's to observe.
 * @template E - The codec's event union.
 */
class HistoryWalk<E> {
  private readonly _cursor: HistoryPagesCursor;
  private readonly _toDeliveries: (message: Ably.InboundMessage) => Delivery<E>[];
  private readonly _logger: Logger | undefined;
  /** Tail of the single-flight chain: always a settled or in-flight void promise. */
  private _tail: Promise<void> = Promise.resolve();

  constructor(
    cursor: HistoryPagesCursor,
    toDeliveries: (message: Ably.InboundMessage) => Delivery<E>[],
    logger?: Logger,
  ) {
    this._cursor = cursor;
    this._toDeliveries = toDeliveries;
    this._logger = logger;
  }

  // The tail advances before the first `await`, so a concurrent caller always
  // links behind this call rather than racing it.
  async next(): Promise<HistoryPage<E>> {
    const prev = this._tail;
    const mine = (async (): Promise<HistoryPage<E>> => {
      await prev;
      return this._readPage();
    })();
    this._tail = (async (): Promise<void> => {
      try {
        await mine;
      } catch {
        /* a link's failure is its own caller's to observe */
      }
    })();
    return mine;
  }

  private async _readPage(): Promise<HistoryPage<E>> {
    this._logger?.trace('HistoryWalk.next();');
    const page = await this._cursor.next();
    // Ably pages are newest-first; the codec's decoder is stateful, so it must
    // see an older message before a newer one.
    const items = (page ?? []).toReversed().flatMap((message) => this._toDeliveries(message));
    const hasNext = this._cursor.hasNext();
    this._logger?.debug('HistoryWalk.next(); page read', { items: items.length, hasNext });
    return { items, hasNext, next: async () => this.next() };
  }
}

/**
 * Open a walk backwards from the channel's current attach point and read its
 * first page.
 * @param options - See {@link HistoryWalkOptions}.
 * @returns The newest page, leading to the older ones through `next()`.
 * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` when the first page cannot be fetched after retries.
 */
export const openHistoryWalk = async <E>(options: HistoryWalkOptions<E>): Promise<HistoryPage<E>> => {
  const logger = options.logger?.withContext({ component: 'HistoryWalk' });
  logger?.trace('openHistoryWalk();', { limit: options.limit });
  const cursor = await loadHistoryPages(options.channel, { pageLimit: options.limit, untilAttach: true, logger });
  return new HistoryWalk(cursor, options.toDeliveries, logger).next();
};
