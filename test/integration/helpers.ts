/**
 * Waiting primitives for the transport integration tier.
 *
 * The recorder is what keeps these suites off the clock: it buffers every
 * delivery as it arrives and re-checks pending predicates on each one, so a
 * test awaits the delivery it needs rather than sleeping and re-reading a
 * growing array. The only deadline is vitest's own test timeout.
 */

import type * as Ably from 'ably';

import type { Delivery, HistoryPage, Transport } from '../../src/index.js';

/**
 * A buffered, predicate-awaitable view of a transport's deliveries.
 * @template E - The codec's event union.
 */
export interface DeliveryRecorder<E> {
  /** Every delivery recorded so far, in delivery order. */
  readonly deliveries: Delivery<E>[];
  /** The decoded events, in delivery order, with undefined ones left out. */
  events: () => E[];
  /** Record one delivery, settling any predicate it satisfies. Pass to `subscribe`. */
  record: (delivery: Delivery<E>) => void;
  /**
   * Resolve once `predicate` holds over the recorded deliveries. Checked
   * immediately, then again on each delivery, so one that already arrived
   * resolves without waiting.
   * @param predicate - The condition to wait for.
   * @returns Resolves when the predicate holds.
   */
  waitFor: (predicate: (deliveries: Delivery<E>[]) => boolean) => Promise<void>;
}

/**
 * Create a {@link DeliveryRecorder}.
 * @returns A recorder to hand to `transport.subscribe`.
 */
export const createDeliveryRecorder = <E>(): DeliveryRecorder<E> => {
  const deliveries: Delivery<E>[] = [];
  const waiters: { predicate: (deliveries: Delivery<E>[]) => boolean; resolve: () => void }[] = [];

  return {
    deliveries,
    events: () => deliveries.map((d) => d.event).filter((e): e is E => e !== undefined),
    record: (delivery) => {
      deliveries.push(delivery);
      // Settle back-to-front so removing a satisfied waiter cannot skip one.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter?.predicate(deliveries)) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    },
    waitFor: async (predicate) => {
      if (predicate(deliveries)) return;
      await new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
};

/**
 * A stream fed by the test one event at a time, so a scenario can wait for
 * one event to reach a subscriber before it sends the next.
 * @returns The stream to pipe, `push` to enqueue an event, and `finish` to close it.
 */
export const controlledStream = <E>(): { source: ReadableStream<E>; push: (event: E) => void; finish: () => void } => {
  let controller: ReadableStreamDefaultController<E> | undefined;
  const source = new ReadableStream<E>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    source,
    push: (event) => controller?.enqueue(event),
    finish: () => controller?.close(),
  };
};

/**
 * Page a transport's history back to the channel start, oldest first.
 * @param transport - The transport to page.
 * @param limit - Messages per page.
 * @returns Every historical delivery, in chronological order.
 */
export const drainHistory = async <E>(transport: Transport<E>, limit = 50): Promise<Delivery<E>[]> => {
  const all: Delivery<E>[] = [];
  let page: HistoryPage<E> = await transport.history({ limit });
  for (;;) {
    all.unshift(...page.items);
    if (!page.hasNext) break;
    page = await page.next();
  }
  return all;
};

/**
 * A channel whose first `appendMessage` rejects, for the append-repair
 * scenario. Every other call goes to the real channel.
 * @param channel - The real channel.
 * @param error - The rejection to inject.
 * @returns The wrapped channel.
 */
export const failingFirstAppend = (channel: Ably.RealtimeChannel, error: Error): Ably.RealtimeChannel => {
  let injected = false;
  return new Proxy(channel, {
    get: (target, property, receiver) => {
      if (property === 'appendMessage' && !injected) {
        injected = true;
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- a rejected promise stands in for the real call
        return (): Promise<never> => Promise.reject(error);
      }
      // CAST: the target's own members, bound so ably-js internals keep `this`.
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
};
