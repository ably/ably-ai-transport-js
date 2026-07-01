// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CodecMessage } from '../../../src/core/codec/types.js';
import type { ClientSession } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import type { ChatTransportSlot } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { ChatTransportContext } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { useMessageSync } from '../../../src/vercel/react/use-message-sync.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { makeFakeLoadUntil } from '../../helper/fake-load-until.js';

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

// A mock ChatTransport whose streaming gate can be toggled via `setStreaming`.
const makeMockChatTransport = (): { chatTransport: ChatTransport; setStreaming: (value: boolean) => void } => {
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

  return { chatTransport, setStreaming };
};

// A mock view event subscription: `viewOn` registers handlers; `emitView` fires them.
const makeViewSubscription = (): { viewOn: ReturnType<typeof vi.fn>; emitView: (event: string) => void } => {
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
  const emitView = (event: string): void => {
    for (const handler of viewHandlers.get(event) ?? []) handler();
  };
  return { viewOn, emitView };
};

// A mock ClientSession wrapping the given view — only the subset useMessageSync uses.
const makeMockSession = (
  view: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>['view'],
): ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage> =>
  ({
    view,
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    tree: {},
    send: vi.fn(),
    regenerate: vi.fn(),
    edit: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    // CAST: mock object satisfies the subset of ClientSession methods used by useMessageSync
  }) as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

interface MockSlot {
  slot: ChatTransportSlot;
  emitView: (event: string) => void;
  viewFlattenNodes: ReturnType<typeof vi.fn>;
  setStreaming: (value: boolean) => void;
}

const createMockSlot = (): MockSlot => {
  // --- View ---
  const { viewOn, emitView } = makeViewSubscription();

  // `flattenNodes` and `getMessages` are mocked together: tests stage
  // `{ message }` entries via `viewFlattenNodes.mockReturnValue(...)` and
  // `getMessages` projects them to the codec-message-id pairs the production
  // code reads (then maps to the flat `UIMessage[]`).
  const viewFlattenNodes = vi.fn(() => [] as { message: AI.UIMessage }[]);
  const viewGetMessages = vi.fn(() =>
    viewFlattenNodes().map((n) => ({ codecMessageId: n.message.id, message: n.message })),
  );

  const viewHasOlder = vi.fn(() => false);
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const viewLoadOlder = vi.fn(() => Promise.resolve([] as CodecMessage<AI.UIMessage>[]));
  const view = {
    on: viewOn,
    flattenNodes: viewFlattenNodes,
    getMessages: viewGetMessages,
    hasOlder: viewHasOlder,
    loadOlder: viewLoadOlder,
    loadUntil: makeFakeLoadUntil({ getMessages: viewGetMessages, hasOlder: viewHasOlder, loadOlder: viewLoadOlder }),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>['view'];

  // --- ChatTransport ---
  const { chatTransport, setStreaming } = makeMockChatTransport();

  const slot: ChatTransportSlot = { session: makeMockSession(view), chatTransport };

  return { slot, emitView, viewFlattenNodes, setStreaming };
};

// Wrap renderHook with a ChatTransportContext providing the given nearest slot and registry.
const withContext =
  (nearest?: ChatTransportSlot, providers: Record<string, ChatTransportSlot> = {}) =>
  ({ children }: { children: ReactNode }) =>
    createElement(ChatTransportContext.Provider, { value: { nearest, providers } }, children);

// ---------------------------------------------------------------------------
// Paging harness — a view backed by a simulated channel the seam-walk pages.
// ---------------------------------------------------------------------------
//
// `visible` is the initially-revealed window (the live tail). `older` is the
// hidden channel history, chronological (oldest first); each loadOlder(limit)
// reveals the newest hidden block, prepends it to the window, emits 'update',
// and returns the revealed page oldest-first — mirroring View.loadOlder.

interface PagingSlot {
  slot: ChatTransportSlot;
  emitView: (event: string) => void;
  loadOlder: ReturnType<typeof vi.fn>;
  setStreaming: (value: boolean) => void;
  /** Append newer messages to the live window (a fresh turn) and emit 'update'. */
  appendLive: (...msgs: AI.UIMessage[]) => void;
  /** Replace a visible message by id (a streaming token) and emit 'update'. */
  updateLive: (msg: AI.UIMessage) => void;
}

const createPagingSlot = ({ visible, older }: { visible: AI.UIMessage[]; older: AI.UIMessage[] }): PagingSlot => {
  const { viewOn, emitView } = makeViewSubscription();

  const revealed = [...visible];
  const buffer = [...older];
  const toCodec = (m: AI.UIMessage): { codecMessageId: string; message: AI.UIMessage } => ({
    codecMessageId: m.id,
    message: m,
  });

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const loadOlder = vi.fn((limit?: number) => {
    const count = Math.min(limit ?? 1, buffer.length);
    const page = buffer.splice(buffer.length - count, count);
    revealed.unshift(...page);
    if (page.length > 0) emitView('update');
    return Promise.resolve(page.map((m) => toCodec(m)));
  });

  const getMessages = vi.fn(() => revealed.map((m) => toCodec(m)));
  const hasOlder = vi.fn(() => buffer.length > 0);
  // Model DefaultView.loadUntil's exclusive-floor trim: re-hide the oldest
  // `count` revealed messages (the seam and older) as the newest hidden block, so
  // getMessages() reports the tail and loadOlder can re-reveal them seam-first.
  const hideOldest = (count: number): void => {
    const cut = revealed.splice(0, count);
    buffer.push(...cut);
    emitView('update');
  };
  const view = {
    on: viewOn,
    getMessages,
    hasOlder,
    loadOlder,
    loadUntil: makeFakeLoadUntil({ getMessages, hasOlder, loadOlder, hideOldest }),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>['view'];

  const appendLive = (...msgs: AI.UIMessage[]): void => {
    revealed.push(...msgs);
    emitView('update');
  };
  const updateLive = (msg: AI.UIMessage): void => {
    const idx = revealed.findIndex((m) => m.id === msg.id);
    if (idx !== -1) revealed[idx] = msg;
    emitView('update');
  };

  const { chatTransport, setStreaming } = makeMockChatTransport();
  const slot: ChatTransportSlot = { session: makeMockSession(view), chatTransport };

  return { slot, emitView, loadOlder, setStreaming, appendLive, updateLive };
};

// The domain ids of a message list, for order/dedup assertions.
const ids = (msgs: AI.UIMessage[]): string[] => msgs.map((m) => m.id);

// Drain the async seam-walk: each loadOlder reveal settles on a microtask, so
// flush a few turns under act() to let the walk page back to the seam.
const flushWalk = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

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

    // A view update that changes the window re-syncs.
    const msgs2 = [makeMessage('1'), makeMessage('2', 'assistant')];
    viewFlattenNodes.mockReturnValue(msgs2.map((m) => makeNode(m)));
    act(() => {
      emitView('update');
    });
    expect(setMessages).toHaveBeenCalledTimes(2);
    const updater2 = setMessages.mock.calls[1]?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    expect(updater2([])).toEqual(msgs2);
  });

  it('does not re-sync on host re-renders when no seed is provided (no render loop)', () => {
    // Regression: useMessageSync defaulted the seed to a fresh `[]` every render
    // (`messages ?? []`). useMessagesWithSeed keys its composed result on the seed
    // reference, so the result churned a new reference each render and this effect
    // re-fired setMessages every render — useChat's setMessages then re-rendered
    // the host, looping ("Maximum update depth exceeded"). A stable empty-seed
    // default keeps the result reference-stable, so a no-op re-render does not sync.
    const { slot, viewFlattenNodes } = createMockSlot();
    viewFlattenNodes.mockReturnValue([makeNode(makeMessage('1'))]);

    const setMessages = vi.fn();
    const { rerender } = renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    expect(setMessages).toHaveBeenCalledTimes(1); // initial mount sync
    setMessages.mockClear();

    // Re-render the host with nothing changed — must not re-sync.
    rerender();
    rerender();
    expect(setMessages).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // Overlay-led tool resolutions survive sync
  // ---------------------------------------------------------------------------

  it('preserves an overlay tool resolution when the tree still shows input-available', () => {
    const { slot, emitView, viewFlattenNodes } = createMockSlot();
    const userMsg = makeMessage('u1');
    const treeAsst: AI.UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        // CAST: hand-rolled static tool part (`tool-${name}`) matches the AI SDK
        // shape — a statically-declared tool the codec round-trips faithfully.
        {
          type: 'tool-getLocation',
          toolCallId: 'tc-1',
          state: 'input-available',
          input: { highAccuracy: false },
        } as unknown as AI.UIMessage['parts'][number],
      ],
    };
    viewFlattenNodes.mockReturnValue([makeNode(userMsg), makeNode(treeAsst)]);

    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    act(() => {
      emitView('update');
    });

    // CAST: setMessages receives an updater function from useMessageSync.
    const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    // The overlay carries the same `tool-${name}` representation the codec now
    // round-trips faithfully, but a step ahead: `addToolResult` has resolved it
    // to `output-available`. The merge keeps the tree's part type and adopts the
    // overlay's resolved state when the overlay is more advanced.
    const overlayAsst: AI.UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-getLocation',
          toolCallId: 'tc-1',
          state: 'output-available',
          input: { highAccuracy: false },
          output: { latitude: 51, longitude: 0 },
        } as unknown as AI.UIMessage['parts'][number],
      ],
    };
    const result = updater([userMsg, overlayAsst]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(userMsg);
    const mergedAsst = result[1];
    expect(mergedAsst).toBeDefined();
    expect(mergedAsst?.id).toBe('a1');
    const mergedToolPart = mergedAsst?.parts[0];
    expect(mergedToolPart).toBeDefined();
    // The merged result keeps the tree's faithful `tool-getLocation` type so
    // downstream consumers keying on the static tool type continue to render…
    expect((mergedToolPart as { type?: string }).type).toBe('tool-getLocation');
    // …but adopts the overlay's resolved state and output, so the AI
    // SDK's `sendAutomaticallyWhen` and the chat-transport's
    // continuation derivation can see the result.
    expect((mergedToolPart as { state?: string }).state).toBe('output-available');
    expect((mergedToolPart as { output?: { latitude?: number } }).output?.latitude).toBe(51);
  });

  it('keeps the tree intact when the overlay tool part is not more advanced', () => {
    const { slot, emitView, viewFlattenNodes } = createMockSlot();
    const userMsg = makeMessage('u1');
    const treeAsst: AI.UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolCallId: 'tc-1',
          toolName: 'getLocation',
          state: 'output-available',
          input: { highAccuracy: false },
          output: { latitude: 42, longitude: 1 },
        } as unknown as AI.UIMessage['parts'][number],
      ],
    };
    viewFlattenNodes.mockReturnValue([makeNode(userMsg), makeNode(treeAsst)]);

    const setMessages = vi.fn();
    renderHook(
      () => {
        useMessageSync({ setMessages });
      },
      { wrapper: withContext(slot) },
    );

    act(() => {
      emitView('update');
    });

    // CAST: setMessages updater shape from useMessageSync.
    const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
    // Overlay still shows the pre-resolution state — the tree is the
    // source of truth here.
    const overlayAsst: AI.UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-getLocation',
          toolCallId: 'tc-1',
          state: 'input-available',
          input: { highAccuracy: false },
        } as unknown as AI.UIMessage['parts'][number],
      ],
    };
    const result = updater([userMsg, overlayAsst]);

    // No overlay-led transition, so the merge returns the tree messages
    // by reference equality.
    expect(result[1]).toBe(treeAsst);
  });

  // ---------------------------------------------------------------------------
  // Seed reconciliation — page the live view back to the seed and compose
  // ---------------------------------------------------------------------------

  describe('seed reconciliation', () => {
    it('renders a seed linearly when nothing newer is live', async () => {
      // Persisted [u1, a1]; the channel still carries the seam a1 (hidden) and
      // nothing newer has streamed.
      const seed = [makeMessage('u1'), makeMessage('a1', 'assistant')];
      const { slot, loadOlder } = createPagingSlot({ visible: [], older: [makeMessage('a1', 'assistant')] });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ messages: seed, setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      // The walk pages back to the seam (the only hidden message).
      expect(loadOlder).toHaveBeenCalled();
      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(ids(updater(seed))).toEqual(['u1', 'a1']);
    });

    it('composes seed ⧺ live, dropping the single seam overlap', async () => {
      // Persisted [u1, a1]; the channel carries the seam a1 (hidden) plus a
      // newer live tail [u2, a2] already folded.
      const seed = [makeMessage('u1'), makeMessage('a1', 'assistant')];
      const { slot } = createPagingSlot({
        visible: [makeMessage('u2'), makeMessage('a2', 'assistant')],
        older: [makeMessage('a1', 'assistant')],
      });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ messages: seed, setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      const result = updater(seed);
      // The persisted prefix joins the live tail with the seam shown once.
      expect(ids(result)).toEqual(['u1', 'a1', 'u2', 'a2']);
      expect(result.filter((m) => m.id === 'a1')).toHaveLength(1);
    });

    it('merges a mid-session run that completes after reconciliation', async () => {
      // Warm start: the seam a1 is already visible, so no walk is needed.
      const seed = [makeMessage('u1'), makeMessage('a1', 'assistant')];
      const { slot, appendLive, updateLive } = createPagingSlot({
        visible: [makeMessage('a1', 'assistant')],
        older: [],
      });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ messages: seed, setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      // A new turn streams: user prompt, then an assistant message that fills in.
      const u2 = makeMessage('u2');
      const a2Empty = makeMessage('a2', 'assistant');
      act(() => {
        appendLive(u2, a2Empty);
      });
      const a2Full = makeMessage('a2', 'assistant');
      a2Full.parts = [{ type: 'text', text: 'done' }];
      act(() => {
        updateLive(a2Full);
      });

      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      const result = updater(seed);
      expect(ids(result)).toEqual(['u1', 'a1', 'u2', 'a2']);
      // The completed assistant message carries its streamed content, once.
      expect(result.filter((m) => m.id === 'a2')).toHaveLength(1);
      expect(result.at(-1)?.parts).toEqual([{ type: 'text', text: 'done' }]);
    });

    it('reload convergence: seed + walked live reconstructs the whole conversation', async () => {
      // The whole conversation up to a2 is persisted; the channel carries the
      // seam a2 (hidden) plus a newer live turn [u3, a3].
      const seed = [
        makeMessage('u1'),
        makeMessage('a1', 'assistant'),
        makeMessage('u2'),
        makeMessage('a2', 'assistant'),
      ];
      const { slot } = createPagingSlot({
        visible: [makeMessage('u3'), makeMessage('a3', 'assistant')],
        older: [makeMessage('a2', 'assistant')],
      });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ messages: seed, setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      const result = updater(seed);
      expect(ids(result)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
      // The seam appears exactly once — no duplicate where seed meets live.
      expect(result.filter((m) => m.id === 'a2')).toHaveLength(1);
    });

    it('stops at history exhaustion when the seam is absent from the channel', async () => {
      // The seam x1 was never on this channel (e.g. history expired). The walk
      // drains the buffer and stops at exhaustion rather than hanging.
      const seed = [makeMessage('x1')];
      const { slot, loadOlder } = createPagingSlot({
        visible: [makeMessage('u1'), makeMessage('a1', 'assistant')],
        older: [makeMessage('u0')],
      });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ messages: seed, setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      // It paged the one hidden message, found no seam, and stopped.
      expect(loadOlder).toHaveBeenCalledTimes(1);
      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(ids(updater(seed))).toEqual(['x1', 'u0', 'u1', 'a1']);
    });

    it('no seed: surfaces the live window without paging', async () => {
      // Without a seed the hook never walks — it surfaces only the live window,
      // exactly as before (history paging stays the caller's job).
      const { slot, loadOlder } = createPagingSlot({
        visible: [makeMessage('u1'), makeMessage('a1', 'assistant')],
        older: [makeMessage('u0')],
      });

      const setMessages = vi.fn();
      renderHook(
        () => {
          useMessageSync({ setMessages });
        },
        { wrapper: withContext(slot) },
      );
      await flushWalk();

      expect(loadOlder).not.toHaveBeenCalled();
      const updater = setMessages.mock.calls.at(-1)?.[0] as (prev: AI.UIMessage[]) => AI.UIMessage[];
      expect(ids(updater([]))).toEqual(['u1', 'a1']);
    });
  });
});
