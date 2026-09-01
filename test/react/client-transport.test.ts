// @vitest-environment jsdom

/**
 * The transport-shaped React surface: ClientTransportProvider creates a
 * ClientTransport on the named channel (resolved through ably-js with the
 * SDK's agent and mode set), connects it, survives a Strict-Mode remount, and
 * closes it on a true unmount; useClientTransport reads it back;
 * useTransportEvents and useAblyMessages wrap its streams in effects.
 */

import '../helper/expectations.js';

import { act, render, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OBJECT_MODES, resolveChannelModes } from '../../src/core/channel-options.js';
import type { ClientTransport, TransportEvent } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientTransportProvider } from '../../src/react/contexts/client-transport-provider.js';
import { useClientTransport } from '../../src/react/use-client-transport.js';
import { useAblyMessages } from '../../src/react/use-transport-ably-messages.js';
import { useTransportEvents } from '../../src/react/use-transport-events.js';

/** Flush microtasks (but NOT macrotasks) so the deferred unmount close fires. */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

/**
 * A provider tree on one channel, for asserting what a channelName change does.
 * @param channelName - The channel the provider resolves.
 * @returns The element to render.
 */
const providerTree = (channelName: string): ReactNode =>
  createElement(ClientTransportProvider, { channelName, codec: {} as never, children: undefined });

/** Inert unsubscribe for the fake's unhandled events. */
const noopUnsubscribe = (): void => {
  /* inert */
};

// Capture the options the provider passes to ably-js's <ChannelProvider>.
const channelProviderCapture = vi.hoisted(() => ({ options: undefined as Ably.ChannelOptions | undefined }));

// Stand-in Realtime client returned by the mocked `useAbly()`; its channels.get
// records the resolution the provider performs.
const channelsGetMock = vi.hoisted(() =>
  // The options parameter exists so mock.calls carries the resolved channel options.
  vi.fn((name: string, options?: Ably.ChannelOptions) => ({ name, options }) as unknown as Ably.RealtimeChannel),
);
const fakeAblyClient = { channels: { get: channelsGetMock } } as unknown as Ably.Realtime;

vi.mock('ably/react', async () => {
  const { createElement: h, Fragment } = await import('react');
  return {
    useAbly: () => fakeAblyClient,
    ChannelProvider: ({ children, options }: { children?: ReactNode; options?: Ably.ChannelOptions }) => {
      channelProviderCapture.options = options;
      return h(Fragment, undefined, children);
    },
  };
});

/** A recording fake ClientTransport the mocked factory returns. */
interface FakeTransport extends ClientTransport<unknown, unknown> {
  /** Emit a classified event to every `subscribe` handler. */
  emitEvent(event: TransportEvent<unknown, unknown>): void;
  /** Emit a raw message to every `ably-message` handler. */
  emitAblyMessage(msg: Ably.InboundMessage): void;
  /** Number of connect() calls. */
  connectCalls: number;
  /** Number of close() calls. */
  closeCalls: number;
}

const createFakeTransport = (): FakeTransport => {
  const eventHandlers = new Set<(event: TransportEvent<unknown, unknown>) => void>();
  const rawHandlers = new Set<(msg: Ably.InboundMessage) => void>();
  const fake: Partial<FakeTransport> = {
    connectCalls: 0,
    closeCalls: 0,
    // eslint-disable-next-line @typescript-eslint/require-await -- fake resolves immediately
    connect: async () => {
      fake.connectCalls = (fake.connectCalls ?? 0) + 1;
    },
    subscribe: (handler) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    // CAST: the fake narrows `on` to the two events the hooks use.
    on: (event: string, handler: (arg: never) => void) => {
      if (event === 'ably-message') {
        rawHandlers.add(handler as (msg: Ably.InboundMessage) => void);
        return () => rawHandlers.delete(handler as (msg: Ably.InboundMessage) => void);
      }
      return noopUnsubscribe;
    },
    close: () => {
      fake.closeCalls = (fake.closeCalls ?? 0) + 1;
    },
    emitEvent: (event) => {
      for (const handler of eventHandlers) handler(event);
    },
    emitAblyMessage: (msg) => {
      for (const handler of rawHandlers) handler(msg);
    },
  };
  // CAST: the provider and hooks call only the members stubbed above.
  return fake as FakeTransport;
};

const createClientTransportMock = vi.hoisted(() => vi.fn<(options: unknown) => unknown>());

vi.mock('../../src/core/transport/client-transport.js', () => ({
  createClientTransport: (options: unknown) => createClientTransportMock(options),
}));

// Provider on channelName "ai:test" with an inert codec stub.
const wrapDefault = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(ClientTransportProvider, { channelName: 'ai:test', codec: {} as never }, children);

// Provider requesting the LiveObjects mode set.
const wrapWithModes = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    ClientTransportProvider,
    { channelName: 'ai:test', codec: {} as never, channelModes: OBJECT_MODES },
    children,
  );

// Nested providers for the named-lookup case.
const wrapNested = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    ClientTransportProvider,
    { channelName: 'ai:outer', codec: {} as never },
    createElement(ClientTransportProvider, { channelName: 'ai:inner', codec: {} as never }, children),
  );

beforeEach(() => {
  vi.clearAllMocks();
  channelProviderCapture.options = undefined;
  createClientTransportMock.mockImplementation(() => createFakeTransport());
});

describe('ClientTransportProvider', () => {
  it('resolves the channel by name and creates the transport on it', () => {
    renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher for the agent-seeded params bag
    const anyParams: Ably.ChannelOptions = expect.objectContaining({ params: expect.anything() });
    expect(channelsGetMock).toHaveBeenCalledWith('ai:test', anyParams);
    expect(createClientTransportMock).toHaveBeenCalledTimes(1);
    // CAST: the mock records the options bag; only channel is read.
    const options = createClientTransportMock.mock.calls[0]?.[0] as { channel: { name: string } };
    expect(options.channel.name).toBe('ai:test');
  });

  it('passes the same agent-seeded options to the ChannelProvider', () => {
    renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    const resolved = channelsGetMock.mock.calls[0]?.[1];
    expect(channelProviderCapture.options).toBe(resolved);
    expect(channelProviderCapture.options?.params?.agent).toContain('ai-transport-js');
  });

  it('requests the resolved mode set when channelModes are supplied', () => {
    renderHook(() => useClientTransport(), { wrapper: wrapWithModes });

    expect(channelProviderCapture.options?.modes).toEqual(resolveChannelModes(OBJECT_MODES));
  });

  it('connects the transport once mounted', async () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);

    renderHook(() => useClientTransport(), { wrapper: wrapDefault });
    await act(flushMicrotasks);

    expect(fake.connectCalls).toBe(1);
  });

  it('survives a Strict-Mode remount without closing the transport', async () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);

    const view = render(createElement(StrictMode, undefined, createElement(wrapDefault, { children: undefined })));
    await act(flushMicrotasks);

    expect(createClientTransportMock).toHaveBeenCalledTimes(1);
    expect(fake.closeCalls).toBe(0);
    view.unmount();
    await act(flushMicrotasks);
    expect(fake.closeCalls).toBe(1);
  });

  it('closes the transport on a true unmount', async () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);

    const view = render(createElement(wrapDefault, { children: undefined }));
    view.unmount();
    await act(flushMicrotasks);

    expect(fake.closeCalls).toBe(1);
  });

  it('recreates the transport on a channelName change and closes the superseded one', async () => {
    const first = createFakeTransport();
    const second = createFakeTransport();
    createClientTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

    const view = render(providerTree('ai:one'));
    expect(createClientTransportMock).toHaveBeenCalledTimes(1);

    view.rerender(providerTree('ai:two'));
    await act(flushMicrotasks);

    // A second transport is built for the new channel, and the superseded one
    // is closed — leaving it open would leak an attached channel.
    expect(createClientTransportMock).toHaveBeenCalledTimes(2);
    expect(first.closeCalls).toBe(1);
    expect(second.connectCalls).toBe(1);

    view.unmount();
    await act(flushMicrotasks);
  });

  it('survives a connect() rejection and leaves the tree standing', async () => {
    const fake = createFakeTransport();
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- rejects synchronously
    fake.connect = () => Promise.reject(new Ably.ErrorInfo('nope', ErrorCode.SessionClosed, 500));
    createClientTransportMock.mockImplementation(() => fake);

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });
    await act(flushMicrotasks);

    // connect() failure reaches the consumer on the transport's own error
    // stream, not by tearing the React tree down.
    expect(result.current.transport).toBe(fake);
  });

  it('wraps a non-ErrorInfo construction throw, keeping the original as the cause', () => {
    createClientTransportMock.mockImplementation(() => {
      throw new Error('channels.get exploded');
    });

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBeErrorInfo({
      code: ErrorCode.InternalError,
      message: 'unable to create client transport; channels.get exploded',
      cause: { message: 'channels.get exploded' },
    });
  });

  it('surfaces a construction throw as the handle error without crashing the tree', () => {
    const error = new Ably.ErrorInfo('unable to create client transport; boom', ErrorCode.BadRequest, 400);
    createClientTransportMock.mockImplementation(() => {
      throw error;
    });

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBe(error);
  });
});

describe('useClientTransport', () => {
  it('returns the provider transport and no error', () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBe(fake);
    expect(result.current.error).toBeUndefined();
  });

  it('resolves a named provider through nesting', () => {
    const outer = createFakeTransport();
    const inner = createFakeTransport();
    createClientTransportMock.mockImplementationOnce(() => outer).mockImplementationOnce(() => inner);

    const { result } = renderHook(
      () => ({
        byName: useClientTransport({ channelName: 'ai:outer' }),
        nearest: useClientTransport(),
      }),
      { wrapper: wrapNested },
    );

    expect(result.current.byName.transport).toBe(outer);
    expect(result.current.nearest.transport).toBe(inner);
  });

  it('throws when no provider encloses the caller', () => {
    expect(() => renderHook(() => useClientTransport())).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
  });
});

describe('useTransportEvents', () => {
  it('delivers classified events to the handler and unsubscribes on unmount', () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);
    const seen: TransportEvent<unknown, unknown>[] = [];

    const { unmount } = renderHook(
      () => {
        useTransportEvents((event) => {
          seen.push(event);
        });
      },
      { wrapper: wrapDefault },
    );

    const event: TransportEvent<unknown, unknown> = {
      kind: 'run-lifecycle',
      event: { type: 'start', runId: 'r1', clientId: '', invocationId: '', serial: 's1' },
    };
    act(() => {
      fake.emitEvent(event);
    });
    expect(seen).toEqual([event]);

    unmount();
    act(() => {
      fake.emitEvent(event);
    });
    expect(seen).toHaveLength(1);
  });

  it('reads the latest handler without resubscribing', () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);
    const first: string[] = [];
    const second: string[] = [];
    let target = first;

    const { rerender } = renderHook(
      () => {
        useTransportEvents((event) => {
          if (event.kind === 'run-lifecycle') target.push(event.event.runId);
        });
      },
      { wrapper: wrapDefault },
    );

    target = second;
    rerender();
    act(() => {
      fake.emitEvent({
        kind: 'run-lifecycle',
        event: { type: 'start', runId: 'r1', clientId: '', invocationId: '', serial: 's1' },
      });
    });

    expect(first).toEqual([]);
    expect(second).toEqual(['r1']);
  });
});

describe('useAblyMessages', () => {
  it('accumulates raw messages in arrival order', () => {
    const fake = createFakeTransport();
    createClientTransportMock.mockImplementation(() => fake);

    const { result } = renderHook(() => useAblyMessages(), { wrapper: wrapDefault });

    // CAST: the hook stores the messages opaquely; a minimal stub suffices.
    const msg1 = { name: 'ai-output', data: 'one' } as Ably.InboundMessage;
    const msg2 = { name: 'ai-output', data: 'two' } as Ably.InboundMessage;
    act(() => {
      fake.emitAblyMessage(msg1);
      fake.emitAblyMessage(msg2);
    });

    expect(result.current).toEqual([msg1, msg2]);
  });
});
