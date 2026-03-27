// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/client/types.js';
import { useMessageSync } from '../../../src/vercel/react/use-message-sync.js';

type Handler = () => void;

interface MockTransport {
  transport: ClientTransport<unknown, AI.UIMessage>;
  emit: (event: string) => void;
  getMessages: ReturnType<typeof vi.fn>;
}

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

const createMockTransport = (): MockTransport => {
  const handlers = new Map<string, Set<Handler>>();

  const on = vi.fn((event: string, handler: Handler) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });

  const getMessages = vi.fn((): AI.UIMessage[] => []);

  const transport = {
    on,
    getMessages,
  // CAST: mock object satisfies the subset of ClientTransport methods used by useMessageSync
  } as unknown as ClientTransport<unknown, AI.UIMessage>;

  const emit = (event: string): void => {
    const set = handlers.get(event);
    if (set) {
      for (const handler of set) {
        handler();
      }
    }
  };

  return { transport, emit, getMessages };
};

describe('useMessageSync', () => {
  it('calls setMessages when transport emits message event', () => {
    const mock = createMockTransport();
    const msgs = [makeMessage('1')];
    mock.getMessages.mockReturnValue(msgs);

    const setMessages = vi.fn();
    renderHook(() => { useMessageSync(mock.transport, setMessages); });

    act(() => {
      mock.emit('message');
    });

    expect(setMessages).toHaveBeenCalled();
    // setMessages is called with an updater function
    const updater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    expect(updater([])).toEqual(msgs);
  });

  it('does not subscribe when transport is undefined', () => {
    const setMessages = vi.fn();
    renderHook(() => { useMessageSync(undefined, setMessages); });
    // No crash, no subscription
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport();
    const setMessages = vi.fn();
    const { unmount } = renderHook(() => { useMessageSync(mock.transport, setMessages); });

    unmount();

    // Emitting after unmount should not call setMessages
    act(() => {
      mock.emit('message');
    });
    expect(setMessages).not.toHaveBeenCalled();
  });
});
