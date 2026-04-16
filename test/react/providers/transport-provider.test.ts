// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Flush microtasks (but NOT macrotasks) so deferred promises resolve. */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { TransportProvider } from '../../../src/react/contexts/transport-provider.js';
import { useClientTransport } from '../../../src/react/use-client-transport.js';
import { createMockTransport } from '../helper/mock-transport.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('ably/react', () => ({
  // ChannelProvider is a pass-through wrapper in tests; explicit return type avoids promise-function-async
  ChannelProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useChannel: ({ channelName }: { channelName: string }) => ({ channel: { name: channelName } }),
}));

// Typed with explicit parameter signature so mock.calls[0] is [unknown], enabling assertions
const createClientTransportMock = vi.fn<(options: unknown) => ClientTransport<unknown, unknown>>();

vi.mock('../../../src/core/transport/client-transport.js', () => ({
  createClientTransport: (options: unknown) => createClientTransportMock(options),
}));

// ---------------------------------------------------------------------------
// Wrapper helpers — defined at module scope to satisfy unicorn/consistent-function-scoping.
// Use // comments (not JSDoc) so jsdoc/require-param does not fire.
// ---------------------------------------------------------------------------

// TransportProvider on channelName "ai:test".
const wrapDefault = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(TransportProvider<unknown, unknown>, { channelName: 'ai:test', codec: {} as never }, children);

// TransportProvider with channelName "ai:demo" for channel-name forwarding test.
const wrapDemo = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(TransportProvider<unknown, unknown>, { channelName: 'ai:demo', codec: {} as never }, children);

// Nested outer (channelName="ai:outer") + inner (channelName="ai:inner") TransportProvider pair.
const wrapNested = ({ children }: { children: ReactNode }): ReactNode =>
  createElement(
    TransportProvider<unknown, unknown>,
    { channelName: 'ai:outer', codec: {} as never },
    createElement(TransportProvider<unknown, unknown>, { channelName: 'ai:inner', codec: {} as never }, children),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransportProvider', () => {
  beforeEach(() => {
    createClientTransportMock.mockClear();
    createClientTransportMock.mockImplementation(() => createMockTransport().transport);
  });

  it('creates a transport and makes it available via useClientTransport(channelName)', () => {
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    expect(result.current).toBeDefined();
    expect(createClientTransportMock).toHaveBeenCalledTimes(1);
  });

  it('passes channelName to createClientTransport via useChannel', () => {
    renderHook(() => useClientTransport({ channelName: 'ai:demo' }), { wrapper: wrapDemo });

    // CAST: wire-boundary assertion — vitest types mock args as unknown
    const callArgs = createClientTransportMock.mock.calls[0]?.[0] as { channel: { name: string } };
    expect(callArgs.channel.name).toBe('ai:demo');
  });

  it('registers the transport under channelName', () => {
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    expect(result.current).toBeDefined();
  });

  it('throws when no TransportProvider is in the tree', () => {
    const { result } = renderHook(() => {
      try {
        useClientTransport({ channelName: 'ai:test' });
        // Return value is irrelevant — the throw above is what matters
      } catch (error) {
        return error;
      }
    });
    expect(result.current).toMatchObject({ code: 40000 });
  });

  it('creates the transport exactly once across re-renders', () => {
    const { rerender } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    act(() => {
      rerender();
    });
    act(() => {
      rerender();
    });

    expect(createClientTransportMock).toHaveBeenCalledTimes(1);
  });

  it('stacks two nested providers so both transports are accessible', () => {
    const { result: outerResult } = renderHook(() => useClientTransport({ channelName: 'ai:outer' }), {
      wrapper: wrapNested,
    });
    const { result: innerResult } = renderHook(() => useClientTransport({ channelName: 'ai:inner' }), {
      wrapper: wrapNested,
    });

    expect(outerResult.current).toBeDefined();
    expect(innerResult.current).toBeDefined();
    expect(outerResult.current).not.toBe(innerResult.current);
  });

  it('closes the transport when the provider unmounts', async () => {
    const created: ReturnType<typeof createMockTransport>[] = [];
    createClientTransportMock.mockImplementation(() => {
      const mock = createMockTransport();
      created.push(mock);
      return mock.transport;
    });

    const { unmount } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper: wrapDefault });
    unmount();
    await flushMicrotasks();

    expect(created[0]?.close).toHaveBeenCalledOnce();
  });

  it('forwards transport options to createClientTransport', () => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(),
    };

    // wrapper closes over `logger` — unicorn/consistent-function-scoping does not fire for closures
    const wrapWithLogger = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportProvider<unknown, unknown>,
        { channelName: 'ai:test', codec: {} as never, api: '/api/custom', logger },
        children,
      );

    renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper: wrapWithLogger });

    // CAST: accessing vitest mock call args as the known options type
    const callArgs = createClientTransportMock.mock.calls[0]?.[0] as { api: string; logger: unknown };
    expect(callArgs.api).toBe('/api/custom');
    expect(callArgs.logger).toBe(logger);
  });
});
