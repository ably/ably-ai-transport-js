/**
 * `fromSerial`: a replay function that reads history back to a serial the
 * caller already holds and returns the deliveries after it for the transport
 * to replay.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Delivery } from '../codec/codec.js';
import type { ReplayFn } from './replay.js';

/** Options for {@link fromSerial}. */
export interface FromSerialOptions {
  /** The maximum number of pages of history to iterate through. Default no limit. */
  maxPages?: number;
  /** Controls what to do if history is exhausted before finding the serial, or the function hits `maxPages`: `'deliver'` returns what it read, with `found: false`; `'error'` fails the history replay with `SessionHistoryFetchFailed`. Default `'deliver'`. */
  onExhausted?: 'deliver' | 'error';
  /** Whether the function returns the message at the serial itself. Default false, for a serial that is the last message you applied. */
  inclusive?: boolean;
}

/**
 * Build a replay function that reads back to `serial` and returns the
 * deliveries after it, for the transport to replay. Serials are compared on
 * when each message was created, its `serial`, even if the message was later
 * appended to or updated.
 * @template E - The codec's event union.
 * @param serial - The serial to read forward from, the one a publish ack returned.
 * @param options - The page cap, the exhausted policy and whether the serial itself is replayed; see {@link FromSerialOptions}.
 * @returns The replay function, for `subscribe`'s `history.replay`.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when `serial` is empty or `maxPages` is less than one.
 */
export const fromSerial = <E>(serial: string, options: FromSerialOptions = {}): ReplayFn<E> => {
  if (serial === '') {
    throw new Ably.ErrorInfo('unable to replay from serial; serial is empty', ErrorCode.InvalidArgument, 400);
  }
  const { maxPages = Infinity, onExhausted = 'deliver', inclusive = false } = options;
  if (maxPages < 1) {
    throw new Ably.ErrorInfo(
      'unable to replay from serial; maxPages must be at least 1',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  const createdAt = (delivery: Delivery<E>): string => delivery.message.serial ?? '';
  const after = (delivery: Delivery<E>): boolean =>
    inclusive ? createdAt(delivery) >= serial : createdAt(delivery) > serial;
  const reached = (delivery: Delivery<E>): boolean => createdAt(delivery) <= serial;

  return async (first) => {
    const deliveries: Delivery<E>[] = [];
    let page = first;
    let pages = 1;
    for (;;) {
      deliveries.push(...page.items.filter((delivery) => after(delivery)));
      if (page.items.some((delivery) => reached(delivery))) return { deliveries, found: true };
      if (!page.hasNext || pages >= maxPages) break;
      page = await page.next();
      pages++;
    }
    if (onExhausted === 'error') {
      throw new Ably.ErrorInfo(
        'unable to replay from serial; history ran out before the serial was reached',
        ErrorCode.SessionHistoryFetchFailed,
        500,
      );
    }
    return { deliveries, found: false };
  };
};
