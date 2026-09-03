/** Shared mock Ably channel and paginated-history fakes for transport unit tests. */

import type * as Ably from 'ably';
import { vi } from 'vitest';

/** The mock surface a test drives and asserts on, alongside the channel cast. */
export interface MockChannel {
  /** Records the message and resolves with a deterministic per-publish serial (`serial-<n>`). */
  publish: ReturnType<typeof vi.fn>;
  /** Captures the listener into {@link MockChannel.listener}. */
  subscribe: ReturnType<typeof vi.fn>;
  /** Clears {@link MockChannel.listener} when called with the captured listener. */
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Resolves immediately. */
  attach: ReturnType<typeof vi.fn>;
  /** Resolves with a paginated result over the pages given to {@link createMockChannel}. */
  history: ReturnType<typeof vi.fn>;
  /** Every message `publish` received, in order. */
  publishCalls: Ably.Message[];
  /** The wire names of {@link MockChannel.publishCalls}, in order. */
  publishNames: () => string[];
  /** The listener `subscribe` registered, or `undefined` once unsubscribed. */
  listener?: (msg: Ably.InboundMessage) => void;
  /** The channel's reported state. Starts ATTACHED. */
  state: Ably.ChannelState;
  /** Adds a state listener to {@link MockChannel.stateListeners}. */
  on: ReturnType<typeof vi.fn>;
  /** Removes a state listener (or all, when called bare). */
  off: ReturnType<typeof vi.fn>;
  /** The state listeners `on` registered, in registration order. */
  stateListeners: Set<Ably.channelEventCallback>;
  /** Deliver a channel state change to every registered state listener. */
  emitStateChange: (stateChange: Ably.ChannelStateChange) => void;
}

/**
 * Build a chain of Ably paginated results over `pages` (newest page first,
 * newest-first within each page — Ably's native history order).
 * @param pages - The history pages.
 * @returns The first paginated result.
 */
export const makePaginated = (pages: Ably.InboundMessage[][]): Ably.PaginatedResult<Ably.InboundMessage> => {
  const make = (i: number): Ably.PaginatedResult<Ably.InboundMessage> =>
    // CAST: the cursor only reads `items`, `hasNext()`, and `next()`.
    ({
      items: pages[i] ?? [],
      hasNext: () => i + 1 < pages.length,
      // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
      next: async () => (i + 1 < pages.length ? make(i + 1) : undefined),
    }) as unknown as Ably.PaginatedResult<Ably.InboundMessage>;
  return make(0);
};

/**
 * Build a mock channel recording publishes, capturing the subscribed listener,
 * and serving `pages` from `history()`.
 * @param pages - History pages the channel serves (newest first).
 * @returns The mock, cast to the channel interface the transports consume.
 */
export const createMockChannel = (pages: Ably.InboundMessage[][] = []): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    publishCalls: [],
    publishNames: () => mock.publishCalls.map((m) => m.name ?? ''),
    state: 'attached',
    stateListeners,
    on: vi.fn((listener: Ably.channelEventCallback): void => {
      stateListeners.add(listener);
    }),
    off: vi.fn((listener?: Ably.channelEventCallback): void => {
      if (listener) stateListeners.delete(listener);
      else stateListeners.clear();
    }),
    emitStateChange: (stateChange: Ably.ChannelStateChange): void => {
      for (const listener of stateListeners) listener(stateChange);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    publish: vi.fn(async (msg: Ably.Message | Ably.Message[]): Promise<Ably.PublishResult> => {
      // A batch publish (an input fanned out into one wire message per part)
      // arrives as an array; store flattened so `publishCalls` is honestly
      // per-message and per-publish serials stay deterministic.
      const messages = Array.isArray(msg) ? msg : [msg];
      mock.publishCalls.push(...messages);
      const base = mock.publishCalls.length - messages.length;
      return { serials: messages.map((_msg, index) => `serial-${String(base + index + 1)}`) };
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    subscribe: vi.fn(async (listener: (msg: Ably.InboundMessage) => void): Promise<void> => {
      mock.listener = listener;
    }),
    unsubscribe: vi.fn((listener: (msg: Ably.InboundMessage) => void): void => {
      if (mock.listener === listener) mock.listener = undefined;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    attach: vi.fn(async (): Promise<void> => undefined),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    history: vi.fn(async (): Promise<Ably.PaginatedResult<Ably.InboundMessage>> => makePaginated(pages)),
  };
  // CAST: tests only use publish/subscribe/unsubscribe/attach/history and the
  // state surface (state/on/off) — other RealtimeChannel members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};
