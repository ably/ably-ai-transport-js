/**
 * `untilEvent`: a replay function that reads history back to the newest
 * delivery a predicate accepts and returns that delivery and the deliveries
 * after it for the transport to replay.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Delivery } from '../codec/codec.js';
import type { ReplayFn } from './replay.js';

/** Options for {@link untilEvent}. */
export interface UntilEventOptions {
  /** The function stops after this many pages whether or not a delivery matched. Default no limit. */
  maxPages?: number;
  /** When the pages run out, or the function hits `maxPages`, before a delivery matches: `'deliver'` returns what it read, with `found: false`; `'error'` fails the history replay with `SessionHistoryFetchFailed`. Default `'deliver'`. */
  onExhausted?: 'deliver' | 'error';
  /** Whether the function returns the matching delivery itself. Default true. */
  inclusive?: boolean;
}

/**
 * Build a replay function that reads back to the newest delivery `predicate`
 * accepts and returns that delivery and the deliveries after it, for the
 * transport to replay. The predicate sees each decoded
 * delivery, so it can stop on an event's type or field, on a header, or on
 * the raw message. The function stops on the first page that holds a match,
 * and reads the next older page when nothing on a page matches. The report's
 * `found` is true when a delivery matched.
 * @template E - The codec's event union.
 * @param predicate - Accepts the delivery to replay from.
 * @param options - The page cap, the exhausted policy and whether the match itself is replayed; see {@link UntilEventOptions}.
 * @returns The replay function, for `subscribe`'s `history.replay`.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `maxPages` is less than one.
 */
export const untilEvent = <E>(
  predicate: (delivery: Delivery<E>) => boolean,
  options: UntilEventOptions = {},
): ReplayFn<E> => {
  const { maxPages = Infinity, onExhausted = 'deliver', inclusive = true } = options;
  if (maxPages < 1) {
    throw new Ably.ErrorInfo(
      'unable to replay until event; maxPages must be at least 1',
      ErrorCode.InvalidArgument,
      400,
    );
  }

  return async (first) => {
    const deliveries: Delivery<E>[] = [];
    let page = first;
    let pages = 1;
    for (;;) {
      // Items are oldest first within the page, so the last match is the
      // newest one.
      const index = page.items.findLastIndex((delivery) => predicate(delivery));
      if (index !== -1) {
        deliveries.push(...page.items.slice(inclusive ? index : index + 1));
        return { deliveries, found: true };
      }
      deliveries.push(...page.items);
      if (!page.hasNext || pages >= maxPages) break;
      page = await page.next();
      pages++;
    }
    if (onExhausted === 'error') {
      throw new Ably.ErrorInfo(
        'unable to replay until event; history ran out before a delivery matched',
        ErrorCode.SessionHistoryFetchFailed,
        500,
      );
    }
    return { deliveries, found: false };
  };
};
