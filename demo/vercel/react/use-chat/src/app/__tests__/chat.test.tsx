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

/**
 * A fresh adapter per test. The demo's hydration caches its store read per
 * adapter instance (React Strict Mode re-runs the effect against the same
 * one), so a shared object would hand every test the first test's
 * conversation.
 */
const makeChatTransport = (): ChatTransport => ({
  sendMessages: mockSendMessages,
  reconnectToStream: mockReconnect,
  readSince: async () => ({ messages: [], exhausted: true }),
  cancel: mockCancel,
  close: () => {},
  streaming: false,
  onStreamingChange: () => () => {},
  onForeignRun: () => () => {},
});

let mockChatTransport: ChatTransport = makeChatTransport();

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: { connect: async () => undefined },
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

  it('seeds the conversation from the stored messages the server serves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'stored prompt' }] }],
          }),
        ),
      ),
    );

    render(<Chat chatId="ai:test" />);

    expect(await screen.findByText('stored prompt')).not.toBeNull();
    // The store is the whole record: nothing walks the channel for it.
    await waitFor(() => {
      expect(mockReconnect).not.toHaveBeenCalled();
    });
  });

  it('resumes the run the store reports open, naming it as a reconnect hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ messages: [], activeRunId: 'run-open' }))),
    );

    render(<Chat chatId="ai:test" />);

    await waitFor(() => {
      expect(mockReconnect).toHaveBeenCalledTimes(1);
    });
    // The hint is what lets a page that never watched the run start still join
    // it — the adapter has nothing of its own to resume from.
    expect(mockReconnect.mock.calls[0]?.[0]).toMatchObject({ body: { runId: 'run-open' } });
  });

  it('resumes nothing when the store reports no open run', async () => {
    render(<Chat chatId="ai:test" />);

    await screen.findByPlaceholderText('Type a message...');
    expect(mockReconnect).not.toHaveBeenCalled();
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
