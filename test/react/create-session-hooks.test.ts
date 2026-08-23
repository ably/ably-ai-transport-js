// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodecInputEvent, CodecOutputEvent } from '../../src/core/transport/session-codec.js';
import type { ClientSession } from '../../src/core/transport/types.js';
import { createSessionHooks } from '../../src/react/create-session-hooks.js';
import { createMockSession } from './helper/mock-session.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stand-in Realtime client returned by the mocked `useAbly()`. Only its
// shape needs to satisfy TypeScript; createClientSession is also mocked.
// ClientSessionProvider wraps children in ably-js's <ChannelProvider>; stub it
// as a passthrough since no <AblyProvider> is rendered here.
vi.mock('ably/react', async () => {
  const { createElement, Fragment } = await import('react');
  return {
    useAbly: () => ({ options: {} }),
    ChannelProvider: ({ children }: { children?: ReactNode }) => createElement(Fragment, undefined, children),
  };
});

// Typed with explicit parameter signature so mock.calls[0] is [unknown], enabling assertions
const createClientSessionMock =
  vi.fn<(options: unknown) => ClientSession<CodecInputEvent, CodecOutputEvent, unknown, unknown>>();

vi.mock('../../src/core/transport/client-session.js', () => ({
  createClientSession: (options: unknown) => createClientSessionMock(options),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSessionHooks', () => {
  beforeEach(() => {
    createClientSessionMock.mockClear();
    createClientSessionMock.mockImplementation(() => createMockSession().session);
  });

  it('takes no arguments', () => {
    expect(() => createSessionHooks()).not.toThrow();
  });

  it('useClientSession returns the session when wrapped in ClientSessionProvider', () => {
    const { ClientSessionProvider, useClientSession } = createSessionHooks<
      CodecInputEvent,
      CodecOutputEvent,
      unknown,
      unknown
    >();

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(ClientSessionProvider, { channelName: 'ai:test', codec: {} as never }, children);

    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), { wrapper });
    expect(result.current).toBeDefined();
  });

  it('useClientSession sets sessionError when no ClientSessionProvider is in the tree', () => {
    const { useClientSession } = createSessionHooks<CodecInputEvent, CodecOutputEvent, unknown, unknown>();

    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }));
    expect(result.current.sessionError).toMatchObject({ code: 40000 });
  });
});
