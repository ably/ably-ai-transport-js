import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as AI from 'ai';
import type { ClientSession, RunNode } from '@ably/ai-transport';
import type { ChatTransport, VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// The SDK's React entry point is mocked so the demo's React glue can be
// exercised without bringing up an Ably client, the codec, or the session.
// A breaking change to the SDK's public surface (renamed/removed export,
// changed hook shape) is caught at module-load or render-time.
// ---------------------------------------------------------------------------

interface MockViewState {
  messages: AI.UIMessage[];
  runs: Map<string, RunNode<VercelProjection>>;
}

let setMockViewState: ((state: MockViewState) => void) | null = null;

const mockSendMessages = vi.fn<ChatTransport['sendMessages']>();

const mockChatTransport: ChatTransport = {
  sendMessages: mockSendMessages,
  reconnectToStream: async () => null,
  close: async () => {},
  streaming: false,
  onStreamingChange: () => () => {},
};

// CAST: minimal stub of ClientSession. Only methods reachable from the
// happy-path render are populated.
const mockSession = {
  close: vi.fn(async () => {}),
  on: vi.fn(() => () => {}),
} as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

vi.mock('@ably/ai-transport/vercel/react', () => ({
  ChatTransportProvider: ({ children }: { children: ReactNode }) => children,
  useChatTransport: () => ({
    chatTransport: mockChatTransport,
    session: mockSession,
    sessionError: undefined,
  }),
  useMessageSync: () => {},
  useAblyMessages: () => [],
  useView: () => {
    const [state, setState] = useState<MockViewState>({ messages: [], runs: new Map() });
    useEffect(() => {
      setMockViewState = setState;
      return () => {
        setMockViewState = null;
      };
    }, []);
    return {
      messages: state.messages,
      nodes: [...state.runs.values()],
      hasOlder: false,
      loading: false,
      loadOlder: async () => {},
      getSelectedIndex: () => 0,
      select: () => {},
      hasMessageSiblings: () => false,
      getMessageSiblings: () => [],
      getSelectedMessageSiblingIndex: () => 0,
      selectMessageSibling: () => {},
      getMessageMetadata: () => undefined,
      getRunNode: (runId: string) => state.runs.get(runId),
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

const assistantTextMessage = (text: string): AI.UIMessage => ({
  id: 'msg-assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text, state: 'done' }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessages.mockReset();
    mockSendMessages.mockResolvedValue(emptyChunkStream());
  });

  it('mounts, sends the user input via chatTransport, and renders messages pushed through the view', async () => {
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

    expect(setMockViewState).not.toBeNull();
    act(() => {
      setMockViewState?.({ messages: [assistantTextMessage('Hi there')], runs: new Map() });
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });
});
