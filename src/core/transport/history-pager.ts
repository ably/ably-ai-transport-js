/**
 * The shared backward history pager both transports delegate `history()` to:
 * a lazily opened `untilAttach` cursor, advanced by one caller at a time
 * under a single-flight tail chain, each call classifying the next older
 * slice via {@link walkHistoryBatch} on the live stream's decoder — so a
 * message the live route already folded contributes no duplicate events.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Decoder } from '../codec/types.js';
import { walkHistoryBatch } from './history-walk.js';
import { type HistoryPagesCursor, loadHistoryPages } from './load-history-pages.js';
import type { TransportHistoryOptions, TransportHistoryResult } from './types.js';

/**
 * Dependencies for {@link createHistoryPager}.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface HistoryPagerOptions<TInput, TOutput> {
  /** The channel whose history to page. */
  channel: Ably.RealtimeChannel;
  /** The decoder to classify pages with — the live stream's own, so the two routes share dedup state. */
  decoder: Decoder<TInput, TOutput>;
  /** Wire-message limit per history page. */
  pageLimit: number;
  /** Logger for diagnostics. */
  logger: Logger;
  /**
   * Called with each decode failure while classifying a page; the failing
   * message is skipped and the walk continues, matching the live fold.
   * @param err - The wrapped decode failure.
   */
  onDecodeError(err: Ably.ErrorInfo): void;
}

/** The pager returned by {@link createHistoryPager}. */
export interface HistoryPager<TInput, TOutput> {
  /**
   * Fetch and classify the next older slice of channel history. Calls are
   * single-flight: each links behind the previous so the shared cursor is
   * never paged concurrently, and a link's failure is its own caller's to
   * observe.
   * @param opts - The caller's batch bounds.
   * @returns The batch of classified events and the exhaustion flag.
   */
  next(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>>;
}

/**
 * Create the shared backward history pager over a channel and the live
 * stream's decoder. The cursor is opened lazily on the first call (capturing
 * the attach serial then) with `untilAttach: true`.
 * @param options - See {@link HistoryPagerOptions}.
 * @returns The pager.
 */
export const createHistoryPager = <TInput, TOutput>(
  options: HistoryPagerOptions<TInput, TOutput>,
): HistoryPager<TInput, TOutput> => {
  const { channel, decoder, pageLimit, logger } = options;

  /**
   * The shared backward cursor, opened lazily on the first call and advanced
   * by one caller at a time under the tail chain below.
   */
  let cursor: HistoryPagesCursor | undefined;
  /**
   * Tail of the single-flight chain. Each call links behind the current tail
   * so the cursor is never paged concurrently. A link's failure is its own to
   * throw — the tail stores a settled void promise, so a follower is isolated
   * from a prior link's rejection.
   */
  let tail: Promise<void> = Promise.resolve();

  const walk = async (opts: TransportHistoryOptions | undefined): Promise<TransportHistoryResult<TInput, TOutput>> => {
    // Check before the cursor is opened, so an already-aborted call costs no
    // attach and no page fetch. The signal is deliberately not bound to the
    // cursor: it is shared across calls, and an aborted signal would wedge its
    // `hasNext()` at false, making a later call report `exhausted` for a
    // channel it never finished walking.
    if (opts?.signal?.aborted) {
      throw new Ably.ErrorInfo('unable to load history; signal aborted', ErrorCode.OperationCancelled, 400);
    }
    cursor ??= await loadHistoryPages(channel, {
      pageLimit,
      untilAttach: true,
      logger,
    });
    return walkHistoryBatch(
      {
        cursor,
        decoder,
        logger,
        onDecodeError: (err) => {
          options.onDecodeError(err);
        },
      },
      opts,
    );
  };

  return {
    next: async (opts?: TransportHistoryOptions): Promise<TransportHistoryResult<TInput, TOutput>> => {
      // Link behind the tail so the shared cursor is advanced by one caller
      // at a time; a prior link's failure is its own to throw.
      const prev = tail;
      const mine = (async (): Promise<TransportHistoryResult<TInput, TOutput>> => {
        await prev;
        return walk(opts);
      })();
      tail = (async (): Promise<void> => {
        try {
          await mine;
        } catch {
          /* a link's failure is its own caller's to observe */
        }
      })();
      return mine;
    },
  };
};
