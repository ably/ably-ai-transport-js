// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { useMessageSync } from '../../../src/vercel/react/use-message-sync.js';

type Handler = () => void;

interface MockTransport {
  transport: ClientTransport<unknown, AI.UIMessage>;
  emitView: (event: string) => void;
  viewFlattenNodes: ReturnType<typeof vi.fn>;
}

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

const createMockTransport = (): MockTransport => {
  const viewHandlers = new Map<string, Set<Handler>>();

  const viewOn = vi.fn((event: string, handler: Handler) => {
    let set = viewHandlers.get(event);
    if (!set) {
      set = new Set();
      viewHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });

  const viewFlattenNodes = vi.fn(() => [] as { message: AI.UIMessage }[]);

  const view = {
    on: viewOn,
    flattenNodes: viewFlattenNodes,
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    getActiveTurnIds: vi.fn(() => new Map()),
  };

  const transport = {
    view,
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    tree: {},
    send: vi.fn(),
    regenerate: vi.fn(),
    edit: vi.fn(),
    cancel: vi.fn(),
    waitForTurn: vi.fn(),
    close: vi.fn(),
  // CAST: mock object satisfies the subset of ClientTransport methods used by useMessageSync
  } as unknown as ClientTransport<unknown, AI.UIMessage>;

  const emitView = (event: string): void => {
    const set = viewHandlers.get(event);
    if (set) {
      for (const handler of set) {
        handler();
      }
    }
  };

  return { transport, emitView, viewFlattenNodes };
};

describe('useMessageSync', () => {
  it('calls setMessages when transport emits view update event', () => {
    const mock = createMockTransport();
    const msgs = [makeMessage('1')];
    mock.viewFlattenNodes.mockReturnValue(msgs.map((m) => ({ message: m, msgId: m.id, parentId: undefined, forkOf: undefined, headers: {}, serial: undefined })));

    const setMessages = vi.fn();
    renderHook(() => { useMessageSync(mock.transport, setMessages); });

    act(() => {
      mock.emitView('update');
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
      mock.emitView('update');
    });
    expect(setMessages).not.toHaveBeenCalled();
  });
});
