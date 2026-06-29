import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

// ---------------------------------------------------------------------------
// Mock surface — the seeded chat is glue over useChat + the SDK's
// useMessageSync/useChatTransport. The mocks let us exercise the linear render
// and the send path without an Ably client or the AI SDK runtime.
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockStop = vi.fn();
const mockConnect = vi.fn(async () => {});

let mockMessages: AI.UIMessage[] = [];
let mockStatus = 'ready';

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: mockMessages,
    setMessages: vi.fn(),
    sendMessage: mockSendMessage,
    stop: mockStop,
    status: mockStatus,
  }),
}));

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    chatTransport: { sendMessages: vi.fn() },
    session: { connect: mockConnect },
  }),
  useMessageSync: () => {},
}));

import { SeededChat } from '../seeded-chat';

function userMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

describe('<SeededChat>', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockStop.mockClear();
    mockConnect.mockClear();
    mockStatus = 'ready';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the seeded conversation linearly and connects the channel', async () => {
    mockMessages = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    await waitFor(() => expect(mockConnect).toHaveBeenCalled());

    const items = screen.getAllByTestId('message');
    expect(items.map((el) => el.getAttribute('data-id'))).toEqual(['u1', 'a1']);
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('sends the typed message via sendMessage once connected', async () => {
    mockMessages = [];
    render(
      <SeededChat
        chatId="ai:test"
        seed={[]}
      />,
    );

    // The composer appears only after connect() resolves.
    const input = await screen.findByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'new turn' } });
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    expect(mockSendMessage).toHaveBeenCalledWith({ text: 'new turn' });
  });

  it('marks the last assistant response streaming and earlier ones completed', () => {
    mockStatus = 'streaming';
    mockMessages = [
      userMsg('u1', 'hi'),
      assistantMsg('a1', 'first'),
      userMsg('u2', 'again'),
      assistantMsg('a2', 'second'),
    ];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    const states = screen.getAllByTestId('message').map((el) => el.getAttribute('data-state'));
    // user messages carry no state; the earlier assistant is completed, the
    // last (in-flight) assistant is streaming.
    expect(states).toEqual([null, 'completed', null, 'streaming']);
  });

  it('shows Stop while streaming and calls stop() on click', async () => {
    mockStatus = 'streaming';
    mockMessages = [userMsg('u1', 'hi')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    const stopButton = await screen.findByTestId('stop');
    fireEvent.click(stopButton);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('cancels the streaming response before sending a concurrent message', async () => {
    mockStatus = 'streaming';
    mockMessages = [userMsg('u1', 'hi')];
    render(
      <SeededChat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    const input = await screen.findByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'concurrent' } });
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith({ text: 'concurrent' }));
  });
});
