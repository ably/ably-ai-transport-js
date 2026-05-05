// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../src/core/transport/types.js';
import { createSessionHooks } from '../../src/react/create-session-hooks.js';
import { createMockTransport } from './helper/mock-session.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('ably/react', () => ({
  // ChannelProvider is a pass-through wrapper in tests; explicit return type avoids promise-function-async
  ChannelProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  useChannel: ({ channelName }: { channelName: string }) => ({ channel: { name: channelName } }),
}));

// Typed with explicit parameter signature so mock.calls[0] is [unknown], enabling assertions
const createClientSessionMock = vi.fn<(options: unknown) => ClientSession<unknown, unknown>>();

vi.mock('../../src/core/transport/client-session.js', () => ({
  createClientSession: (options: unknown) => createClientSessionMock(options),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSessionHooks', () => {
  beforeEach(() => {
    createClientSessionMock.mockClear();
    createClientSessionMock.mockImplementation(() => createMockTransport().session);
  });

  it('takes no arguments', () => {
    expect(() => createSessionHooks()).not.toThrow();
  });

  it('useClientSession returns the transport when wrapped in ClientSessionProvider', () => {
    const { ClientSessionProvider, useClientSession } = createSessionHooks<unknown, unknown>();

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(ClientSessionProvider, { channelName: 'ai:test', codec: {} as never, api: '/test' }, children);

    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper });
    expect(result.current).toBeDefined();
  });

  it('useClientSession sets sessionError when no ClientSessionProvider is in the tree', () => {
    const { useClientSession } = createSessionHooks<unknown, unknown>();

    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }));
    expect(result.current.sessionError).toMatchObject({ code: 40000 });
  });
});
