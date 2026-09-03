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
import { flushMicrotasks } from '../helper/streams.js';

/**
 * A provider tree, with an inert codec stub — the provider hands the codec
 * straight to the mocked transport factory, so nothing reads it.
 * @param props - The provider's props.
 * @param props.channelName - The channel the provider resolves.
 * @param props.channelModes - Extra modes to request on the channel, if any.
 * @param props.children - The tree to render under the provider.
 * @returns The element to render.
 */
const provider = ({
  channelName = 'ai:test',
  channelModes,
  children,
}: {
  channelName?: string;
  channelModes?: readonly Ably.ChannelMode[];
  children?: ReactNode;
}): ReactNode =>
  createElement(
    ClientTransportProvider,
    { channelName, codec: {} as never, ...(channelModes ? { channelModes } : {}) },
    children,
  );

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

// The default wrapper: one provider on channelName "ai:test".
const wrapDefault = ({ children }: { children?: ReactNode }): ReactNode => provider({ children });

// Provider requesting the LiveObjects mode set.
const wrapWithModes = ({ children }: { children?: ReactNode }): ReactNode =>
  provider({ channelModes: OBJECT_MODES, children });

// Nested providers for the named-lookup case.
const wrapNested = ({ children }: { children?: ReactNode }): ReactNode =>
  provider({
    channelName: 'ai:outer',
    children: provider({ channelName: 'ai:inner', children }),
  });

/**
 * Register a fresh fake as the transport the mocked factory builds, and return
 * it so the test can read its call counts.
 * @returns The registered fake.
 */
const arrangeFake = (): FakeTransport => {
  const fake = createFakeTransport();
  createClientTransportMock.mockImplementation(() => fake);
  return fake;
};

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
    const fake = arrangeFake();

    renderHook(() => useClientTransport(), { wrapper: wrapDefault });
    await act(flushMicrotasks);

    expect(fake.connectCalls).toBe(1);
  });

  it('pairs every Strict-Mode transport with its own close', async () => {
    // Creation lives in an effect, so Strict Mode's mount/fake-unmount/remount
    // runs setup, cleanup, setup: two transports built and the first closed.
    // Nothing is left attached, which is the property that matters.
    const built: FakeTransport[] = [];
    createClientTransportMock.mockImplementation(() => {
      const fake = createFakeTransport();
      built.push(fake);
      return fake;
    });

    const view = render(createElement(StrictMode, undefined, provider({})));
    await act(flushMicrotasks);

    expect(built).toHaveLength(2);
    expect(built[0]?.closeCalls).toBe(1);
    expect(built[1]?.closeCalls).toBe(0);
    expect(built[1]?.connectCalls).toBe(1);

    view.unmount();
    await act(flushMicrotasks);
    expect(built[1]?.closeCalls).toBe(1);
  });

  it('does not rebuild when a re-render passes an equal modes array', () => {
    // The transport is rebuilt from the resolved channel options, and a caller
    // writing `channelModes={[...]}` inline hands over a new array every
    // render. Comparing contents is what stops that reopening the channel.
    arrangeFake();
    const { rerender } = render(provider({ channelModes: ['publish', 'subscribe'] }));
    rerender(provider({ channelModes: ['publish', 'subscribe'] }));

    expect(createClientTransportMock).toHaveBeenCalledTimes(1);
  });

  it('has no transport on the render before its effect runs', () => {
    // The transport is built after the commit, so the first render sees an
    // undefined slot. Both hooks type it optional for exactly this.
    const fake = arrangeFake();
    const seen: (ClientTransport<unknown, unknown> | undefined)[] = [];

    renderHook(
      () => {
        const { transport } = useClientTransport();
        seen.push(transport);
        return transport;
      },
      { wrapper: wrapDefault },
    );

    expect(seen[0]).toBeUndefined();
    expect(seen.at(-1)).toBe(fake);
  });

  it('closes the transport on a true unmount', async () => {
    const fake = arrangeFake();

    const view = render(provider({}));
    view.unmount();
    await act(flushMicrotasks);

    expect(fake.closeCalls).toBe(1);
  });

  it('recreates the transport on a channelName change and closes the superseded one', async () => {
    const first = createFakeTransport();
    const second = createFakeTransport();
    createClientTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

    const view = render(provider({ channelName: 'ai:one' }));
    expect(createClientTransportMock).toHaveBeenCalledTimes(1);

    view.rerender(provider({ channelName: 'ai:two' }));
    await act(flushMicrotasks);

    // A second transport is built for the new channel, and the superseded one
    // is closed — leaving it open would leak an ATTACHED channel.
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

  it('wraps a non-ErrorInfo construction throw as invalid argument, carrying its detail', () => {
    createClientTransportMock.mockImplementation(() => {
      throw new Error('channels.get exploded');
    });

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    // What reaches here is a bad channelName or a closed client, so the code
    // says caller input rather than SDK fault. The original's detail rides the
    // message; a plain Error carries no ErrorInfo cause to propagate.
    expect(result.current.error).toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      statusCode: 400,
      message: 'unable to create client transport; channels.get exploded',
    });
  });

  it('surfaces a construction throw as the handle error without crashing the tree', () => {
    const error = new Ably.ErrorInfo('unable to create client transport; boom', ErrorCode.InvalidArgument, 400);
    createClientTransportMock.mockImplementation(() => {
      throw error;
    });

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBe(error);
  });

  it('leaves the event hooks inert when construction failed', () => {
    // The provider deliberately supports a transport-less slot, so the hooks
    // under it must tolerate one rather than throw on an absent transport.
    createClientTransportMock.mockImplementation(() => {
      throw new Ably.ErrorInfo('unable to create client transport; boom', ErrorCode.InvalidArgument, 400);
    });
    const handler = vi.fn();

    const events = renderHook(
      () => {
        useTransportEvents(handler);
      },
      { wrapper: wrapDefault },
    );
    const messages = renderHook(() => useAblyMessages(), { wrapper: wrapDefault });

    expect(handler).not.toHaveBeenCalled();
    expect(events.result.current).toBeUndefined();
    expect(messages.result.current).toEqual([]);
  });
});

describe('useClientTransport', () => {
  it('returns the provider transport and no error', () => {
    const fake = arrangeFake();

    const { result } = renderHook(() => useClientTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBe(fake);
    expect(result.current.error).toBeUndefined();
  });

  it('resolves a named provider through nesting', () => {
    const outer = createFakeTransport();
    const inner = createFakeTransport();
    // Keyed on the channel, not on call order: each provider builds its
    // transport in an effect, and React runs a child's effects before its
    // parent's, so the inner provider constructs first.
    createClientTransportMock.mockImplementation((options: unknown) => {
      // CAST: the mocked factory is typed `(options: unknown) => unknown`; the
      // provider always passes the resolved channel through.
      const { channel } = options as { channel: Ably.RealtimeChannel };
      return channel.name === 'ai:outer' ? outer : inner;
    });

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
    const fake = arrangeFake();
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
    const fake = arrangeFake();
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
    const fake = arrangeFake();

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

  it('resets the log when the provider recreates the transport', () => {
    const fakes = [createFakeTransport(), createFakeTransport()];
    let next = 0;
    createClientTransportMock.mockImplementation(() => fakes[next++]);
    const channelRef = { value: 'ai:first' };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(ClientTransportProvider, { channelName: channelRef.value, codec: {} as never }, children);

    const { result, rerender } = renderHook(() => useAblyMessages(), { wrapper });
    // CAST: the hook stores the messages opaquely; a minimal stub suffices.
    const msg = { name: 'ai-output', data: 'one' } as Ably.InboundMessage;
    act(() => {
      fakes[0]?.emitAblyMessage(msg);
    });
    expect(result.current).toEqual([msg]);

    // A channel-name change recreates the transport; the log starts over.
    channelRef.value = 'ai:second';
    rerender();
    expect(result.current).toEqual([]);

    // CAST: minimal stub, as above.
    const msg2 = { name: 'ai-output', data: 'two' } as Ably.InboundMessage;
    act(() => {
      fakes[1]?.emitAblyMessage(msg2);
    });
    expect(result.current).toEqual([msg2]);
  });

  it('reads a named provider through the channelName option', () => {
    const fakes = new Map<string, FakeTransport>();
    createClientTransportMock.mockImplementation((options) => {
      // CAST: the mock records the options bag; only channel.name is read.
      const name = (options as { channel: { name: string } }).channel.name;
      const fake = createFakeTransport();
      fakes.set(name, fake);
      return fake;
    });

    const { result } = renderHook(() => useAblyMessages({ channelName: 'ai:outer' }), { wrapper: wrapNested });

    // CAST: minimal stub, as above.
    const outerMsg = { name: 'ai-output', data: 'outer' } as Ably.InboundMessage;
    act(() => {
      fakes.get('ai:outer')?.emitAblyMessage(outerMsg);
      // CAST: minimal stub, as above.
      fakes.get('ai:inner')?.emitAblyMessage({ name: 'ai-output', data: 'inner' } as Ably.InboundMessage);
    });

    // Only the named provider's messages land; the nearer provider's do not.
    expect(result.current).toEqual([outerMsg]);
  });
});
