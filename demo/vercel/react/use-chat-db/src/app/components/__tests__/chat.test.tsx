import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type * as AI from 'ai';
import { FakeClientTransport, userEvent } from '../../lib/__tests__/helpers';

// jsdom doesn't implement Element.prototype.scrollIntoView; the message list's
// auto-scroll effect calls it whenever the list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface — the Chat is glue over useChat and the SDK's provider hooks.
// The mocks let us exercise the render, the send path, the tool wiring, and
// the persist gate without an Ably client or the AI SDK runtime. useChat's
// options are captured so tests can drive the callbacks the Chat registers.
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockStop = vi.fn(async () => {});
const mockSetMessages = vi.fn();
const mockAddToolOutput = vi.fn();
const mockAddToolApprovalResponse = vi.fn();

let mockMessages: AI.UIMessage[] = [];
let mockStatus = 'ready';
let capturedUseChatOptions: Record<string, unknown> = {};

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    capturedUseChatOptions = options;
    return {
      messages: mockMessages,
      setMessages: mockSetMessages,
      sendMessage: mockSendMessage,
      stop: mockStop,
      status: mockStatus,
      error: undefined,
      addToolOutput: mockAddToolOutput,
      addToolApprovalResponse: mockAddToolApprovalResponse,
    };
  },
}));

const fakeTransport = new FakeClientTransport();
const fakeChatTransport = { seed: vi.fn(), close: vi.fn() };

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: fakeTransport,
    chatTransport: fakeChatTransport,
    error: undefined,
  }),
}));

vi.mock('@ably/ai-transport/react', () => ({
  useAblyMessages: () => [],
}));

// The header's AvatarStack enters presence and reads the member set via
// ably-js's React presence hooks. Stub them so the render needs no Ably client.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked modules.
import { Chat, type ChatProps } from '../chat';

function userMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
function assistantMsg(id: string, text: string): AI.UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
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

function renderChat(overrides: Partial<ChatProps> = {}) {
  return render(
    <Chat
      chatId="ai:test"
      // CAST: the fake implements the seed/close surface the Chat touches.
      chatTransport={fakeChatTransport as unknown as ChatProps['chatTransport']}
      initialMessages={mockMessages}
      initialHasOlder={false}
      {...overrides}
    />,
  );
}

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    mockStop.mockClear();
    mockSetMessages.mockClear();
    mockAddToolOutput.mockClear();
    mockAddToolApprovalResponse.mockClear();
    fakeChatTransport.seed.mockClear();
    fakeTransport.historyBatches = [];
    fakeTransport.historyCount = 0;
    mockStatus = 'ready';
    mockMessages = [];
    capturedUseChatOptions = {};
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the hydrated conversation linearly and resumes an in-flight run', () => {
    mockMessages = [userMsg('u1', 'hi'), assistantMsg('a1', 'hello')];
    renderChat();

    const items = screen.getAllByTestId('message');
    expect(items.map((el) => el.getAttribute('data-id'))).toEqual(['u1', 'a1']);
    expect(screen.getByText('hi')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();

    // useChat is the sole live message state: it initializes from the
    // hydrated conversation and reconnects a still-streaming run.
    expect(capturedUseChatOptions.messages).toEqual(mockMessages);
    expect(capturedUseChatOptions.resume).toBe(true);
    expect(capturedUseChatOptions.transport).toBe(fakeChatTransport);
  });

  it('sends the typed message via sendMessage', async () => {
    renderChat();

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'new turn' } });
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith({ text: 'new turn' }));
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('cancels the streaming response before sending a concurrent message', async () => {
    mockStatus = 'streaming';
    mockMessages = [userMsg('u1', 'hi')];
    renderChat();

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'concurrent' } });
    // The InputBar hides Send while streaming; submit the form directly.
    const form = input.closest('form');
    if (!form) throw new Error('expected the composer input to be inside a form');
    fireEvent.submit(form);

    await waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledWith({ text: 'concurrent' }));
  });

  it('approves and denies an approval-gated tool call via addToolApprovalResponse', () => {
    mockMessages = [userMsg('u1', 'forecast?'), forecastApproval('a1', 'call-1', 'approval-1')];
    renderChat();

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    expect(mockAddToolApprovalResponse).toHaveBeenCalledWith({ id: 'approval-1', approved: true });

    fireEvent.click(screen.getByRole('button', { name: /Deny/i }));
    expect(mockAddToolApprovalResponse).toHaveBeenCalledWith({
      id: 'approval-1',
      approved: false,
      reason: 'User denied',
    });
  });

  it('executes a client tool from onToolCall and reports the output via addToolOutput', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({ coords: { latitude: 51.5, longitude: -0.12 } } as GeolocationPosition);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    renderChat();

    const onToolCall = capturedUseChatOptions.onToolCall as (options: { toolCall: unknown }) => Promise<void>;
    await onToolCall({
      toolCall: { toolName: 'getLocation', toolCallId: 'call-1', input: { highAccuracy: false } },
    });

    await waitFor(() =>
      expect(mockAddToolOutput).toHaveBeenCalledWith({
        tool: 'getLocation',
        toolCallId: 'call-1',
        output: { latitude: 51.5, longitude: -0.12 },
      }),
    );
  });

  it('ignores server tools in onToolCall', async () => {
    renderChat();

    const onToolCall = capturedUseChatOptions.onToolCall as (options: { toolCall: unknown }) => Promise<void>;
    await onToolCall({ toolCall: { toolName: 'getWeather', toolCallId: 'call-1', input: {} } });

    expect(mockAddToolOutput).not.toHaveBeenCalled();
  });

  it('persists the completed turn from onFinish, sliced from the last user message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderChat();

    const older = [userMsg('u1', 'earlier'), assistantMsg('a1', 'earlier reply')];
    const turn = [userMsg('u2', 'hi'), assistantMsg('a2', 'hello')];
    const onFinish = capturedUseChatOptions.onFinish as (options: Record<string, unknown>) => void;
    onFinish({
      message: turn[1],
      messages: [...older, ...turn],
      isAbort: false,
      isError: false,
      finishReason: 'stop',
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/messages');
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: 'ai:test', messages: turn });
  });

  it('does not persist a suspended, aborted, or errored turn', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderChat();

    const onFinish = capturedUseChatOptions.onFinish as (options: Record<string, unknown>) => void;
    const suspended = forecastApproval('a1', 'call-1', 'approval-1');
    onFinish({ message: suspended, messages: [userMsg('u1', 'q'), suspended], isAbort: false, isError: false });
    const complete = assistantMsg('a2', 'done');
    onFinish({ message: complete, messages: [userMsg('u1', 'q'), complete], isAbort: true, isError: false });
    onFinish({ message: complete, messages: [userMsg('u1', 'q'), complete], isAbort: false, isError: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads an older history page and prepends messages the list does not hold', async () => {
    mockMessages = [userMsg('u2', 'current')];
    fakeTransport.historyBatches = [{ events: [userEvent('wire-u1', 'u1', 'older')], exhausted: true }];
    renderChat({ initialHasOlder: true });

    fireEvent.click(screen.getByRole('button', { name: /Load older/i }));

    await waitFor(() => expect(mockSetMessages).toHaveBeenCalledTimes(1));
    const updater = mockSetMessages.mock.calls[0][0] as (current: AI.UIMessage[]) => AI.UIMessage[];
    const updated = updater(mockMessages);
    expect(updated.map((m) => m.id)).toEqual(['u1', 'u2']);

    // The batch was exhausted, so the affordance disappears.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Load older/i })).toBeNull());
  });
});
