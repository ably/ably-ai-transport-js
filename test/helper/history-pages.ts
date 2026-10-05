/** A HistoryPage chain over fixture deliveries, for testing replay functions without a channel. */

import type * as Ably from 'ably';

import type { Delivery, HistoryPage } from '../../src/index.js';

/** What the chain records as it is read. */
export interface PageReads {
  /** Pages given out: the first one, then one per `next()`. */
  pages: number;
}

/**
 * Build a page chain over `pages`, newest page first, with each page's items as
 * given (oldest first within it, as the transport orders a page).
 * `next()` past the end resolves with an empty page whose `hasNext` is false.
 * @param pages - The pages, newest first.
 * @param reads - Advanced as pages are read, when given.
 * @returns The newest page.
 */
export const pagesOf = <E>(pages: Delivery<E>[][], reads?: PageReads): HistoryPage<E> => {
  const at = (index: number): HistoryPage<E> => {
    if (reads !== undefined) reads.pages++;
    return {
      items: pages[index] ?? [],
      hasNext: index + 1 < pages.length,
      // eslint-disable-next-line @typescript-eslint/require-await -- the fixture serves each page at once
      next: async () => at(index + 1),
    };
  };
  return at(0);
};

/**
 * A delivery fixture whose event is its serial, with a version when given.
 * @param serial - The message serial.
 * @param version - The `version.serial`, for a message that has been appended to or updated.
 * @returns The delivery.
 */
export const deliveryAt = (serial: string, version?: string): Delivery<string> => ({
  event: serial,
  // CAST: a minimal InboundMessage stub with the fields a replay function reads.
  message: { serial, version: version === undefined ? {} : { serial: version } } as Ably.InboundMessage,
});

/**
 * The events a replay function returned, sorted. A replay function returns
 * them in any order and the transport sorts them into channel order, so a
 * builder is tested on which deliveries it returns.
 * @param replay - What a replay function returned.
 * @returns The events, sorted as strings.
 */
export const eventsOf = (replay: Delivery<string>[] | { deliveries: Delivery<string>[] }): (string | undefined)[] =>
  (Array.isArray(replay) ? replay : replay.deliveries).map((d) => d.event).toSorted();
