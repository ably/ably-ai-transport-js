/**
 * loadHistoryPages — shared low-level history pagination primitive.
 *
 * The cursor underneath every history route the transports expose:
 * `ClientTransport.history`, and the agent transport's `locateInput`
 * input-event scan and its `history` paging. Returns raw Ably messages; does
 * NOT decode.
 *
 * Behaviour:
 *  - Attaches the channel (idempotent) then pages via `channel.history()`,
 *    using `untilAttach: true` for gapless continuity with any live subscription.
 *  - Exposes the underlying pagination as a cursor with `hasNext()` (cheap,
 *    no network) and `next()` (one Ably page per call, newest-first within
 *    the page).
 *  - Per-page failures are retried with bounded exponential backoff; on
 *    exhaustion throws `Ably.ErrorInfo` with code `SessionHistoryFetchFailed`.
 *  - `signal.aborted` is checked between pages; rejects with
 *    `Ably.ErrorInfo` (OperationCancelled) when aborted.
 *
 * Spec: AIT-CT11 / AIT-ST hydration.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';

/** Options for {@link loadHistoryPages}. */
export interface LoadHistoryPagesOptions {
  /** Wire-message limit per Ably page. */
  pageLimit: number;
  /** Set `untilAttach: true` on the underlying history query for gapless continuity with live subscriptions. Default: true. */
  untilAttach?: boolean;
  /** AbortSignal checked between pages. Rejects with OperationCancelled when aborted. */
  signal?: AbortSignal;
  /** Max retries per `page.next()` / initial `history()` failure. Default: 3. */
  maxRetries?: number;
  /** Initial retry backoff in ms (doubled per attempt). Default: 100. */
  retryBackoffMs?: number;
  /** Logger for diagnostic output. */
  logger?: Logger;
}

/**
 * Cursor over the channel's history pages.
 *
 * `hasNext()` is cheap (cursor-only, no network); `next()` issues one Ably
 * page fetch (with retry/backoff) and returns its messages. Once `next()`
 * returns `undefined` the cursor is exhausted.
 */
export interface HistoryPagesCursor {
  /** True when another Ably page is available (cheap to check; no network). */
  hasNext(): boolean;
  /**
   * Fetch the next Ably page's messages (newest-first within the page).
   * Returns `undefined` when no more pages are available or the abort
   * signal has fired.
   */
  next(): Promise<readonly Ably.InboundMessage[] | undefined>;
}

/**
 * Sleep for `ms` milliseconds, honouring an AbortSignal.
 * @param ms - Milliseconds to wait.
 * @param signal - Optional abort signal; rejects when fired.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the function body is the Promise constructor; async would wrap it in an extra Promise
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Ably.ErrorInfo('unable to wait; signal aborted', ErrorCode.OperationCancelled, 400));
      return;
    }
    const timer: ReturnType<typeof setTimeout> | number = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Node returns an unref-able Timeout; browsers return a number. Unref so
    // a retry backoff cannot keep a Node process alive by itself.
    if (typeof timer === 'object') timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Ably.ErrorInfo('unable to wait; signal aborted', ErrorCode.OperationCancelled, 400));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Invoke `fetchPage`, retrying on failure with exponential backoff. Throws
 * the last failure wrapped as `SessionHistoryFetchFailed` once retries are
 * exhausted.
 * @param fetchPage - The page fetch to retry (initial `channel.history()` call or a `page.next()`).
 * @param maxRetries - Maximum number of attempts after the initial call.
 * @param initialBackoffMs - Starting backoff delay (doubled per attempt).
 * @param signal - Optional abort signal; cancels remaining retries.
 * @param logger - Optional logger.
 * @returns The fetched page, or `undefined` when pagination is exhausted.
 */
const fetchPageWithRetry = async (
  fetchPage: () => Promise<Ably.PaginatedResult<Ably.InboundMessage> | undefined>,
  maxRetries: number,
  initialBackoffMs: number,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): Promise<Ably.PaginatedResult<Ably.InboundMessage> | undefined> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Ably.ErrorInfo(
        'unable to fetch history page; signal aborted',
        ErrorCode.OperationCancelled,
        400,
        errorCause(lastError),
      );
    }
    try {
      return await fetchPage();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const backoff = initialBackoffMs * 2 ** attempt;
      logger?.warn('loadHistoryPages.fetchPageWithRetry(); page fetch failed, retrying', {
        attempt: attempt + 1,
        maxRetries,
        backoff,
        error: errorMessage(error),
      });
      await sleep(backoff, signal);
    }
  }
  throw new Ably.ErrorInfo(
    `unable to fetch history page; ${errorMessage(lastError)}`,
    ErrorCode.SessionHistoryFetchFailed,
    500,
    errorCause(lastError),
  );
};

/**
 * Page through channel history, returning a cursor over Ably pages.
 *
 * Newest-first within each yielded page (matching Ably's native ordering).
 * Caller drives the cursor — calling `next()` until it returns `undefined`
 * or stopping early when a domain-specific stop condition is met
 * (e.g. complete-message counter satisfied, target codec-message-id found,
 * parent chain walk reaches root).
 *
 * The initial Ably history call is awaited eagerly so the returned cursor
 * already knows whether there are pages available (via `hasNext()`).
 * @param channel - The Ably channel to read history from.
 * @param options - Pagination options.
 * @returns A cursor with `hasNext()` (cheap, cursor-only) and `next()` (fetches one page with retry).
 * @throws {Ably.ErrorInfo} `SessionHistoryFetchFailed` on exhausted retry of the initial fetch, or `OperationCancelled` on signal abort.
 */
export const loadHistoryPages = async (
  channel: Ably.RealtimeChannel,
  options: LoadHistoryPagesOptions,
): Promise<HistoryPagesCursor> => {
  const { pageLimit, untilAttach = true, signal, maxRetries = 3, retryBackoffMs = 100, logger } = options;

  if (signal?.aborted) {
    throw new Ably.ErrorInfo('unable to load history; signal aborted', ErrorCode.OperationCancelled, 400);
  }

  await channel.attach();

  const historyParams: Ably.RealtimeHistoryParams = { limit: pageLimit, untilAttach };

  let currentPage: Ably.PaginatedResult<Ably.InboundMessage> | undefined = await fetchPageWithRetry(
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- channel.history returns a real Promise
    () => channel.history(historyParams),
    maxRetries,
    retryBackoffMs,
    signal,
    logger,
  );
  let firstYielded = false;

  // Compute whether the cursor has another page available. Cheap — no
  // network. Reflects the latest fetched page's `hasNext()` plus the signal
  // check.
  const hasNext = (): boolean => {
    if (currentPage === undefined) return false;
    if (signal?.aborted) return false;
    if (!firstYielded) return true;
    return currentPage.hasNext();
  };

  const next = async (): Promise<readonly Ably.InboundMessage[] | undefined> => {
    if (currentPage === undefined) return undefined;
    if (signal?.aborted) {
      throw new Ably.ErrorInfo('unable to load history; signal aborted', ErrorCode.OperationCancelled, 400);
    }

    if (!firstYielded) {
      firstYielded = true;
      return currentPage.items;
    }

    if (!currentPage.hasNext()) {
      currentPage = undefined;
      return undefined;
    }

    const nextPage: Ably.PaginatedResult<Ably.InboundMessage> | undefined = await fetchPageWithRetry(
      async () => (await currentPage?.next()) ?? undefined,
      maxRetries,
      retryBackoffMs,
      signal,
      logger,
    );
    if (!nextPage) {
      currentPage = undefined;
      return undefined;
    }
    currentPage = nextPage;
    return nextPage.items;
  };

  return { hasNext, next };
};
