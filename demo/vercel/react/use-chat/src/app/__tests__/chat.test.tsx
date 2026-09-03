import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import type { ChatTransport } from '@ably/ai-transport/vercel';

// jsdom doesn't implement Element.prototype.scrollIntoView; the message list's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

// ---------------------------------------------------------------------------
// Mock surface
//
// The SDK's React entry points are mocked so the demo's React glue can be
// exercised without bringing up an Ably client or the transport. useChat runs
// for real against the mocked ChatTransport, so the demo's wiring into it —
// send, stream consumption, stop — is what these tests cover. A breaking
// change to the SDK's public surface (renamed/removed export, changed hook
// shape) is caught at module-load or render-time.
// ---------------------------------------------------------------------------

const mockSendMessages = vi.fn<ChatTransport['sendMessages']>();
const mockCancel = vi.fn<ChatTransport['cancel']>(async () => {});
// null is the AI SDK's "nothing to resume".
const mockReconnect = vi.fn<ChatTransport['reconnectToStream']>(async () => null);
const mockReadSince = vi.fn<ChatTransport['readSince']>(async () => ({ messages: [], exhausted: true }));
const mockForeignRun = vi.fn<ChatTransport['onForeignRun']>(() => () => {});
const mockForeignInput = vi.fn<ChatTransport['onForeignInput']>(() => () => {});

/**
 * A fresh adapter per test. The demo's hydration caches its store read per
 * adapter instance (React Strict Mode re-runs the effect against the same
 * one), so a shared object would hand every test the first test's
 * conversation.
 */
const makeChatTransport = (): ChatTransport => ({
  sendMessages: mockSendMessages,
  reconnectToStream: mockReconnect,
  readSince: mockReadSince,
  cancel: mockCancel,
  close: () => {},
  streaming: false,
  onStreamingChange: () => () => {},
  onForeignRun: mockForeignRun,
  onForeignInput: mockForeignInput,
});

let mockChatTransport: ChatTransport = makeChatTransport();

// One stable object. The hydration hook keys its effect on the pair's
// identity, so a fresh literal per render would re-run the walk forever.
const mockTransport = { connect: async () => undefined };

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: mockTransport,
    chatTransport: mockChatTransport,
    error: undefined,
  }),
}));

vi.mock('@ably/ai-transport/react', () => ({
  useAblyMessages: () => [],
}));

// The header's AvatarStack enters presence via ably-js's React presence hooks,
// and the checklist widget reads the channel via useChannel. Stub them so the
// render needs no Ably client; a never-resolving object.get keeps the widget
// hidden (no steps, no error), which these tests ignore.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
  useChannel: () => ({ channel: { object: { get: () => new Promise(() => {}) } } }),
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked modules.

import { Chat } from '../chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const chunkStreamOf = (chunks: AI.UIMessageChunk[]): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const assistantTextChunks = (messageId: string, text: string): AI.UIMessageChunk[] => [
  { type: 'start', messageId },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessages.mockReset();
    mockCancel.mockReset();
    mockReconnect.mockClear();
    mockReadSince.mockClear();
    mockReadSince.mockResolvedValue({ messages: [], exhausted: true });
    mockForeignRun.mockClear();
    mockForeignInput.mockClear();
    mockChatTransport = makeChatTransport();
    mockSendMessages.mockResolvedValue(chunkStreamOf([]));
    // Hydration reads the server's conversation store over HTTP. An empty
    // conversation with no open run is the default; a test that wants a seed
    // or a resume stubs its own answer.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ messages: [] }))),
    );
  });

  // vitest isn't configured with globals, so @testing-library/react's
  // auto-cleanup hook isn't registered — unmount explicitly so a later test's
  // queries don't match an earlier render.
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('seeds from the store and appends what the channel walk returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'stored prompt' }] }],
            latestSerial: 's-2',
          }),
        ),
      ),
    );
    // readSince hands back the events it walked; the hydration hook assembles
    // them through the provider's reducer.
    mockReadSince.mockResolvedValue({
      messages: [
        {
          id: 'a1',
          events: [
            { direction: 'output', event: { type: 'start', messageId: 'a1' } },
            { direction: 'output', event: { type: 'text-start', id: 't1' } },
            { direction: 'output', event: { type: 'text-delta', id: 't1', delta: 'walked reply' } },
            { direction: 'output', event: { type: 'text-end', id: 't1' } },
            { direction: 'output', event: { type: 'finish' } },
          ],
        },
      ],
      exhausted: true,
    });

    render(<Chat chatId="ai:test" />);

    expect(await screen.findByText('stored prompt')).not.toBeNull();
    expect(screen.queryByText('walked reply')).not.toBeNull();
  });

  it('walks the channel back only as far as the serial the store reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ messages: [], latestSerial: 's-7' }))),
    );

    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockReadSince).toHaveBeenCalledTimes(1);
    });
    expect(mockReadSince).toHaveBeenCalledWith('s-7');
  });

  it('walks the whole channel when the store reports no serial', async () => {
    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockReadSince).toHaveBeenCalledTimes(1);
    });
    expect(mockReadSince).toHaveBeenCalledWith(undefined);
  });

  it('resumes once after the walk, so a run still streaming is picked up', async () => {
    render(<Chat chatId="ai:test" />);

    // Step five of the hydration flow. The walk has already run, so the
    // adapter holds whatever it withheld; with nothing in flight it answers
    // null and useChat stays idle.
    await waitFor(() => {
      expect(mockReconnect).toHaveBeenCalledTimes(1);
    });
    await screen.findByPlaceholderText('Type a message...');
    expect(mockReconnect).toHaveBeenCalledTimes(1);
  });

  it('subscribes to runs another participant started', async () => {
    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockForeignRun).toHaveBeenCalled();
    });
    // useChat takes new streamed content only through resumeStream, so an idle
    // tab has to ask for a foreign run or it renders nothing while others chat.
    const notify = mockForeignRun.mock.calls[0]?.[0];
    if (!notify) throw new Error('no foreign-run callback registered');
    mockReconnect.mockClear();
    notify('run-elsewhere');
    await waitFor(() => {
      expect(mockReconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the user turn another participant published', async () => {
    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockForeignInput).toHaveBeenCalled();
    });
    // resumeStream carries the foreign run's output alone, so without this the
    // reply would render with nothing that prompted it.
    const notify = mockForeignInput.mock.calls[0]?.[0];
    if (!notify) throw new Error('no foreign-input callback registered');
    notify({
      kind: 'message',
      payload: { id: 'u-theirs', role: 'user', parts: [{ type: 'text', text: 'their prompt' }] },
    });

    expect(await screen.findByText('their prompt')).not.toBeNull();
  });

  it('concatenates the parts of a foreign turn that arrives as several inputs', async () => {
    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockForeignInput).toHaveBeenCalled();
    });
    const notify = mockForeignInput.mock.calls[0]?.[0];
    if (!notify) throw new Error('no foreign-input callback registered');
    // One user message reaches the channel as one wire message per part, so
    // the same id arrives more than once and must not overwrite itself.
    notify({
      kind: 'message',
      payload: { id: 'u-theirs', role: 'user', parts: [{ type: 'text', text: 'first part' }] },
    });
    notify({
      kind: 'message',
      payload: { id: 'u-theirs', role: 'user', parts: [{ type: 'text', text: 'second part' }] },
    });

    const bubble = await screen.findByText(/first part/);
    expect(bubble.textContent).toContain('second part');
  });

  it('ignores a foreign input that is not a whole message', async () => {
    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockForeignInput).toHaveBeenCalled();
    });
    const notify = mockForeignInput.mock.calls[0]?.[0];
    if (!notify) throw new Error('no foreign-input callback registered');
    // A regenerate names a message rather than carrying one, so there is
    // nothing to append for it.
    notify({ kind: 'regenerate', payload: { messageId: 'a1' } });

    await screen.findByPlaceholderText('Type a message...');
    expect(screen.queryByText('a1')).toBeNull();
  });

  it('cancels the run on the channel when Stop is pressed', async () => {
    // A stream that never closes keeps useChat streaming, so Stop stays up.
    mockSendMessages.mockResolvedValue(new ReadableStream<AI.UIMessageChunk>({ start: () => {} }));

    render(<Chat chatId="ai:test" />);
    // Hydration reads the store before the chat mounts.
    const input = await screen.findByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    const stop = await screen.findByLabelText('Stop');
    fireEvent.click(stop);

    // useChat.stop() only closes this client's stream. The channel cancel is
    // what aborts the agent, so the demo must issue both.
    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('sends the user input via the chat transport and renders the streamed reply', async () => {
    mockSendMessages.mockResolvedValue(chunkStreamOf(assistantTextChunks('msg-assistant-1', 'Hi there')));

    render(<Chat chatId="ai:test" />);

    // Hydration reads the store before the chat mounts.
    const input = await screen.findByPlaceholderText('Type a message...');
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

    // useChat consumes the transport's chunk stream; the merged assistant
    // reply renders in the transcript.
    await waitFor(() => {
      expect(screen.queryByText('Hi there')).not.toBeNull();
    });
  });
});
