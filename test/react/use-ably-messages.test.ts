// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAblyMessages } from '../../src/react/use-ably-messages.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useAblyMessages', () => {
  it('returns empty array initially', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useAblyMessages(mock.transport));
    expect(result.current).toEqual([]);
  });

  it('accumulates messages from tree ably-message event', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useAblyMessages(mock.transport));
    expect(result.current).toEqual([]);

    const fakeAblyMsg = { name: 'test', data: 'payload' };
    act(() => {
      mock.emitTree('ably-message', fakeAblyMsg);
    });

    expect(result.current).toEqual([fakeAblyMsg]);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport();
    const { unmount } = renderHook(() => useAblyMessages(mock.transport));
    unmount();

    // Should not throw after unmount
    act(() => {
      mock.emitTree('ably-message', { name: 'test' });
    });
  });
});
