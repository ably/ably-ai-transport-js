// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useAblyMessages } from '../../src/react/use-ably-messages.js';
import { createMockSession } from './helper/mock-session.js';

describe('useAblyMessages', () => {
  it('returns empty array initially', () => {
    const mock = createMockSession();
    const { result } = renderHook(() => useAblyMessages({ session: mock.session }));
    expect(result.current).toEqual([]);
  });

  it('accumulates messages from tree ably-message event', () => {
    const mock = createMockSession();
    const { result } = renderHook(() => useAblyMessages({ session: mock.session }));
    expect(result.current).toEqual([]);

    const fakeAblyMsg = { name: 'test', data: 'payload' };
    act(() => {
      mock.emitTree('ably-message', fakeAblyMsg);
    });

    expect(result.current).toEqual([fakeAblyMsg]);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockSession();
    const { unmount } = renderHook(() => useAblyMessages({ session: mock.session }));
    unmount();

    // Should not throw after unmount
    act(() => {
      mock.emitTree('ably-message', { name: 'test' });
    });
  });

  it('returns empty array when no session and no nearest context', () => {
    const { result } = renderHook(() => useAblyMessages());
    expect(result.current).toEqual([]);
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        ClientSessionContext.Provider,
        {
          value: {
            nearest: { session: mock.session },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useAblyMessages(), { wrapper });

    const fakeAblyMsg = { name: 'test', data: 'payload' };
    act(() => {
      mock.emitTree('ably-message', fakeAblyMsg);
    });

    expect(result.current).toEqual([fakeAblyMsg]);
  });
});
