/**
 * The shared per-transport history pager: the lazily opened backward cursor
 * plus the single-flight chain both transports run their `history()` calls
 * through. The pager owns the cursor's lifetime and the serialisation; the
 * walk itself lives in {@link walkHistoryBatch}, and the caller supplies the
 * channel, page size, decoder, and decode-failure surface.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Decoder } from '../codec/types.js';
import { walkHistoryBatch } from './history-walk.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';
import type { TransportHistoryOptions, TransportHistoryResult } from './types/transport.js';

/**
 * Default wire-message limit per Ably history page, used when a transport's
 * `historyPageSize` option is unset. Over-provisions for the
 * many-Ably-messages-per-domain-message ratio so a single round trip usually
 * covers several domain messages.
 */
export const DEFAULT_HISTORY_PAGE_SIZE = 100;

/** Constructor options for {@link HistoryPager}. */
export interface HistoryPagerOptions<TInput, TOutput> {
  /** The channel whose history to page. */
  channel: Ably.RealtimeChannel;
  /** Wire-message limit per Ably page. */
  pageSize: number;
  /** The decoder to classify wires on — the transport's live decoder, so a stream spanning the attach boundary folds once. */
  decoder: Decoder<TInput, TOutput>;
  /** Logger for diagnostics. */
  logger?: Logger;
  /** Called with each wrapped decode failure (see {@link walkHistoryBatch}). */
  onDecodeError?: (err: Ably.ErrorInfo) => void;
}

/**
 * One transport's history pager. `next()` returns the next older slice as a
 * classified batch. The backward cursor opens lazily on the first call
 * (capturing the attach serial then) and is advanced by one caller at a time:
 * each call links behind the current tail, and a link's failure is its own
 * caller's to observe — a follower is isolated from a prior link's rejection.
 */
export class HistoryPager<TInput, TOutput> {
  private readonly _options: HistoryPagerOptions<TInput, TOutput>;
  /** The lazily opened backward cursor; `undefined` until the first walk. */
  private _cursor: HistoryPagesCursor | undefined;
  /** Tail of the single-flight chain — always a settled or in-flight void promise. */
  private _tail: Promise<void> = Promise.resolve();

  constructor(options: HistoryPagerOptions<TInput, TOutput>) {
    this._options = options;
  }

  /**
   * Fetch and classify the next older slice of channel history, serialised
   * behind any in-flight call.
   * @param opts - The caller's batch bounds; see {@link TransportHistoryOptions}.
   * @returns The batch of classified events and the exhaustion flag.
   */
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- the tail must advance synchronously so concurrent callers serialise
  next(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> {
    const prev = this._tail;
    const mine = (async (): Promise<TransportHistoryResult<TInput, TOutput>> => {
      await prev;
      return this._walk(opts);
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

  private async _walk(opts: TransportHistoryOptions | undefined): Promise<TransportHistoryResult<TInput, TOutput>> {
    const { channel, pageSize, decoder, logger, onDecodeError } = this._options;
    // Check before the cursor is opened, so an already-aborted call costs no
    // attach and no page fetch. The signal is deliberately not bound to the
    // cursor: it is shared across calls, and an aborted signal would wedge its
    // `hasNext()` at false, making a later call report `exhausted` for a
    // channel it never finished walking.
    if (opts?.signal?.aborted) {
      throw new Ably.ErrorInfo('unable to load history; signal aborted', ErrorCode.OperationCancelled, 400);
    }
    this._cursor ??= await loadHistoryPages(channel, {
      pageLimit: pageSize,
      untilAttach: true,
      logger,
    });
    return walkHistoryBatch(
      {
        cursor: this._cursor,
        decoder,
        logger,
        ...(onDecodeError && { onDecodeError }),
      },
      opts,
    );
  }
}
