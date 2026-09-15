// @vitest-environment jsdom

/**
 * The React surface: TransportProvider creates a Transport on the named
 * channel (resolved through ably-js with the SDK's agent and mode set),
 * survives a Strict-Mode remount, and closes it on a true unmount;
 * useTransport reads it back; useDeliveries, useHistory and
 * useTransportStatus wrap the transport's subscribe, history and events in
 * effects.
 */

import '../helper/expectations.js';

import { act, render, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OBJECT_MODES, resolveChannelModes } from '../../src/core/channel-options.js';
import type { Delivery } from '../../src/core/codec/index.js';
import type { HistoryPage, Transport } from '../../src/core/transport/index.js';
import { ErrorCode } from '../../src/errors.js';
import { TransportProvider } from '../../src/react/contexts/transport-provider.js';
import { useDeliveries } from '../../src/react/use-deliveries.js';
import { useHistory } from '../../src/react/use-history.js';
import { useTransport } from '../../src/react/use-transport.js';
import { useTransportStatus } from '../../src/react/use-transport-status.js';
import { flushMicrotasks } from '../helper/streams.js';

/**
 * A provider tree, with an inert codec stub: the provider hands the codec
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
    TransportProvider,
    { channelName, codec: { adapterTag: 'test' } as never, ...(channelModes ? { channelModes } : {}) },
    children,
  );

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

/** A recording fake Transport the mocked factory returns. */
interface FakeTransport extends Transport<unknown> {
  /** Deliver to every `subscribe` handler. */
  emit(delivery: Delivery<unknown>): void;
  /** Report a discontinuity to every listener. */
  emitDiscontinuity(): void;
  /** Report an error to every listener. */
  emitError(error: Ably.ErrorInfo): void;
  /** Number of `subscribe` calls. */
  subscribeCalls: number;
  /** Number of handlers still subscribed. */
  handlerCount: number;
  /** Number of close() calls. */
  closeCalls: number;
  /** The pages of the walk `history()` opens, newest first; `next()` steps through them. */
  pages: Pick<HistoryPage<unknown>, 'items' | 'hasNext'>[];
  /** The `limit` each `history` call carried. */
  historyLimits: number[];
}

const createFakeTransport = (): FakeTransport => {
  const handlers = new Set<(delivery: Delivery<unknown>) => void>();
  const discontinuityHandlers = new Set<() => void>();
  const errorHandlers = new Set<(e: Ably.ErrorInfo) => void>();
  // eslint-disable-next-line @typescript-eslint/require-await -- fake serves each page at once
  const pageAt = async (index: number): Promise<HistoryPage<unknown>> => {
    const page = fake.pages?.[index];
    if (page === undefined) throw new Ably.ErrorInfo('no page', ErrorCode.SessionHistoryFetchFailed, 500);
    return { ...page, next: async () => pageAt(index + 1) };
  };
  const fake: Partial<FakeTransport> = {
    subscribeCalls: 0,
    closeCalls: 0,
    pages: [],
    historyLimits: [],
    subscribe: (handler) => {
      handlers.add(handler);
      fake.subscribeCalls = (fake.subscribeCalls ?? 0) + 1;
      return () => {
        handlers.delete(handler);
      };
    },
    // CAST: the fake narrows `on` to the two events the transport has.
    on: (event: 'discontinuity' | 'error', handler: (arg: never) => void) => {
      const set = event === 'discontinuity' ? discontinuityHandlers : errorHandlers;
      set.add(handler as never);
      return () => set.delete(handler as never);
    },

    history: async ({ limit }) => {
      fake.historyLimits?.push(limit);
      return pageAt(0);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- fake closes at once
    close: async () => {
      fake.closeCalls = (fake.closeCalls ?? 0) + 1;
    },
    emit: (delivery) => {
      for (const handler of handlers) handler(delivery);
    },
    emitDiscontinuity: () => {
      for (const handler of discontinuityHandlers) handler();
    },
    emitError: (e) => {
      for (const handler of errorHandlers) handler(e);
    },
  };
  Object.defineProperty(fake, 'handlerCount', { get: () => handlers.size });
  // CAST: the provider and hooks call only the members stubbed above.
  return fake as FakeTransport;
};

const createTransportMock = vi.hoisted(() => vi.fn<(options: unknown) => unknown>());

vi.mock('../../src/core/transport/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/transport/index.js')>();
  return { ...original, createTransport: (options: unknown) => createTransportMock(options) };
});

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
 * it so the test can drive it.
 * @returns The registered fake.
 */
const arrangeFake = (): FakeTransport => {
  const fake = createFakeTransport();
  createTransportMock.mockImplementation(() => fake);
  return fake;
};

const delivery = (event: unknown): Delivery<unknown> =>
  // CAST: a minimal inbound message; the hooks store deliveries opaquely.
  ({ event, message: { serial: 's1' } as Ably.InboundMessage });

beforeEach(() => {
  vi.clearAllMocks();
  channelProviderCapture.options = undefined;
  createTransportMock.mockImplementation(() => createFakeTransport());
});

describe('TransportProvider', () => {
  it('resolves the channel by name and creates the transport on it', () => {
    renderHook(() => useTransport(), { wrapper: wrapDefault });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher for the agent-seeded params bag
    const anyParams: Ably.ChannelOptions = expect.objectContaining({ params: expect.anything() });
    expect(channelsGetMock).toHaveBeenCalledWith('ai:test', anyParams);
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    // CAST: the mock records the options bag; only channel is read.
    const options = createTransportMock.mock.calls[0]?.[0] as { channel: { name: string } };
    expect(options.channel.name).toBe('ai:test');
  });

  it('passes the same agent-seeded options to the ChannelProvider', () => {
    renderHook(() => useTransport(), { wrapper: wrapDefault });

    const resolved = channelsGetMock.mock.calls[0]?.[1];
    expect(channelProviderCapture.options).toBe(resolved);
    expect(channelProviderCapture.options?.params?.agent).toContain('ai-transport-js');
  });

  it('requests the resolved mode set when channelModes are supplied', () => {
    renderHook(() => useTransport(), { wrapper: wrapWithModes });

    expect(channelProviderCapture.options?.modes).toEqual(resolveChannelModes(OBJECT_MODES));
  });

  it('pairs every Strict-Mode transport with its own close', async () => {
    // Creation lives in an effect, so Strict Mode's mount/fake-unmount/remount
    // runs setup, cleanup, setup: two transports built and the first closed.
    // Nothing is left attached, which is the property that matters.
    const built: FakeTransport[] = [];
    createTransportMock.mockImplementation(() => {
      const fake = createFakeTransport();
      built.push(fake);
      return fake;
    });

    const view = render(createElement(StrictMode, undefined, provider({})));
    await act(flushMicrotasks);

    expect(built).toHaveLength(2);
    expect(built[0]?.closeCalls).toBe(1);
    expect(built[1]?.closeCalls).toBe(0);

    view.unmount();
    await act(flushMicrotasks);
    expect(built[1]?.closeCalls).toBe(1);
  });

  it('does not rebuild when a re-render passes an equal modes array', () => {
    arrangeFake();
    const { rerender } = render(provider({ channelModes: ['publish', 'subscribe'] }));
    rerender(provider({ channelModes: ['publish', 'subscribe'] }));

    expect(createTransportMock).toHaveBeenCalledTimes(1);
  });

  it('has no transport on the render before its effect runs', () => {
    const fake = arrangeFake();
    const seen: (Transport<unknown> | undefined)[] = [];

    renderHook(
      () => {
        const { transport } = useTransport();
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
    createTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

    const view = render(provider({ channelName: 'ai:one' }));
    expect(createTransportMock).toHaveBeenCalledTimes(1);

    view.rerender(provider({ channelName: 'ai:two' }));
    await act(flushMicrotasks);

    expect(createTransportMock).toHaveBeenCalledTimes(2);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(0);

    view.unmount();
    await act(flushMicrotasks);
  });

  it('wraps a non-ErrorInfo construction throw as invalid argument, carrying its detail', () => {
    createTransportMock.mockImplementation(() => {
      throw new Error('channels.get exploded');
    });

    const { result } = renderHook(() => useTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBeErrorInfo({
      code: ErrorCode.InvalidArgument,
      statusCode: 400,
      message: 'unable to create transport; channels.get exploded',
    });
  });

  it('surfaces a construction throw as the handle error without crashing the tree', () => {
    const error = new Ably.ErrorInfo('unable to create transport; boom', ErrorCode.InvalidArgument, 400);
    createTransportMock.mockImplementation(() => {
      throw error;
    });

    const { result } = renderHook(() => useTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBe(error);
  });

  it('leaves the hooks inert when construction failed', () => {
    createTransportMock.mockImplementation(() => {
      throw new Ably.ErrorInfo('unable to create transport; boom', ErrorCode.InvalidArgument, 400);
    });
    const handler = vi.fn();

    const deliveries = renderHook(
      () => {
        useDeliveries(handler);
      },
      { wrapper: wrapDefault },
    );
    const history = renderHook(() => useHistory({ limit: 10 }), { wrapper: wrapDefault });
    const status = renderHook(() => useTransportStatus(), { wrapper: wrapDefault });

    expect(handler).not.toHaveBeenCalled();
    expect(deliveries.result.current).toBeUndefined();
    expect(history.result.current.items).toEqual([]);
    expect(status.result.current).toEqual({ discontinuity: false, error: undefined });
  });
});

describe('useTransport', () => {
  it('returns the provider transport and no error', () => {
    const fake = arrangeFake();

    const { result } = renderHook(() => useTransport(), { wrapper: wrapDefault });

    expect(result.current.transport).toBe(fake);
    expect(result.current.error).toBeUndefined();
  });

  it('resolves a named provider through nesting', () => {
    const outer = createFakeTransport();
    const inner = createFakeTransport();
    // Keyed on the channel, not on call order: each provider builds its
    // transport in an effect, and React runs a child's effects before its
    // parent's, so the inner provider constructs first.
    createTransportMock.mockImplementation((options: unknown) => {
      // CAST: the mocked factory is typed `(options: unknown) => unknown`; the
      // provider always passes the resolved channel through.
      const { channel } = options as { channel: Ably.RealtimeChannel };
      return channel.name === 'ai:outer' ? outer : inner;
    });

    const { result } = renderHook(
      () => ({
        byName: useTransport({ channelName: 'ai:outer' }),
        nearest: useTransport(),
      }),
      { wrapper: wrapNested },
    );

    expect(result.current.byName.transport).toBe(outer);
    expect(result.current.nearest.transport).toBe(inner);
  });

  it('throws when no provider encloses the caller', () => {
    expect(() => renderHook(() => useTransport())).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
  });
});

describe('useDeliveries', () => {
  it('delivers to the handler and unsubscribes on unmount', () => {
    const fake = arrangeFake();
    const seen: unknown[] = [];

    const { unmount } = renderHook(
      () => {
        useDeliveries((d) => {
          seen.push(d.event);
        });
      },
      { wrapper: wrapDefault },
    );

    act(() => {
      fake.emit(delivery({ type: 'note' }));
    });
    expect(seen).toEqual([{ type: 'note' }]);
    expect(fake.handlerCount).toBe(1);

    unmount();
    expect(fake.handlerCount).toBe(0);
  });

  it('reads the latest handler without resubscribing', () => {
    const fake = arrangeFake();
    const first: unknown[] = [];
    const second: unknown[] = [];
    let target = first;

    const { rerender } = renderHook(
      () => {
        useDeliveries((d) => {
          target.push(d.event);
        });
      },
      { wrapper: wrapDefault },
    );

    target = second;
    rerender();
    act(() => {
      fake.emit(delivery('x'));
    });

    expect(first).toEqual([]);
    expect(second).toEqual(['x']);
    expect(fake.subscribeCalls).toBe(1);
  });
});

describe('useHistory', () => {
  it('reads the first page on mount and prepends older pages on loadMore', async () => {
    const fake = arrangeFake();
    fake.pages.push(
      { items: [delivery('c'), delivery('d')], hasNext: true },
      { items: [delivery('a'), delivery('b')], hasNext: false },
    );

    const { result } = renderHook(() => useHistory({ limit: 2 }), { wrapper: wrapDefault });
    await act(flushMicrotasks);

    expect(result.current.items.map((d) => d.event)).toEqual(['c', 'd']);
    expect(result.current.hasNext).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((d) => d.event)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.hasNext).toBe(false);

    // Past the end, loadMore reads nothing; one walk was opened for all of it.
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((d) => d.event)).toEqual(['a', 'b', 'c', 'd']);
    expect(fake.historyLimits).toEqual([2]);
  });

  it('reports a failed read as its error and keeps the items it has', async () => {
    const fake = arrangeFake();
    fake.pages.push({ items: [delivery('a')], hasNext: true });

    const { result } = renderHook(() => useHistory({ limit: 1 }), { wrapper: wrapDefault });
    await act(flushMicrotasks);
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((d) => d.event)).toEqual(['a']);
    expect(result.current.error).toBeErrorInfoWithCode(ErrorCode.SessionHistoryFetchFailed);
    expect(result.current.loading).toBe(false);
  });

  it('starts over when the provider recreates the transport', async () => {
    const first = createFakeTransport();
    first.pages.push({ items: [delivery('old')], hasNext: false });
    const second = createFakeTransport();
    second.pages.push({ items: [delivery('new')], hasNext: false });
    createTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const channelRef = { value: 'ai:first' };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      provider({ channelName: channelRef.value, children });

    const { result, rerender } = renderHook(() => useHistory({ limit: 5 }), { wrapper });
    await act(flushMicrotasks);
    expect(result.current.items.map((d) => d.event)).toEqual(['old']);

    channelRef.value = 'ai:second';
    rerender();
    await act(flushMicrotasks);
    expect(result.current.items.map((d) => d.event)).toEqual(['new']);
  });

  it('keeps the open walk when limit changes, and pages on from where it was', async () => {
    const fake = arrangeFake();
    fake.pages.push({ items: [delivery('c')], hasNext: true }, { items: [delivery('b')], hasNext: false });
    const limitRef = { value: 2 };

    const { result, rerender } = renderHook(() => useHistory({ limit: limitRef.value }), { wrapper: wrapDefault });
    await act(flushMicrotasks);
    expect(result.current.items.map((d) => d.event)).toEqual(['c']);

    limitRef.value = 50;
    rerender();
    await act(flushMicrotasks);

    // The page already read stays, and no second walk was opened for it.
    expect(result.current.items.map((d) => d.event)).toEqual(['c']);
    expect(fake.historyLimits).toEqual([2]);

    // The next page comes from the open walk's own cursor, so the older page
    // lands once and the new limit reaches nothing.
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((d) => d.event)).toEqual(['b', 'c']);
    expect(fake.historyLimits).toEqual([2]);
  });

  it('opens the next walk with the latest limit', async () => {
    const first = createFakeTransport();
    first.pages.push({ items: [delivery('old')], hasNext: false });
    const second = createFakeTransport();
    second.pages.push({ items: [delivery('new')], hasNext: false });
    createTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const channelRef = { value: 'ai:first' };
    const limitRef = { value: 2 };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      provider({ channelName: channelRef.value, children });

    const { rerender } = renderHook(() => useHistory({ limit: limitRef.value }), { wrapper });
    await act(flushMicrotasks);
    expect(first.historyLimits).toEqual([2]);

    limitRef.value = 50;
    channelRef.value = 'ai:second';
    rerender();
    await act(flushMicrotasks);
    expect(second.historyLimits).toEqual([50]);
  });
});

describe('useTransportStatus', () => {
  it('reports a discontinuity and the latest error, holding no subscription of its own', () => {
    const fake = arrangeFake();

    const { result } = renderHook(() => useTransportStatus(), { wrapper: wrapDefault });
    expect(result.current).toEqual({ discontinuity: false, error: undefined });
    // No handler on the channel: reading status subscribes nothing.
    expect(fake.handlerCount).toBe(0);

    const error = new Ably.ErrorInfo('decode failed', ErrorCode.SessionMessageProcessingFailed, 500);
    act(() => {
      fake.emitDiscontinuity();
      fake.emitError(error);
    });
    expect(result.current).toEqual({ discontinuity: true, error });
  });

  it('starts over when the provider recreates the transport', async () => {
    const first = createFakeTransport();
    const second = createFakeTransport();
    createTransportMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const channelRef = { value: 'ai:first' };
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      provider({ channelName: channelRef.value, children });

    const { result, rerender } = renderHook(() => useTransportStatus(), { wrapper });
    act(() => {
      first.emitDiscontinuity();
    });
    expect(result.current.discontinuity).toBe(true);

    channelRef.value = 'ai:second';
    rerender();
    await act(flushMicrotasks);
    expect(result.current.discontinuity).toBe(false);
  });

  it('releases its listeners on unmount', () => {
    const fake = arrangeFake();

    const { result, unmount } = renderHook(() => useTransportStatus(), { wrapper: wrapDefault });
    unmount();
    act(() => {
      fake.emitDiscontinuity();
    });
    expect(result.current.discontinuity).toBe(false);
  });
});
