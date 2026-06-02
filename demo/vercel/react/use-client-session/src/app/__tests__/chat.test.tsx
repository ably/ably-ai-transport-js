import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as AI from 'ai';
import type { ActiveRun, ClientSession, MessageNode, SendOptions } from '@ably/ai-transport';
import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the node list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// `../providers` is mocked so the demo's React glue can be exercised without
// bringing up an Ably client, the codec, or the session. A breaking change to
// the SDK's session-hooks surface is caught at module-load or render-time.
// ---------------------------------------------------------------------------

let setMockViewNodes: ((nodes: MessageNode<AI.UIMessage>[]) => void) | null = null;

const emptyEventStream = (): ReadableStream<VercelOutput> =>
  new ReadableStream<VercelOutput>({
    start: (controller) => {
      controller.close();
    },
  });

const mockSendMessage = vi.fn(
  (_messages: AI.UIMessage | AI.UIMessage[], _opts?: SendOptions): Promise<ActiveRun<VercelOutput>> =>
    Promise.resolve({
      stream: emptyEventStream(),
      started: Promise.resolve(),
      runId: 'run-1',
      invocationId: 'inv-1',
      inputEventId: 'ev-1',
      cancel: async () => {},
      optimisticCodecMessageIds: [],
    }),
);

const mockSession = {
  tree: { on: vi.fn(() => () => {}) },
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  on: vi.fn(() => () => {}),
} as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

vi.mock('../providers', () => ({
  SessionHooks: {
    ClientSessionProvider: ({ children }: { children: ReactNode }) => children,
    useClientSession: () => ({ session: mockSession, sessionError: undefined }),
    useAblyMessages: () => [],
    useView: () => {
      const [nodes, setNodes] = useState<MessageNode<AI.UIMessage>[]>([]);
      useEffect(() => {
        setMockViewNodes = setNodes;
        return () => {
          setMockViewNodes = null;
        };
      }, []);
      const messages = nodes.map((n) => n.message);
      return {
        messages,
        nodes,
        hasOlder: false,
        loading: false,
        loadOlder: async () => {},
        hasMessageSiblings: () => false,
        getMessageSiblings: () => [],
        getSelectedMessageSiblingIndex: () => 0,
        selectMessageSibling: () => {},
        getMessageMetadata: () => undefined,
        getRunNode: () => undefined,
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

const assistantTextNode = (text: string): MessageNode<AI.UIMessage> => ({
  kind: 'message',
  codecMessageId: 'msg-assistant-1',
  parentId: undefined,
  forkOf: undefined,
  headers: {},
  serial: undefined,
  message: {
    id: 'msg-assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text, state: 'done' }],
  } satisfies AI.UIMessage,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
  });

  it('mounts, sends the user input via view.sendMessage, and renders nodes pushed through the view', async () => {
    render(<Chat chatId="ai:test" />);

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

    expect(setMockViewNodes).not.toBeNull();
    act(() => {
      setMockViewNodes?.([assistantTextNode('Hi there')]);
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });
});
