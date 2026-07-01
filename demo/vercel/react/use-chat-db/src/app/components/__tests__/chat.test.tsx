import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

// jsdom doesn't implement Element.prototype.scrollIntoView; MessageList's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface — the Chat is glue over useChat + the SDK's
// useMessageSync/useChatTransport/useAblyMessages. The mocks let us exercise
// the linear render, the send path, and the tool wiring without an Ably client
// or the AI SDK runtime.
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockStop = vi.fn(async () => {});
const mockConnect = vi.fn(async () => {});
const mockAddToolResult = vi.fn();
const mockAddToolApprovalResponse = vi.fn();

let mockMessages: AI.UIMessage[] = [];
let mockStatus = 'ready';

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: mockMessages,
    setMessages: vi.fn(),
    sendMessage: mockSendMessage,
    stop: mockStop,
    status: mockStatus,
    error: undefined,
    addToolResult: mockAddToolResult,
    addToolApprovalResponse: mockAddToolApprovalResponse,
  }),
}));

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    chatTransport: { sendMessages: vi.fn() },
    session: { connect: mockConnect },
  }),
  useMessageSync: () => {},
  useAblyMessages: () => [],
}));

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the render needs no Ably client.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked modules.
import { Chat } from '../chat';

function userMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

// An assistant message carrying a client-executable tool call awaiting input.
function locationToolCall(id: string, toolCallId: string): AI.UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId,
        state: 'input-available',
        input: { highAccuracy: false },
      },
    ],
  };
}

// An assistant message carrying an approval-gated tool call awaiting approval.
function forecastApproval(id: string, toolCallId: string, approvalId: string): AI.UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId,
        state: 'approval-requested',
        input: { location: 'London, UK' },
        approval: { id: approvalId },
      },
    ],
  };
}

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockStop.mockClear();
    mockConnect.mockClear();
    mockAddToolResult.mockClear();
    mockAddToolApprovalResponse.mockClear();
    mockStatus = 'ready';
    mockMessages = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the seeded conversation linearly and connects the channel', async () => {
    mockMessages = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    render(
      <Chat
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
    render(
      <Chat
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

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith({ text: 'new turn' }));
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
      <Chat
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
      <Chat
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
      <Chat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    const input = await screen.findByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'concurrent' } });
    // The InputBar hides Send while streaming; submit the form directly.
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith({ text: 'concurrent' }));
  });

  it('auto-executes a client-side tool call and reports its result via addToolResult', async () => {
    // Provide a geolocation stub so getLocation resolves deterministically.
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({ coords: { latitude: 51.5, longitude: -0.12 } } as GeolocationPosition);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });

    mockMessages = [userMsg('u1', "what's the weather like?"), locationToolCall('a1', 'call-1')];
    render(
      <Chat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    await waitFor(() =>
      expect(mockAddToolResult).toHaveBeenCalledWith({
        tool: 'getLocation',
        toolCallId: 'call-1',
        output: { latitude: 51.5, longitude: -0.12 },
      }),
    );

    vi.unstubAllGlobals();
  });

  it('approves and denies an approval-gated tool call via addToolApprovalResponse', async () => {
    mockMessages = [userMsg('u1', 'forecast?'), forecastApproval('a1', 'call-1', 'approval-1')];
    render(
      <Chat
        chatId="ai:test"
        seed={mockMessages}
      />,
    );

    const approve = await screen.findByRole('button', { name: /Approve/i });
    fireEvent.click(approve);
    expect(mockAddToolApprovalResponse).toHaveBeenCalledWith({ id: 'approval-1', approved: true });

    const deny = screen.getByRole('button', { name: /Deny/i });
    fireEvent.click(deny);
    expect(mockAddToolApprovalResponse).toHaveBeenCalledWith({
      id: 'approval-1',
      approved: false,
      reason: 'User denied',
    });
  });
});
