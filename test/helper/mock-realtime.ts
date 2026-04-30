import type * as Ably from 'ably';
import { vi } from 'vitest';

/**
 * Test mock for an `Ably.RealtimeChannel`. Records `attach`/`detach`/`on`/`off`
 * calls and lets tests drive state-change events synchronously via
 * {@link MockChannel.simulateStateChange}.
 */
export interface MockChannel {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  /** Callbacks registered via on(events, listener) keyed by callback ref. */
  stateListeners: Map<Ably.channelEventCallback, Set<Ably.ChannelEvent>>;
  /** Drive a state-change event to all listeners subscribed to it. */
  simulateStateChange: (change: Ably.ChannelStateChange) => void;
}

/**
 * Create a {@link MockChannel}. `attach` and `detach` resolve immediately by
 * default — override `attach.mockImplementation` / `detach.mockImplementation`
 * to simulate failures.
 * @returns A new mock channel.
 */
export const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Map<Ably.channelEventCallback, Set<Ably.ChannelEvent>>();
  const channel: MockChannel = {
    state: 'initialized',
    stateListeners,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    detach: vi.fn(() => Promise.resolve()),
    on: vi.fn((events: Ably.ChannelEvent | Ably.ChannelEvent[], callback: Ably.channelEventCallback) => {
      const eventArr = Array.isArray(events) ? events : [events];
      stateListeners.set(callback, new Set(eventArr));
    }),
    off: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.delete(callback);
    }),
    simulateStateChange: (change: Ably.ChannelStateChange) => {
      for (const [callback, events] of stateListeners) {
        if (events.has(change.current)) {
          callback(change);
        }
      }
    },
  };
  // CAST: Tests only exercise attach/detach/on/off — other channel members are unused.
  return channel as unknown as MockChannel & Ably.RealtimeChannel;
};

/**
 * Test mock for an `Ably.Realtime` client. Records `channels.get` and
 * `channels.release` calls and exposes the agents map written by the session.
 */
export interface MockRealtime {
  channels: {
    get: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  options: {
    agents?: Record<string, string | undefined>;
  };
}

/**
 * Create a {@link MockRealtime} that returns the same mock channel every time
 * `channels.get(name)` is called. Use {@link createMockRealtimeMulti} when
 * tests need distinct channels per name.
 * @param channel The channel to return from `channels.get`.
 * @returns A new mock realtime client.
 */
export const createMockRealtime = (channel: Ably.RealtimeChannel): MockRealtime & Ably.Realtime => {
  const realtime: MockRealtime = {
    channels: {
      get: vi.fn(() => channel),
      release: vi.fn(),
    },
    options: {},
  };
  // CAST: Tests only use channels.get/release and options.agents — other Realtime members are unused.
  return realtime as unknown as MockRealtime & Ably.Realtime;
};
