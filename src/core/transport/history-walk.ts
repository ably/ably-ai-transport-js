/**
 * The shared history batch walk behind {@link ClientTransport.history} and
 * {@link AgentTransport.history}: page the channel backwards through a
 * {@link HistoryPagesCursor} and classify each wire message into a
 * {@link TransportEvent}, returning one chronological batch per call.
 *
 * Each transport owns its cursor and decoder (both share their live stream's
 * decoder, so a stream spanning the attach boundary folds once) and the
 * single-flight serialisation of concurrent calls — this module owns only the
 * walk itself.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { Decoder } from '../codec/types.js';
import { reportPage, wrapMessageProcessingError } from './channel-support.js';
import type { HistoryPagesCursor } from './load-history-pages.js';
import { classifyWireMessage } from './receive-transport.js';
import type { TransportEvent, TransportHistoryOptions, TransportHistoryResult } from './types/transport.js';

/**
 * The pieces a transport hands the walk: its cursor, its decoder, and how a
 * decode failure surfaces.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface WalkHistoryBatchContext<TInput, TOutput> {
  /** The backward page cursor to advance. The caller keeps it across calls so each batch resumes where the last stopped. */
  cursor: HistoryPagesCursor;
  /** The decoder to classify wires on. Advancing it here mutates its per-stream state, so the caller decides which decoder the walk shares. */
  decoder: Decoder<TInput, TOutput>;
  /** Logger for diagnostics; decode failures and batch completion are logged here. */
  logger?: Logger;
  /**
   * Called with each wrapped decode failure after it is logged and the message
   * skipped. The client wires this to its receive stream's `error` emitter;
   * omit when the transport has no error stream (the failure is then
   * log-only).
   */
  onDecodeError?: (err: Ably.ErrorInfo) => void;
}

/**
 * Fetch and classify the next older slice of channel history. Pages are
 * fetched newest-first; each page's wires are classified in chronological
 * order (advancing the decoder exactly as a live fold would), and the page
 * order is reversed at the end so the returned batch is chronological
 * throughout. A single undecodable message is skipped (logged, and passed to
 * `onDecodeError` when supplied) rather than failing the whole batch.
 * @param ctx - The caller's cursor, decoder, and failure surface.
 * @param opts - The caller's batch bounds.
 * @returns The batch of classified events and the exhaustion flag.
 */
export const walkHistoryBatch = async <TInput, TOutput>(
  ctx: WalkHistoryBatchContext<TInput, TOutput>,
  opts: TransportHistoryOptions | undefined,
): Promise<TransportHistoryResult<TInput, TOutput>> => {
  const { cursor, decoder, logger } = ctx;

  const pages: TransportEvent<TInput, TOutput>[][] = [];
  let collected = 0;
  while (cursor.hasNext() && (opts?.limit === undefined || collected < opts.limit)) {
    if (opts?.signal?.aborted) {
      throw new Ably.ErrorInfo('unable to load history; signal aborted', ErrorCode.OperationCancelled, 400);
    }
    const chunk = await cursor.next();
    reportPage(opts?.onPage, 'walkHistoryBatch', logger);
    // `next()` returning undefined means the cursor is permanently spent —
    // genuine exhaustion.
    if (!chunk) break;
    const pageEvents: TransportEvent<TInput, TOutput>[] = [];
    // Ably returns pages newest-first; classify in chronological order so the
    // decoder's stream trackers build oldest-to-newest within the page.
    for (const wire of chunk.toReversed()) {
      let event: TransportEvent<TInput, TOutput> | undefined;
      try {
        event = classifyWireMessage(decoder, wire);
      } catch (error) {
        const err = wrapMessageProcessingError(error);
        logger?.error('walkHistoryBatch(); decode failed, message skipped', {
          serial: wire.serial,
          code: err.code,
        });
        ctx.onDecodeError?.(err);
        continue;
      }
      if (event) pageEvents.push(event);
    }
    collected += pageEvents.length;
    pages.push(pageEvents);
  }

  logger?.debug('walkHistoryBatch(); batch collected', {
    events: collected,
    exhausted: !cursor.hasNext(),
  });
  return { events: pages.toReversed().flat(), exhausted: !cursor.hasNext() };
};
