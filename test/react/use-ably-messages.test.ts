// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { TransportContext } from '../../src/react/contexts/transport-context.js';
import { useAblyMessages } from '../../src/react/use-ably-messages.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useAblyMessages', () => {
  it('returns empty array initially', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useAblyMessages({ transport: mock.transport }));
    expect(result.current).toEqual([]);
  });

  it('accumulates messages from tree ably-message event', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useAblyMessages({ transport: mock.transport }));
    expect(result.current).toEqual([]);

    const fakeAblyMsg = { name: 'test', data: 'payload' };
    act(() => {
      mock.emitTree('ably-message', fakeAblyMsg);
    });

    expect(result.current).toEqual([fakeAblyMsg]);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport();
    const { unmount } = renderHook(() => useAblyMessages({ transport: mock.transport }));
    unmount();

    // Should not throw after unmount
    act(() => {
      mock.emitTree('ably-message', { name: 'test' });
    });
  });

  it('returns empty array when no transport and no nearest context', () => {
    const { result } = renderHook(() => useAblyMessages());
    expect(result.current).toEqual([]);
  });

  it('uses nearest transport from context when transport is omitted', () => {
    const mock = createMockTransport();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportContext.Provider,
        {
          value: {
            nearest: { transport: mock.transport as ClientTransport<unknown, unknown>, error: undefined },
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
