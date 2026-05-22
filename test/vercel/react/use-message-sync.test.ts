// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../../src/core/transport/types.js';
import type { VercelEvent, VercelProjection } from '../../../src/vercel/codec/index.js';
import type { ChatTransportSlot } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { ChatTransportContext } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { useMessageSync } from '../../../src/vercel/react/use-message-sync.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';

type Handler = () => void;

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

const makeNode = (m: AI.UIMessage) => ({
  message: m,
  codecMessageId: m.id,
  parentId: undefined,
  forkOf: undefined,
  headers: {},
  serial: undefined,
});

interface MockSlot {
  slot: ChatTransportSlot;
  emitView: (event: string) => void;
  viewFlattenNodes: ReturnType<typeof vi.fn>;
  setStreaming: (value: boolean) => void;
}

const createMockSlot = (): MockSlot => {
  // --- View ---
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

  // `flattenNodes` and `getMessages` are mocked together: tests stage
  // `{ message }` entries via `viewFlattenNodes.mockReturnValue(...)` and
  // `getMessages` projects them to the flat `UIMessage[]` the production
  // code reads.
  const viewFlattenNodes = vi.fn(() => [] as { message: AI.UIMessage }[]);
  const viewGetMessages = vi.fn(() => viewFlattenNodes().map((n) => n.message));

  const view = {
    on: viewOn,
    flattenNodes: viewFlattenNodes,
    getMessages: viewGetMessages,
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    getActiveRunIds: vi.fn(() => new Map()),
  } as unknown as ClientSession<VercelEvent, VercelProjection, AI.UIMessage>['view'];

  const session = {
    view,
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    tree: {},
    send: vi.fn(),
    regenerate: vi.fn(),
    edit: vi.fn(),
    cancel: vi.fn(),
    waitForRun: vi.fn(),
    close: vi.fn(),
    // CAST: mock object satisfies the subset of ClientSession methods used by useMessageSync
  } as unknown as ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;

  // --- ChatTransport ---
  const streamingCallbacks = new Set<(s: boolean) => void>();
  let streaming = false;

  const setStreaming = (value: boolean): void => {
    streaming = value;
    for (const cb of streamingCallbacks) cb(value);
  };

  const chatTransport = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    sendMessages: vi.fn(() => Promise.resolve(new ReadableStream())),
    // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-null -- mock; null required by ChatTransport contract
    reconnectToStream: vi.fn(() => Promise.resolve(null)),
    close: vi.fn(),
    get streaming() {
      return streaming;
    },
    onStreamingChange: (cb: (s: boolean) => void) => {
      streamingCallbacks.add(cb);
      return () => {
        streamingCallbacks.delete(cb);
      };
    },
  } as unknown as ChatTransport;

  const emitView = (event: string): void => {
    const set = viewHandlers.get(event);
    if (set) {
      for (const handler of set) {
        handler();
      }
    }
  };

  const slot: ChatTransportSlot = { session, chatTransport };

  return { slot, emitView, viewFlattenNodes, setStreaming };
};

// Wrap renderHook with a ChatTransportContext providing the given nearest slot and registry.
const withContext =
  (nearest?: ChatTransportSlot, providers: Record<string, ChatTransportSlot> = {}) =>
  ({ children }: { children: ReactNode }) =>
    createElement(ChatTransportContext.Provider, { value: { nearest, providers } }, children);

describe('useMessageSync', () => {
  it('syncs immediately on mount and on view update events', () => {
    const { slot, emitView, viewFlattenNodes } = createMockSlot();
    const msgs = [makeMessage('1')];
    viewFlattenNodes.mockReturnValue(msgs.map((m) => makeNode(m)));

    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    // Called once on mount (immediate sync)
    expect(setMessages).toHaveBeenCalledTimes(1);
    const updater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    expect(updater([])).toEqual(msgs);

    // Called again on view update
    act(() => {
      emitView('update');
    });
    expect(setMessages).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe when no ChatTransportProvider is present', () => {
    const setMessages = vi.fn();
    renderHook(() => {
      useMessageSync({ setMessages });
    });
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const { slot, emitView } = createMockSlot();
    const setMessages = vi.fn();
    const { unmount } = renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    setMessages.mockClear();
    unmount();

    // Emitting after unmount should not call setMessages
    act(() => {
      emitView('update');
    });
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('uses channelName to select a named provider', () => {
    const { slot, viewFlattenNodes } = createMockSlot();
    const msgs = [makeMessage('named')];
    viewFlattenNodes.mockReturnValue(msgs.map((m) => makeNode(m)));

    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ channelName: 'ai:test', setMessages });
      },
      { wrapper: withContext(undefined, { 'ai:test': slot }) },
    );

    expect(setMessages).toHaveBeenCalledTimes(1);
    const updater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    expect(updater([])).toEqual(msgs);
  });

  it('does not subscribe when skip is true', () => {
    const { slot } = createMockSlot();
    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ setMessages, skip: true });
      },
      { wrapper: withContext(slot) },
    );
    expect(setMessages).not.toHaveBeenCalled();
  });

  describe('streaming gate', () => {
    it('suppresses setMessages while streaming', () => {
      const { slot, emitView, viewFlattenNodes, setStreaming } = createMockSlot();
      const msgs = [makeMessage('1')];
      viewFlattenNodes.mockReturnValue(msgs.map((m) => makeNode(m)));

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ setMessages });
        },
        { wrapper: withContext(slot) },
      );

      // Initial sync fires on mount (not yet streaming)
      expect(setMessages).toHaveBeenCalledTimes(1);
      setMessages.mockClear();

      // Start streaming — gate closes
      act(() => {
        setStreaming(true);
      });

      // View updates should be suppressed
      act(() => {
        emitView('update');
      });
      expect(setMessages).not.toHaveBeenCalled();
    });

    it('syncs immediately when streaming ends', () => {
      const { slot, viewFlattenNodes, setStreaming } = createMockSlot();
      const msgs = [makeMessage('1'), makeMessage('2', 'assistant')];
      viewFlattenNodes.mockReturnValue(msgs.map((m) => makeNode(m)));

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ setMessages });
        },
        { wrapper: withContext(slot) },
      );
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

    it('observer messages arriving during streaming appear after gate opens', () => {
      const { slot, emitView, viewFlattenNodes, setStreaming } = createMockSlot();

      // Start with one user message
      const userMsg = makeMessage('1');
      viewFlattenNodes.mockReturnValue([makeNode(userMsg)]);

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ setMessages });
        },
        { wrapper: withContext(slot) },
      );

      // Initial sync: just the user message
      expect(setMessages).toHaveBeenCalledTimes(1);
      const initialUpdater = setMessages.mock.calls[0]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(initialUpdater([])).toEqual([userMsg]);
      setMessages.mockClear();

      // Own-run stream starts — gate closes
      act(() => {
        setStreaming(true);
      });

      // Observer message arrives while gated (another user's assistant response).
      // The transport tree has it, but setMessages should NOT fire.
      const observerMsg = makeMessage('observer-1', 'assistant');
      viewFlattenNodes.mockReturnValue([makeNode(userMsg), makeNode(observerMsg)]);
      act(() => {
        emitView('update');
      });
      expect(setMessages).not.toHaveBeenCalled();

      // Own-run stream ends — gate opens, immediate sync picks up observer message
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
    const { slot, emitView, viewFlattenNodes } = createMockSlot();
    const msg1 = makeMessage('1');
    const msg2 = makeMessage('2', 'assistant');

    viewFlattenNodes.mockReturnValue([makeNode(msg1), makeNode(msg2)]);

    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    // First update - populates messages
    act(() => {
      emitView('update');
    });

    // msg2 gets updated content (new reference), msg1 stays same
    const msg2Updated = makeMessage('2', 'assistant');
    msg2Updated.parts = [{ type: 'text', text: 'Hello' }];
    viewFlattenNodes.mockReturnValue([makeNode(msg1), makeNode(msg2Updated)]);

    // Second update - streaming token
    act(() => {
      emitView('update');
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
