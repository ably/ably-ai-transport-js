import type * as Ably from 'ably';
import { vi } from 'vitest';

/**
 * Create a minimal `Ably.Realtime` mock that returns the supplied channel
 * from `client.channels.get(<any name>)` and exposes a writable
 * `options.agents` map. Suitable for unit tests that previously injected a
 * pre-resolved channel directly into a session factory — pair it with the
 * file-local `createMockChannel()` helper.
 * @param channel - The mock channel to return from `channels.get(...)`.
 * @returns A mock `Ably.Realtime` instance.
 */
export const createMockClient = (channel: Ably.RealtimeChannel): Ably.Realtime => {
  const client = {
    channels: {
      get: vi.fn((name: string) => {
        // Mirror real Ably: the channel reports the name it was requested
        // under, so `channel.name` is meaningful (e.g. for invocation.sessionName).
        // CAST: `name` is readonly on Ably.RealtimeChannel; the mock is a plain object.
        (channel as unknown as { name: string }).name = name;
        return channel;
      }),
    },
    options: {} as { agents?: Record<string, string | undefined> },
  };
  // CAST: minimal stub — only `channels.get` and `options.agents` are exercised
  // in unit tests; other Ably.Realtime members are unused.
  return client as unknown as Ably.Realtime;
};
