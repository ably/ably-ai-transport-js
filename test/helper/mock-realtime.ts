import type * as Ably from 'ably';
import { vi } from 'vitest';

/**
 * Test mock for an `Ably.RealtimeChannel`. Records lifecycle calls and lets
 * tests drive state-change and message events synchronously via
 * {@link MockChannel.simulateStateChange} and {@link MockChannel.simulateMessage}.
 */
export interface MockChannel {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  /** Append-action publish; satisfies the `ChannelWriter` surface. */
  appendMessage: ReturnType<typeof vi.fn>;
  /** Update-action publish; satisfies the `ChannelWriter` surface. */
  updateMessage: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  /** Callbacks registered via on(events, listener) keyed by callback ref. */
  stateListeners: Map<Ably.channelEventCallback, Set<Ably.ChannelEvent>>;
  /** Callbacks registered via subscribe(listener). */
  messageListeners: Set<(message: Ably.InboundMessage) => void>;
  /**
   * Wire messages observed via publish(), in publish order. Each entry is
   * the array passed to publish() — single-message publishes wrap into a
   * one-element array so tests have a uniform shape.
   */
  publishedBatches: Ably.Message[][];
  /** Append-action calls observed, in arrival order. */
  appendedMessages: Ably.Message[];
  /** Update-action calls observed, in arrival order. */
  updatedMessages: Ably.Message[];
  /** Drive a state-change event to all listeners subscribed to it. */
  simulateStateChange: (change: Ably.ChannelStateChange) => void;
  /** Drive an inbound message to all message subscribers. */
  simulateMessage: (message: Ably.InboundMessage) => void;
}

/**
 * Create a {@link MockChannel}. `attach` and `detach` resolve immediately by
 * default — override `attach.mockImplementation` / `detach.mockImplementation`
 * to simulate failures.
 * @returns A new mock channel.
 */
export const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Map<Ably.channelEventCallback, Set<Ably.ChannelEvent>>();
  const messageListeners = new Set<(message: Ably.InboundMessage) => void>();
  const publishedBatches: Ably.Message[][] = [];
  const appendedMessages: Ably.Message[] = [];
  const updatedMessages: Ably.Message[] = [];
  let nextSerial = 0;
  const allocateSerial = (): string => {
    const value = `mock-serial-${String(nextSerial)}`;
    nextSerial += 1;
    return value;
  };
  const channel: MockChannel = {
    state: 'initialized',
    stateListeners,
    messageListeners,
    publishedBatches,
    appendedMessages,
    updatedMessages,
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
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock matches Ably.RealtimeChannel.subscribe signature.
    subscribe: vi.fn((listener: (message: Ably.InboundMessage) => void) => {
      messageListeners.add(listener);
      // eslint-disable-next-line unicorn/no-null -- Ably.RealtimeChannel.subscribe returns Promise<ChannelStateChange | null>.
      return Promise.resolve(null);
    }),
    unsubscribe: vi.fn((listener: (message: Ably.InboundMessage) => void) => {
      messageListeners.delete(listener);
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock matches Ably.RealtimeChannel.publish signature.
    publish: vi.fn((messages: Ably.Message | Ably.Message[]) => {
      const batch = Array.isArray(messages) ? [...messages] : [messages];
      publishedBatches.push(batch);
      // PublishResult.serials is one serial per published wire — allocate
      // monotonically increasing values so EncoderCore's stream tracker
      // can capture a stable id.
      const serials = batch.map(() => allocateSerial());
      const result: Ably.PublishResult = { serials };
      return Promise.resolve(result);
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock matches Ably.RealtimeChannel.appendMessage signature.
    appendMessage: vi.fn((message: Ably.Message) => {
      appendedMessages.push(message);
      return Promise.resolve({} as Ably.UpdateDeleteResult);
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock matches Ably.RealtimeChannel.updateMessage signature.
    updateMessage: vi.fn((message: Ably.Message) => {
      updatedMessages.push(message);
      return Promise.resolve({} as Ably.UpdateDeleteResult);
    }),
    simulateStateChange: (change: Ably.ChannelStateChange) => {
      for (const [callback, events] of stateListeners) {
        if (events.has(change.current)) {
          callback(change);
        }
      }
    },
    simulateMessage: (message: Ably.InboundMessage) => {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
  };
  // CAST: Tests only exercise the recorded surface — other channel members are unused.
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
  /**
   * Mirrors `Ably.Realtime.auth`. The writer reads `auth.clientId` to
   * attribute the initiator on `view.send`; tests can override this when
   * exercising the unauthenticated/wildcard rejection paths.
   */
  auth: { clientId: string };
}

/**
 * Create a {@link MockRealtime} that returns the same mock channel every time
 * `channels.get(name)` is called. Use {@link createMockRealtimeMulti} when
 * tests need distinct channels per name.
 * @param channel The channel to return from `channels.get`.
 * @param options Optional overrides for the mock realtime.
 * @param options.clientId The value writers read from `realtime.auth.clientId`.
 *   Defaults to `'mock-client'`.
 * @returns A new mock realtime client.
 */
export const createMockRealtime = (
  channel: Ably.RealtimeChannel,
  options?: { clientId?: string },
): MockRealtime & Ably.Realtime => {
  const realtime: MockRealtime = {
    channels: {
      get: vi.fn(() => channel),
      release: vi.fn(),
    },
    options: {},
    auth: { clientId: options?.clientId ?? 'mock-client' },
  };
  // CAST: Tests only use channels.get/release, options.agents, and auth.clientId
  //       — other Realtime members are unused.
  return realtime as unknown as MockRealtime & Ably.Realtime;
};
