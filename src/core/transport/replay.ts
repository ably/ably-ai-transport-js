/**
 * The replay a `subscribe` call can ask for: the contract between the
 * transport, which buffers a handler's live deliveries while a function reads
 * history, and that function, which decides what the handler sees first.
 *
 * The transport pages history back from the channel's attach point and gives
 * the function its newest page, the same page `history()` returns. The
 * function reads as far back as it needs through `next()` and returns the
 * deliveries to replay, in any order. The transport sorts them into channel
 * order, replays them to the handler, releases the buffered deliveries in arrival
 * order, and reports what happened. The transport buffers and orders, because
 * it sees every delivery before the handler does and knows the order it read
 * the pages in. The function decides where to stop and which deliveries to
 * return.
 */

import type { Delivery } from '../codec/codec.js';
import type { HistoryPage } from './history-pager.js';

/**
 * What a replay function returns when it has a verdict to report beside the
 * deliveries. A bare array means the deliveries alone.
 * @template E - The codec's event union.
 */
export interface Replay<E> {
  /** The deliveries to replay, in any order. The transport sorts them by their message's creation serial, the order history holds them in, so the handler sees channel order, before its buffered live deliveries. */
  deliveries: Delivery<E>[];
  /** Whether the function reached the point it was told to find. Reported on {@link ReplayResult.found}. */
  found?: boolean;
}

/**
 * A function that reads history for a handler. The transport calls it once
 * with the newest page of history, paged back from the channel's attach
 * point. It is the replay function's responsibility to page backwards through
 * history for as many pages as are required, using `page.next()`. It returns the
 * deliveries to replay, in any order, as an array or a {@link Replay},
 * directly or through a promise. The transport sorts them into channel order,
 * so the function does no ordering of its own. A throw ends the history
 * replay: the handler goes live with a gap and the subscription's `replayed`
 * rejects with the error.
 * @template E - The codec's event union.
 */
export type ReplayFn<E> = (page: HistoryPage<E>) => Delivery<E>[] | Replay<E> | Promise<Delivery<E>[] | Replay<E>>;

/**
 * The history a `subscribe` call asks for.
 * @template E - The codec's event union.
 */
export interface SubscribeHistory<E> {
  /** Reads the history and returns what to replay; see {@link ReplayFn}. `fromSerial` and `untilEvent` build the usual ones. */
  replay: ReplayFn<E>;
  /** Messages per page of the history the function reads. Default 100. */
  pageSize?: number;
}

/** Options for `Transport.subscribe`. */
export interface SubscribeOptions<E> {
  /** Replay history to the handler before its live deliveries, in order; see {@link SubscribeHistory}. Omit for live delivery alone. */
  history?: SubscribeHistory<E>;
}

/** The result of a subscription's history replay, resolved once the handler is live. */
export interface ReplayResult {
  /** Deliveries replayed from history. Zero for a subscription that asked for none. */
  replayed: number;
  /** The replay function's verdict, when it returned one; see {@link Replay.found}. */
  found?: boolean;
}

/**
 * What `Transport.subscribe` returns: the unsubscribe, with the result of the
 * history replay the subscription was registered with. Without `history` the
 * result resolves at once with nothing replayed.
 */
export type Subscription = (() => void) & {
  /**
   * Resolves once the transport has replayed history and released the
   * buffered deliveries, or at once when no history was asked for. Rejects
   * when the history replay failed, with the handler already live and a gap
   * where the replay would have been: `SessionHistoryFetchFailed` for a page
   * the transport could not fetch or a replay function that threw, and
   * `OperationCancelled` for an unsubscribe or a `close()` during the replay.
   * The transport logs the failure as well, so a subscription nobody awaits
   * does not surface it as an unhandled rejection.
   */
  replayed: Promise<ReplayResult>;
};
