// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatTransport } from '../../../src/vercel/react/use-chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createClientTransport } from '../../../src/vercel/transport/index.js';

// Mock the Vercel transport factories
vi.mock('../../../src/vercel/transport/chat-transport.js', () => ({
  createChatTransport: vi.fn(() => ({
    sendMessages: vi.fn(),
    reconnectToStream: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../../../src/vercel/transport/index.js', () => ({
  createClientTransport: vi.fn(() => ({
    send: vi.fn(),
    getMessages: vi.fn(() => []),
    on: vi.fn(() => vi.fn()),
    close: vi.fn(),
    getTree: vi.fn(),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useChatTransport', () => {
  it('returns the same chat transport instance across re-renders', () => {
    const options = { channel: {} as never };
    const { result, rerender } = renderHook(() => useChatTransport(options));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(createChatTransport).toHaveBeenCalledTimes(1);
  });

  it('wraps an existing transport when passed one', () => {
    const fakeTransport = { send: vi.fn() } as never;
    renderHook(() => useChatTransport(fakeTransport));

    expect(createChatTransport).toHaveBeenCalledWith(fakeTransport, undefined);
    // Should NOT create a new core transport
    expect(createClientTransport).not.toHaveBeenCalled();
  });

  it('creates a core transport when passed options', () => {
    const options = { channel: {} as never };
    renderHook(() => useChatTransport(options));

    expect(createClientTransport).toHaveBeenCalledWith(options);
  });
});
