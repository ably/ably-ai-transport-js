// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { useMessageSync } from '../../../src/vercel/react/use-message-sync.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';

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

const makeNode = (m: AI.UIMessage) => ({
  message: m,
  msgId: m.id,
  parentId: undefined,
  forkOf: undefined,
  headers: {},
  serial: undefined,
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

/**
 * Create a mock ChatTransport with controllable streaming state.
 * @returns Mock chat transport and a function to toggle the streaming flag.
 */
const createMockChatTransport = (): {
  chatTransport: ChatTransport;
  setStreaming: (value: boolean) => void;
} => {
  const callbacks = new Set<(streaming: boolean) => void>();
  let streaming = false;

  const setStreaming = (value: boolean): void => {
    streaming = value;
    for (const cb of callbacks) cb(value);
  };

  const chatTransport = {
    sendMessages: vi.fn(),
    // eslint-disable-next-line unicorn/no-null -- required by AI SDK ChatTransport contract
    reconnectToStream: vi.fn().mockResolvedValue(null),
    close: vi.fn(),
    get streaming() {
      return streaming;
    },
    onStreamingChange: (cb: (s: boolean) => void) => {
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
      };
    },
  } as unknown as ChatTransport;

  return { chatTransport, setStreaming };
};

describe('useMessageSync', () => {
  it('syncs immediately on mount and on view update events', () => {
    const mock = createMockTransport();
    const msgs = [makeMessage('1')];
    mock.viewFlattenNodes.mockReturnValue(
      msgs.map((m) => ({
        message: m,
        msgId: m.id,
        parentId: undefined,
        forkOf: undefined,
        headers: {},
        serial: undefined,
      })),
    );

    const setMessages = vi.fn();
    renderHook(() => {
      useMessageSync(mock.transport, setMessages);
    });

    // Called once on mount (immediate sync)
    expect(setMessages).toHaveBeenCalledTimes(1);
    const updater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    expect(updater([])).toEqual(msgs);

    // Called again on view update
    act(() => {
      mock.emitView('update');
    });

    expect(setMessages).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe when transport is undefined', () => {
    const setMessages = vi.fn();
    renderHook(() => {
      useMessageSync(undefined, setMessages);
    });
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport();
    const setMessages = vi.fn();
    const { unmount } = renderHook(() => {
      useMessageSync(mock.transport, setMessages);
    });

    setMessages.mockClear();
    unmount();

    // Emitting after unmount should not call setMessages
    act(() => {
      mock.emitView('update');
    });
    expect(setMessages).not.toHaveBeenCalled();
  });

  describe('streaming gate', () => {
    it('suppresses setMessages while chatTransport is streaming', () => {
      const mock = createMockTransport();
      const { chatTransport, setStreaming } = createMockChatTransport();
      const msgs = [makeMessage('1')];
      mock.viewFlattenNodes.mockReturnValue(
        msgs.map((m) => ({
          message: m,
          msgId: m.id,
          parentId: undefined,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        })),
      );

      const setMessages = vi.fn();
      renderHook(() => {
        useMessageSync(mock.transport, setMessages, chatTransport);
      });

      // Initial sync fires on mount (not yet streaming)
      expect(setMessages).toHaveBeenCalledTimes(1);
      setMessages.mockClear();

      // Start streaming — gate closes
      act(() => {
        setStreaming(true);
      });

      // View updates should be suppressed
      act(() => {
        mock.emitView('update');
      });
      expect(setMessages).not.toHaveBeenCalled();
    });

    it('syncs immediately when streaming ends', () => {
      const mock = createMockTransport();
      const { chatTransport, setStreaming } = createMockChatTransport();
      const msgs = [makeMessage('1'), makeMessage('2', 'assistant')];
      mock.viewFlattenNodes.mockReturnValue(
        msgs.map((m) => ({
          message: m,
          msgId: m.id,
          parentId: undefined,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        })),
      );

      const setMessages = vi.fn();
      renderHook(() => {
        useMessageSync(mock.transport, setMessages, chatTransport);
      });
      setMessages.mockClear();

      // Gate: streaming on then off
      act(() => {
        setStreaming(true);
      });
      act(() => {
        setStreaming(false);
      });

      // Immediate sync on gate open
      expect(setMessages).toHaveBeenCalledTimes(1);
      const updater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(updater([])).toEqual(msgs);
    });

    it('works without chatTransport (no gating)', () => {
      const mock = createMockTransport();
      const setMessages = vi.fn();
      renderHook(() => {
        useMessageSync(mock.transport, setMessages);
      });

      // Initial sync + view update both work
      act(() => {
        mock.emitView('update');
      });
      expect(setMessages).toHaveBeenCalledTimes(2);
    });

    it('observer messages arriving during streaming appear after gate opens', () => {
      const mock = createMockTransport();
      const { chatTransport, setStreaming } = createMockChatTransport();

      // Start with one user message
      const userMsg = makeMessage('1');
      mock.viewFlattenNodes.mockReturnValue([
        { message: userMsg, msgId: '1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
      ]);

      const setMessages = vi.fn();
      renderHook(() => {
        useMessageSync(mock.transport, setMessages, chatTransport);
      });

      // Initial sync: just the user message
      expect(setMessages).toHaveBeenCalledTimes(1);
      const initialUpdater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(initialUpdater([])).toEqual([userMsg]);
      setMessages.mockClear();

      // Own-turn stream starts — gate closes
      act(() => {
        setStreaming(true);
      });

      // Observer message arrives while gated (another user's assistant response).
      // The transport tree has it, but setMessages should NOT fire.
      const observerMsg = makeMessage('observer-1', 'assistant');
      mock.viewFlattenNodes.mockReturnValue([
        { message: userMsg, msgId: '1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        { message: observerMsg, msgId: 'observer-1', parentId: '1', forkOf: undefined, headers: {}, serial: undefined },
      ]);
      act(() => {
        mock.emitView('update');
      });
      expect(setMessages).not.toHaveBeenCalled();

      // Own-turn stream ends — gate opens, immediate sync picks up observer message
      act(() => {
        setStreaming(false);
      });
      expect(setMessages).toHaveBeenCalledTimes(1);
      const gateOpenUpdater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(gateOpenUpdater([])).toEqual([userMsg, observerMsg]);
    });
  });

  // ---------------------------------------------------------------------------
  // Reference stability during streaming
  // ---------------------------------------------------------------------------

  it('preserves unchanged message references across streaming updates', () => {
    const mock = createMockTransport();
    const msg1 = makeMessage('1');
    const msg2 = makeMessage('2', 'assistant');

    mock.viewFlattenNodes.mockReturnValue([makeNode(msg1), makeNode(msg2)]);

    const setMessages = vi.fn();
    renderHook(() => {
      useMessageSync(mock.transport, setMessages);
    });

    // First update - populates messages
    act(() => {
      mock.emitView('update');
    });

    // msg2 gets updated content (new reference), msg1 stays same
    const msg2Updated = makeMessage('2', 'assistant');
    msg2Updated.parts = [{ type: 'text', text: 'Hello' }];
    mock.viewFlattenNodes.mockReturnValue([makeNode(msg1), makeNode(msg2Updated)]);

    // Second update - streaming token
    act(() => {
      mock.emitView('update');
    });

    // Extract the messages produced by the second update's updater
    // CAST: setMessages receives an updater function from useMessageSync
    const updater = setMessages.mock.calls[1]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    const result = updater([]);

    // msg1 should be the exact same reference (not cloned)
    expect(result[0]).toBe(msg1);
    // msg2 should be the new reference
    expect(result[1]).toBe(msg2Updated);
  });
});
