import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as AI from 'ai';
import type { ClientSession, MessageNode } from '@ably/ai-transport';
import type { ChatTransport, VercelEvent, VercelProjection } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the node list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// The SDK's React entry point is mocked so the demo's React glue can be
// exercised without bringing up an Ably client, the codec, or the session.
// A breaking change to the SDK's public surface (renamed/removed export,
// changed hook shape) is caught at module-load or render-time.
// ---------------------------------------------------------------------------

let setMockViewNodes: ((nodes: MessageNode<AI.UIMessage>[]) => void) | null = null;

const mockSendMessages = vi.fn<ChatTransport['sendMessages']>();

const mockChatTransport: ChatTransport = {
  sendMessages: mockSendMessages,
  reconnectToStream: async () => null,
  close: async () => {},
  streaming: false,
  onStreamingChange: () => () => {},
};

// CAST: minimal stub of ClientSession. Only methods reachable from the
// happy-path render are populated. useClientTools' stageEvents branch is
// guarded by `state === 'input-available'` on dynamic-tool parts; since the
// test renders a plain text node, that branch is not entered.
const mockSession = {
  stageEvents: vi.fn(),
  close: vi.fn(async () => {}),
  on: vi.fn(() => () => {}),
} as unknown as ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;

vi.mock('@ably/ai-transport/vercel/react', () => ({
  ChatTransportProvider: ({ children }: { children: ReactNode }) => children,
  useChatTransport: () => ({
    chatTransport: mockChatTransport,
    session: mockSession,
    sessionError: undefined,
  }),
  useMessageSync: () => {},
  useActiveRuns: () => new Map<string, Set<string>>(),
  useAblyMessages: () => [],
  useView: () => {
    const [nodes, setNodes] = useState<MessageNode<AI.UIMessage>[]>([]);
    useEffect(() => {
      setMockViewNodes = setNodes;
      return () => {
        setMockViewNodes = null;
      };
    }, []);
    return {
      nodes,
      hasOlder: false,
      loading: false,
      loadOlder: async () => {},
      hasSiblings: () => false,
      getSiblings: () => [],
      getSelectedIndex: () => 0,
      select: () => {},
    };
  },
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked module.
// eslint-disable-next-line import/first
import { Chat } from '../chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyChunkStream = (): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      controller.close();
    },
  });

const assistantTextNode = (text: string): MessageNode<AI.UIMessage> => ({
  kind: 'message',
  msgId: 'msg-assistant-1',
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
    mockSendMessages.mockReset();
    mockSendMessages.mockResolvedValue(emptyChunkStream());
  });

  it('mounts, sends the user input via chatTransport, and renders nodes pushed through the view', async () => {
    render(<Chat chatId="ai:test" />);

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSendMessages).toHaveBeenCalledTimes(1);
    });
    const sentMessages = mockSendMessages.mock.calls[0][0].messages;
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
