// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { createTransportHooks } from '../../src/react/create-transport-hooks.js';
import { createMockTransport } from './helper/mock-transport.js';

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

vi.mock('../../src/core/transport/client-transport.js', () => ({
  createClientTransport: (options: unknown) => createClientTransportMock(options),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTransportHooks', () => {
  beforeEach(() => {
    createClientTransportMock.mockClear();
    createClientTransportMock.mockImplementation(() => createMockTransport().transport);
  });

  it('takes no arguments', () => {
    expect(() => createTransportHooks()).not.toThrow();
  });

  it('useClientTransport returns the transport when wrapped in TransportProvider', () => {
    const { TransportProvider, useClientTransport } = createTransportHooks<unknown, unknown>();

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(TransportProvider, { channelName: 'ai:test', codec: {} as never, api: '/test' }, children);

    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), { wrapper });
    expect(result.current).toBeDefined();
  });

  it('useClientTransport sets transportError when no TransportProvider is in the tree', () => {
    const { useClientTransport } = createTransportHooks<unknown, unknown>();

    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }));
    expect(result.current.transportError).toMatchObject({ code: 40000 });
  });
});
