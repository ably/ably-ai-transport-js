// @vitest-environment jsdom

import { act,renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAblyMessages } from '../../src/react/use-ably-messages.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useAblyMessages', () => {
  it('returns initial ably messages from the transport', () => {
    const mock = createMockTransport();
    const fakeAblyMsg = { name: 'test', data: 'payload' };
    mock.getAblyMessages.mockReturnValue([fakeAblyMsg]);

    const { result } = renderHook(() => useAblyMessages(mock.transport));

    expect(result.current).toEqual([fakeAblyMsg]);
  });

  it('updates when the transport emits an ably-message event', () => {
    const mock = createMockTransport();
    mock.getAblyMessages.mockReturnValue([]);

    const { result } = renderHook(() => useAblyMessages(mock.transport));
    expect(result.current).toEqual([]);

    const fakeAblyMsg = { name: 'test', data: 'payload' };
    mock.getAblyMessages.mockReturnValue([fakeAblyMsg]);
    act(() => {
      mock.emit('ably-message');
    });

    expect(result.current).toEqual([fakeAblyMsg]);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport();
    mock.getAblyMessages.mockReturnValue([]);

    const { unmount } = renderHook(() => useAblyMessages(mock.transport));
    unmount();

    // Should not throw after unmount
    mock.getAblyMessages.mockReturnValue([{ name: 'test' }]);
    act(() => {
      mock.emit('ably-message');
    });
  });
});
