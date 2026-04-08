// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
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
    view: {},
    tree: {},
    on: vi.fn(() => vi.fn()),
    close: vi.fn(),
    createView: vi.fn(),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op stub
const noop = (): void => {};

/**
 * Build a minimal mock typed as ClientTransport. The type annotation ensures
 * the mock stays in sync with the real interface — if a property the type
 * guard relies on is renamed or removed, this will fail to compile.
 * @returns A mock ClientTransport instance.
 */
const createFakeTransport = (): ClientTransport<AI.UIMessageChunk, AI.UIMessage> => ({
  tree: {
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map()),
    on: vi.fn(() => noop),
  },
  view: {
    getMessages: vi.fn(() => []),
    flattenNodes: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    loadOlder: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    getSelectedIndex: vi.fn(() => 0),
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    send: vi.fn(() => Promise.resolve({ stream: new ReadableStream(), turnId: 't', cancel: vi.fn(), optimisticMsgIds: [] })),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    regenerate: vi.fn(() => Promise.resolve({ stream: new ReadableStream(), turnId: 't', cancel: vi.fn(), optimisticMsgIds: [] })),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    edit: vi.fn(() => Promise.resolve({ stream: new ReadableStream(), turnId: 't', cancel: vi.fn(), optimisticMsgIds: [] })),
    getActiveTurnIds: vi.fn(() => new Map()),
    on: vi.fn(() => noop),
    close: vi.fn(),
  },
  createView: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  cancel: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  waitForTurn: vi.fn(() => Promise.resolve()),
  on: vi.fn(() => noop),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  close: vi.fn(() => Promise.resolve()),
});

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
    const fakeTransport = createFakeTransport();
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
