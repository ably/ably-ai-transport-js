// @vitest-environment jsdom

import { act,renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useMessages } from '../../src/react/use-messages.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useMessages', () => {
  it('returns initial messages from the transport', () => {
    const { transport, getMessages } = createMockTransport(['hello', 'world']);
    getMessages.mockReturnValue(['hello', 'world']);

    const { result } = renderHook(() => useMessages(transport));

    expect(result.current).toEqual(['hello', 'world']);
  });

  it('updates when the transport emits a message event', () => {
    const mock = createMockTransport([]);
    const { result } = renderHook(() => useMessages(mock.transport));
    expect(result.current).toEqual([]);

    // Simulate new message arriving
    mock.getMessages.mockReturnValue(['new-message']);
    act(() => {
      mock.emit('message');
    });

    expect(result.current).toEqual(['new-message']);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport([]);
    const { unmount } = renderHook(() => useMessages(mock.transport));

    unmount();

    // After unmount, emitting should not throw
    mock.getMessages.mockReturnValue(['after-unmount']);
    act(() => {
      mock.emit('message');
    });
  });

  it('resubscribes when transport changes', () => {
    const mock1 = createMockTransport(['from-1']);
    mock1.getMessages.mockReturnValue(['from-1']);

    const mock2 = createMockTransport(['from-2']);
    mock2.getMessages.mockReturnValue(['from-2']);

    const { result, rerender } = renderHook(
      ({ transport }) => useMessages(transport),
      { initialProps: { transport: mock1.transport } },
    );

    expect(result.current).toEqual(['from-1']);

    rerender({ transport: mock2.transport });
    expect(result.current).toEqual(['from-2']);
  });
});
