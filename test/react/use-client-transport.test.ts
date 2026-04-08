// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createClientTransport } from '../../src/core/transport/client/client-transport.js';
import { useClientTransport } from '../../src/react/use-client-transport.js';

// Mock the factory to avoid needing a real Ably channel
vi.mock('../../src/core/transport/client/client-transport.js', () => ({
  createClientTransport: vi.fn(() => ({
    send: vi.fn(),
    getMessages: vi.fn(() => []),
    on: vi.fn(() => vi.fn()),
    close: vi.fn(),
  })),
}));

describe('useClientTransport', () => {
  it('returns the same transport instance across re-renders', () => {
    const options = { channel: {} as never, codec: {} as never };
    const { result, rerender } = renderHook(() => useClientTransport(options));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(createClientTransport).toHaveBeenCalledTimes(1);
  });
});
