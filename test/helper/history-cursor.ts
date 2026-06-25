import type * as Ably from 'ably';

import type { HistoryPagesCursor } from '../../src/core/transport/load-history-pages.js';

/**
 * A fake {@link HistoryPagesCursor} over `pages` in Ably delivery order
 * (newest-first within each page, the order `loadHistoryPages` yields). `next()`
 * returns one page per call then `undefined`; `hasNext()` is true while pages
 * remain. `nextCalls()` reports how many pages were fetched, so a test can
 * assert the channel was paged the expected number of times.
 * @param pages - History pages in cursor-delivery order (newest page first; newest-first within each page).
 * @returns A cursor over those pages, plus a `nextCalls()` probe.
 */
export const makeHistoryCursor = (pages: Ably.InboundMessage[][]): HistoryPagesCursor & { nextCalls: () => number } => {
  let i = 0;
  let nextCalls = 0;
  return {
    hasNext: () => i < pages.length,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns a resolved promise
    next: () => {
      nextCalls += 1;
      const page = pages[i];
      i += 1;
      return Promise.resolve(page);
    },
    nextCalls: () => nextCalls,
  };
};
