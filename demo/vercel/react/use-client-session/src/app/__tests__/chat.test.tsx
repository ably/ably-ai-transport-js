import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as AI from 'ai';
import { Invocation } from '@ably/ai-transport';
import type { ActiveRun, BranchSelection, ClientSession, SendOptions } from '@ably/ai-transport';
import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// `../providers` is mocked so the demo's React glue can be exercised without
// bringing up an Ably client, the codec, or the session. A breaking change to
// the SDK's session-hooks surface is caught at module-load or render-time.
// ---------------------------------------------------------------------------

let setMockViewMessages: ((messages: AI.UIMessage[]) => void) | null = null;

const mockSendMessage = vi.fn(
  (_messages: AI.UIMessage | AI.UIMessage[], _opts?: SendOptions): Promise<ActiveRun> =>
    Promise.resolve({
      // The triggering input's codec-message-id — the synchronous routing
      // handle the client owns the moment it publishes.
      key: 'input-1',
      // The agent mints the run-id now, so it resolves asynchronously once
      // `ai-run-start` is observed. A fresh send omits run-id from the
      // invocation pointer, leaving the agent to mint it.
      runId: Promise.resolve('run-1'),
      inputEventId: 'ev-1',
      cancel: async () => {},
      optimisticCodecMessageIds: [],
      toInvocation: () => Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'demo' }),
    }),
);

const mockSession = {
  tree: { on: vi.fn(() => () => {}) },
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  on: vi.fn(() => () => {}),
} as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

const emptyBranchSelection = (): BranchSelection<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
});

vi.mock('../providers', () => ({
  SessionHooks: {
    ClientSessionProvider: ({ children }: { children: ReactNode }) => children,
    useClientSession: () => ({ session: mockSession, sessionError: undefined }),
    useAblyMessages: () => [],
    useView: () => {
      const [messages, setMessages] = useState<AI.UIMessage[]>([]);
      useEffect(() => {
        setMockViewMessages = setMessages;
        return () => {
          setMockViewMessages = null;
        };
      }, []);
      return {
        messages,
        hasOlder: false,
        loading: false,
        loadOlder: async () => {},
        branchSelection: emptyBranchSelection,
        selectSibling: () => {},
        runOf: () => undefined,
        run: () => undefined,
        sendMessage: mockSendMessage,
        sendInput: vi.fn(),
        regenerate: vi.fn(),
        edit: vi.fn(),
        on: () => () => {},
      };
    },
  },
  Providers: ({ children }: { children: ReactNode }) => children,
  useAblyReady: () => true,
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked module.
// eslint-disable-next-line import/first
import { Chat } from '../components/chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assistantText = (text: string): AI.UIMessage => ({
  id: 'msg-assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text, state: 'done' }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    // The demo wakes the agent by POSTing the invocation after each send.
    // Stub fetch so that POST succeeds rather than hitting the network; the
    // agent route returns the minted invocation-id, which wakeAgent reads.
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      vi.fn(() => Promise.resolve(Response.json({ invocationId: 'inv-1' }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts, sends the user input via view.sendMessage, and renders messages pushed through the view', async () => {
    render(
      <Chat
        chatId="ai:test"
        api="api/chat"
      />,
    );

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
    const sent = mockSendMessage.mock.calls[0][0];
    const sentMessages = Array.isArray(sent) ? sent : [sent];
    const sentText = sentMessages.flatMap((m) =>
      m.parts.filter((p): p is AI.TextUIPart => p.type === 'text').map((p) => p.text),
    );
    expect(sentText).toContain('hello');

    expect(setMockViewMessages).not.toBeNull();
    act(() => {
      setMockViewMessages?.([assistantText('Hi there')]);
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });
});
