/**
 * Waiting primitives and a history drain for the integration tier.
 *
 * The recorder is what keeps these suites off the clock: it buffers every
 * delivery as it arrives and re-checks pending predicates on each one, so a
 * test awaits the delivery it needs rather than sleeping and re-reading a
 * growing array. The only deadline is vitest's own test timeout.
 */

import type * as Ably from 'ably';

import type { Decoder, Delivery } from '../../src/index.js';

/**
 * A buffered, predicate-awaitable view of a decoder's deliveries.
 * @template E - The codec's event union.
 */
export interface DeliveryRecorder<E> {
  /** Every delivery recorded so far, in delivery order. */
  readonly deliveries: Delivery<E>[];
  /** The decoded events, in delivery order, with undefined ones left out. */
  events: () => E[];
  /** Record one delivery, settling any predicate it satisfies. Pass to `decoder.onEvent`. */
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
 * @returns A recorder to hand to `decoder.onEvent`.
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
 * Every message on the channel up to its attach point, decoded through
 * `decoder`, oldest first. History pages arrive newest first, and the decoder
 * takes them in that order, which is the order it is built for; the
 * deliveries are reversed into channel order afterwards. Attaches the channel.
 * @param channel - The channel to read.
 * @param decoder - The decoder, one per channel.
 * @param limit - Messages per page.
 * @returns The deliveries, oldest first.
 */
export const drainHistory = async <E>(
  channel: Ably.RealtimeChannel,
  decoder: Decoder<E>,
  limit = 50,
): Promise<Delivery<E>[]> => {
  await channel.attach();
  const newestFirst: Ably.InboundMessage[] = [];
  let page = await channel.history({ untilAttach: true, limit });
  newestFirst.push(...page.items);
  while (page.hasNext()) {
    const next = await page.next();
    if (!next) break;
    page = next;
    newestFirst.push(...page.items);
  }
  return newestFirst
    .map((message) => decoder.decode(message))
    .toReversed()
    .flat();
};

/**
 * Wrap one of the target's members, binding every other one so the real
 * object keeps its `this`.
 * @param target - The object being proxied.
 * @param property - The member being read.
 * @param receiver - The proxy.
 * @returns The bound member.
 */
const boundMember = (target: object, property: string | symbol, receiver: unknown): unknown => {
  // CAST: the target's own members, bound so ably-js internals keep `this`.
  const value = Reflect.get(target, property, receiver) as unknown;
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
};

/**
 * A client whose channels' first `appendMessage` rejects, for the
 * append-repair scenario. Every other call goes to the real client and its
 * real channel.
 * @param client - The real client.
 * @param error - The rejection to inject.
 * @returns The wrapped client.
 */
export const failingFirstAppend = (client: Ably.Realtime, error: Error): Ably.Realtime => {
  let injected = false;
  const wrapChannel = (channel: Ably.RealtimeChannel): Ably.RealtimeChannel =>
    new Proxy(channel, {
      get: (target, property, receiver) => {
        if (property === 'appendMessage' && !injected) {
          injected = true;
          // eslint-disable-next-line @typescript-eslint/promise-function-async -- a rejected promise stands in for the real call
          return (): Promise<never> => Promise.reject(error);
        }
        return boundMember(target, property, receiver);
      },
    });
  return new Proxy(client, {
    get: (target, property, receiver) => {
      if (property === 'channels') {
        return {
          get: (name: string, options?: Ably.ChannelOptions): Ably.RealtimeChannel =>
            wrapChannel(target.channels.get(name, options)),
        };
      }
      return boundMember(target, property, receiver);
    },
  });
};
