import type * as Ably from 'ably';
import { vi } from 'vitest';

/**
 * Create a minimal `Ably.Realtime` mock that returns the supplied channel
 * from `client.channels.get(<any name>)` and exposes a writable
 * `options.agents` map. Suitable for unit tests that previously injected a
 * pre-resolved channel directly into a session factory — pair it with the
 * file-local `createMockChannel()` helper.
 *
 * The mock also exposes `auth.clientId`, which `ClientSession` reads to
 * determine its publish identity. Omit it (or pass `undefined`) to model an
 * anonymous connection, and pass `'*'` to model a wildcard token — both of
 * which a client session treats as having no concrete identity. Agent sessions
 * never read it.
 *
 * `close` is a spy, so a test can assert that SDK code left the injected client
 * alone — the caller owns the client's lifecycle.
 * @param channel - The mock channel to return from `channels.get(...)`.
 * @param clientId - The mock connection identity exposed as `auth.clientId`;
 *   `undefined` (the default) models an anonymous connection.
 * @returns A mock `Ably.Realtime` instance.
 */
export const createMockClient = (channel: Ably.RealtimeChannel, clientId?: string): Ably.Realtime => {
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
    auth: { clientId },
    options: {} as { agents?: Record<string, string | undefined> },
    close: vi.fn(),
  };
  // CAST: minimal stub — only `channels.get`, `auth.clientId`,
  // `options.agents`, and `close` are exercised in unit tests; other
  // Ably.Realtime members are unused.
  return client as unknown as Ably.Realtime;
};

/** A mock client plus the levers a pool test needs to drive it. */
export interface PoolableMockClient {
  /** The mock, to hand to the code under test. */
  readonly client: Ably.Realtime;
  /** Channel names passed to `channels.release`, in order. */
  readonly releasedChannels: string[];
  /** Whether `close()` has been called. */
  readonly closed: boolean;
  /** How many times `close()` has been called, so double-closes are visible. */
  readonly closeCalls: number;
  /** Drive the connection to a state, notifying any listeners. */
  setConnectionState(state: Ably.ConnectionState): void;
  /**
   * Model ably-js deferring the channel drop: `channels.release` leaves this
   * name in `channels.all`, as it does for a channel that is not yet DETACHED.
   * @param name - The channel name to keep.
   */
  deferReleaseOf(name: string): void;
}

/**
 * Create a mock client that exercises the surface a connection pool touches:
 * `channels.release`, `channels.all`, `connection.state` and its listeners, and
 * `close`.
 *
 * `close()` drives the connection straight to CLOSED and notifies listeners, so a
 * pool awaiting teardown resolves without a timer.
 * @returns The mock and the levers to drive it.
 */
export const createPoolableMockClient = (): PoolableMockClient => {
  const releasedChannels: string[] = [];
  const all: Record<string, unknown> = {};
  const deferred = new Set<string>();
  const listeners = new Set<(change: Ably.ConnectionStateChange) => void>();

  let state: Ably.ConnectionState = 'connected';
  let closeCalls = 0;

  // A listener that deregisters itself while being notified is fine: removing the
  // current entry of a Set mid-iteration is defined behaviour.
  const notify = (current: Ably.ConnectionState): void => {
    for (const listener of listeners) {
      // CAST: the pool's listener reads `current` only.
      listener({ current } as Ably.ConnectionStateChange);
    }
  };

  const client = {
    channels: {
      get: vi.fn((name: string) => {
        all[name] = { name };
        return all[name];
      }),
      release: vi.fn((name: string) => {
        releasedChannels.push(name);
        // ably-js drops the entry here only for a channel already in a terminal
        // state; otherwise the delete lands in a later promise callback, leaving
        // the object reachable in the meantime.
        if (deferred.has(name)) all[name] = { name };
        else Reflect.deleteProperty(all, name);
      }),
      all,
    },
    connection: {
      get state(): Ably.ConnectionState {
        return state;
      },
      on: vi.fn((_events: Ably.ConnectionEvent[], listener: (change: Ably.ConnectionStateChange) => void) => {
        listeners.add(listener);
      }),
      off: vi.fn((listener: (change: Ably.ConnectionStateChange) => void) => {
        listeners.delete(listener);
      }),
    },
    options: {} as { agents?: Record<string, string | undefined> },
    close: vi.fn(() => {
      closeCalls += 1;
      state = 'closed';
      notify('closed');
    }),
  };

  return {
    // CAST: minimal stub — only the members a pool touches are implemented.
    client: client as unknown as Ably.Realtime,
    releasedChannels,
    get closed(): boolean {
      return closeCalls > 0;
    },
    get closeCalls(): number {
      return closeCalls;
    },
    setConnectionState: (next: Ably.ConnectionState): void => {
      state = next;
      notify(next);
    },
    deferReleaseOf: (name: string): void => {
      deferred.add(name);
    },
  };
};
