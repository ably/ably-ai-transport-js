/**
 * The receive half both transports assemble identically: one decoder, the
 * receive transport that classifies onto it, its `on` dispatch, and the
 * history pager reading through the same decoder.
 *
 * Built here rather than twice so two invariants stay structural instead of
 * living as duplicated prose. The pager shares the live merge's decoder, so a
 * stream spanning the attach boundary is never decoded twice. And the pager's
 * decode failures surface on the receive stream's `error`, so a consumer sees
 * a bad history wire the same way it sees a bad live one.
 */

import type * as Ably from 'ably';

import type { Logger } from '../../../logger.js';
import type { Decoder, WireCodec } from '../../codec/types.js';
import { HistoryPager } from '../history-pager.js';
import { createReceiveTransport, forwardReceiverOn, type ReceiveTransport } from '../receive-transport.js';
import type { TransportReceiver } from '../types/transport.js';

/** Options for {@link createReceivePlumbing}. */
export interface ReceivePlumbingOptions<TInput, TOutput> {
  /** The transport's channel, which the pager reads history from. */
  channel: Ably.RealtimeChannel;
  /** The codec whose decoder classifies both the live stream and history. */
  codec: WireCodec<TInput, TOutput>;
  /** Wire-message limit per history page. Resolved by the caller, which owns its own default. */
  pageSize: number;
  /** The transport's contexted logger, passed to every part. */
  logger: Logger;
}

/**
 * The receive parts, for the caller to hold as its own fields.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ReceivePlumbing<TInput, TOutput> {
  /** The one decoder, shared by the live merge and the history pager. */
  decoder: Decoder<TInput, TOutput>;
  /** The receive transport that classifies inbound wires and owns the event/error streams. */
  receiver: ReceiveTransport<TInput, TOutput>;
  /** The receiver's `on`, for the transport to expose as its own. */
  on: TransportReceiver<TInput, TOutput>['on'];
  /** The lazily opened, single-flight history pager. */
  historyPager: HistoryPager<TInput, TOutput>;
}

/**
 * Assemble a transport's receive half.
 * @param options - See {@link ReceivePlumbingOptions}.
 * @returns The parts, wired to each other.
 */
export const createReceivePlumbing = <TInput, TOutput>(
  options: ReceivePlumbingOptions<TInput, TOutput>,
): ReceivePlumbing<TInput, TOutput> => {
  const { channel, codec, pageSize, logger } = options;
  const decoder = codec.createDecoder();
  const receiver = createReceiveTransport<TInput, TOutput>(decoder, logger);
  const historyPager = new HistoryPager<TInput, TOutput>({
    channel,
    pageSize,
    decoder,
    logger,
    onDecodeError: (err) => {
      receiver.emitError(err);
    },
  });
  return { decoder, receiver, on: forwardReceiverOn(receiver), historyPager };
};
