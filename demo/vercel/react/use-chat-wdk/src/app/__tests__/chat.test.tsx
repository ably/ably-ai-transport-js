import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatTransport, VercelOutput, VercelProjection, VercelSessionInput } from '@ably/ai-transport/vercel';
import type { BranchHandle, ClientSession } from '@ably/ai-transport';

import { Chat } from '../chat';
import type { FaultMode } from '../lib/fault';

// jsdom doesn't implement scrollIntoView; MessageList's auto-scroll calls it.
Element.prototype.scrollIntoView = () => {};

// The SDK's React entry + ably-js's React hooks are mocked so the demo's glue
// renders without an Ably client, codec, or session. Stubs live in vi.hoisted so
// the (hoisted) vi.mock factories can reference them and `Chat` can import at the
// top. A breaking change to the SDK's public hook surface is caught at render.
const { mockSendMessages, mockChatTransport, mockSession } = vi.hoisted(() => {
  const send = vi.fn<ChatTransport['sendMessages']>();
  const chatTransport: ChatTransport = {
    sendMessages: send,
    reconnectToStream: async () => null,
    close: async () => {},
    streaming: false,
    onStreamingChange: () => () => {},
  };
  // CAST: minimal ClientSession stub — only the members the happy-path render reaches.
  const session = { close: async () => {}, on: () => () => {} } as unknown as ClientSession<
    VercelSessionInput,
    VercelOutput,
    VercelProjection,
    AI.UIMessage
  >;
  return { mockSendMessages: send, mockChatTransport: chatTransport, mockSession: session };
});

let setMockMessages: ((messages: AI.UIMessage[]) => void) | null = null;

const emptyBranchHandle = (): BranchHandle<AI.UIMessage> => ({
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {},
});

vi.mock('@ably/ai-transport/vercel/react', () => ({
  ChatTransportProvider: ({ children }: { children: ReactNode }) => children,
  useChatTransport: () => ({ chatTransport: mockChatTransport, session: mockSession, sessionError: undefined }),
  useMessageSync: () => {},
  useAblyMessages: () => [],
  useView: () => {
    const [messages, setMessages] = useState<AI.UIMessage[]>([]);
    useEffect(() => {
      setMockMessages = setMessages;
      return () => {
        setMockMessages = null;
      };
    }, []);
    return {
      messages: messages.map((message) => ({ codecMessageId: message.id, message })),
      hasOlder: false,
      loading: false,
      loadOlder: async () => {},
      branchSelection: emptyBranchHandle,
      runOf: () => undefined,
    };
  },
}));

vi.mock('ably/react', () => ({
  ChannelProvider: ({ children }: { children: ReactNode }) => children,
  useChannel: () => ({}),
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

const emptyChunkStream = (): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream<AI.UIMessageChunk>({ start: (controller) => controller.close() });

const faultRef: RefObject<FaultMode | undefined> = { current: undefined };

describe('<Chat>', () => {
  it('mounts, sends the input via chatTransport, and renders view messages', async () => {
    mockSendMessages.mockReset();
    mockSendMessages.mockResolvedValue(emptyChunkStream());

    render(
      <Chat
        chatId="ai:test"
        faultRef={faultRef}
      />,
    );

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSendMessages).toHaveBeenCalledTimes(1);
    });

    expect(setMockMessages).not.toBeNull();
    act(() => {
      setMockMessages?.([{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Hi there', state: 'done' }] }]);
    });

    expect(screen.queryByText('Hi there')).not.toBeNull();
  });

  it('arms a fault into the shared ref when a fault control is clicked', () => {
    faultRef.current = undefined;
    render(
      <Chat
        chatId="ai:test"
        faultRef={faultRef}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fail once' }));
    expect(faultRef.current).toBe('fail-once');
  });
});
