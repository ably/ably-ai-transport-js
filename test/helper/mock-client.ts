/** A mock Ably Realtime client that hands the transport a mock channel. */

import type * as Ably from 'ably';
import { type Mock, vi } from 'vitest';

/** The mock surface a test drives and asserts on, alongside the client cast. */
export interface MockClient {
  /** Returns the channel the mock was built with, and records the name and options it was asked for. */
  channels: { get: Mock<(name: string, options?: Ably.ChannelOptions) => Ably.RealtimeChannel> };
  /** The client options, where the transport registers its agent entries under `agents`. */
  options: { agents?: Record<string, string | undefined> };
}

/**
 * Create a minimal `Ably.Realtime` mock whose `channels.get` returns the
 * supplied channel whatever name it is asked for, recording the name and
 * options each call received.
 * @param channel - The channel to return from `channels.get`.
 * @returns The mock client, cast to `Ably.Realtime`.
 */
export const createMockClient = (channel: Ably.RealtimeChannel): MockClient & Ably.Realtime => {
  const client: MockClient = {
    channels: { get: vi.fn(() => channel) },
    options: {},
  };
  // CAST: a minimal stub — the transport only calls `channels.get` and
  // registers its agent under `options.agents`, and the surrounding test
  // drives the channel directly.
  return client as MockClient & Ably.Realtime;
};
