/**
 * The channel a client-side adapter reads, as its suites drive and assert on
 * it: it serves history pages and live delivery, and moves through its states
 * as ably-js does.
 */

import type * as Ably from '@ably/pubsub-core';
import { type Mock, vi } from 'vitest';

/**
 * The mock channel an adapter is handed: the operations an adapter reads it
 * through, and `publish`, which no adapter calls.
 */
export interface ReadChannel {
  /** The channel's name. */
  name: string;
  /** The channel's state, INITIALIZED until something attaches it. */
  state: Ably.ChannelState;
  /** Captures the listener into {@link ReadChannel.listener}. */
  subscribe: Mock<(listener: (message: Ably.InboundMessage) => void) => Promise<null>>;
  /** Clears {@link ReadChannel.listener} when called with the captured listener. */
  unsubscribe: Mock<(listener: (message: Ably.InboundMessage) => void) => void>;
  /** Takes the channel to ATTACHED, with `resumed: false` as on a fresh attach, unless it is attached already. */
  attach: Mock<() => Promise<null>>;
  /** Takes an attached channel to DETACHING at once, and to DETACHED once the detach completes. */
  detach: Mock<() => Promise<void>>;
  /** Resolves with the history pages the channel was built with. */
  history: Mock<(params?: Ably.RealtimeHistoryParams) => Promise<Ably.PaginatedResult<Ably.InboundMessage>>>;
  /** Records a publish, which no adapter makes. */
  publish: Mock<(message: Ably.Message) => Promise<Ably.PublishResult>>;
  /** Adds a state listener. */
  on: Mock<(listener: Ably.channelEventCallback) => void>;
  /** Removes a state listener. */
  off: Mock<(listener: Ably.channelEventCallback) => void>;
  /** The listener `subscribe` captured, or `undefined` once unsubscribed. */
  listener?: (message: Ably.InboundMessage) => void;
  /**
   * Deliver a state change to every state listener, as the channel would.
   * @param stateChange - The state change.
   */
  emitStateChange: (stateChange: Ably.ChannelStateChange) => void;
}

/**
 * Serve history pages as Ably's paginated results do.
 * @param pages - The pages, newest first, each newest first within itself.
 * @returns The first page.
 */
export const paginated = (pages: Ably.InboundMessage[][]): Ably.PaginatedResult<Ably.InboundMessage> => {
  const page = (index: number): Ably.PaginatedResult<Ably.InboundMessage> =>
    // CAST: the adapters read only `items`, `hasNext()` and `next()`.
    ({
      items: pages[index] ?? [],
      hasNext: () => index + 1 < pages.length,
      // eslint-disable-next-line @typescript-eslint/require-await, unicorn/no-null -- mock returns a resolved promise, and ably-js resolves null past the last page
      next: async () => (index + 1 < pages.length ? page(index + 1) : null),
    }) as unknown as Ably.PaginatedResult<Ably.InboundMessage>;
  return page(0);
};

/**
 * Move a mock channel to a state, emitting the state change as ably-js
 * does.
 * @param channel - The channel.
 * @param current - The state it moves to.
 */
const moveTo = (channel: ReadChannel, current: Ably.ChannelState): void => {
  const previous = channel.state;
  channel.state = current;
  channel.emitStateChange({ current, previous, resumed: false });
};

/**
 * Build the channel an adapter is handed, serving `pages` as its history.
 * @param pages - The history pages, newest first.
 * @returns The mock, cast to the channel an adapter takes.
 */
const createReadChannel = (pages: Ably.InboundMessage[][]): ReadChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const channel: ReadChannel = {
    name: 'chat',
    state: 'initialized',
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    subscribe: vi.fn(async (listener: (message: Ably.InboundMessage) => void): Promise<null> => {
      channel.listener = listener;
      // eslint-disable-next-line unicorn/no-null -- ably-js resolves subscribe with null when the attach changed nothing
      return null;
    }),
    unsubscribe: vi.fn((listener: (message: Ably.InboundMessage) => void): void => {
      if (channel.listener === listener) channel.listener = undefined;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    attach: vi.fn(async (): Promise<null> => {
      if (channel.state !== 'attached') moveTo(channel, 'attached');
      // eslint-disable-next-line unicorn/no-null -- ably-js resolves attach with null when it changed nothing
      return null;
    }),
    detach: vi.fn(async (): Promise<void> => {
      if (channel.state !== 'attached') return;
      moveTo(channel, 'detaching');
      await Promise.resolve();
      moveTo(channel, 'detached');
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    history: vi.fn(async (): Promise<Ably.PaginatedResult<Ably.InboundMessage>> => paginated(pages)),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    publish: vi.fn(async (): Promise<Ably.PublishResult> => ({ serials: [] })),
    on: vi.fn((listener: Ably.channelEventCallback): void => {
      stateListeners.add(listener);
    }),
    off: vi.fn((listener: Ably.channelEventCallback): void => {
      stateListeners.delete(listener);
    }),
    emitStateChange: (stateChange: Ably.ChannelStateChange): void => {
      for (const listener of stateListeners) listener(stateChange);
    },
  };
  // CAST: the adapters use only the members above.
  return channel as unknown as ReadChannel & Ably.RealtimeChannel;
};

/** A mock channel, with what is already on it served as history. */
export interface ChannelFixture {
  /** The mock channel. */
  channel: ReadChannel & Ably.RealtimeChannel;
  /**
   * Deliver messages to the subscribed listener, as the channel would live.
   * @param messages - The messages, in order.
   */
  deliver: (messages: Ably.InboundMessage[]) => void;
}

/**
 * A mock channel whose history holds `stored`, newest first as Ably serves
 * it, on pages of `pageSize` messages.
 * @param stored - What history holds, oldest first.
 * @param pageSize - How many messages a page holds; one page holds them all by default.
 * @returns The fixture.
 */
export const channelWith = (stored: Ably.InboundMessage[] = [], pageSize = Infinity): ChannelFixture => {
  const newestFirst = stored.toReversed();
  const pages: Ably.InboundMessage[][] = [];
  for (let start = 0; start < newestFirst.length; start += pageSize) {
    pages.push(newestFirst.slice(start, start + pageSize));
  }
  const channel = createReadChannel(pages);
  return {
    channel,
    deliver: (messages) => {
      for (const message of messages) channel.listener?.(message);
    },
  };
};

/** A wait a test ends itself. */
export interface Gate {
  /** Resolves once the gate opens. */
  promise: Promise<void>;
  /** Open the gate. */
  open: () => void;
}

/**
 * A wait a test ends itself, such as a detach still in flight.
 * @returns The gate, closed.
 */
export const gate = (): Gate => {
  const opener: { open?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    opener.open = resolve;
  });
  return {
    promise,
    open: () => {
      opener.open?.();
    },
  };
};
