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
// send, stream consumption, seeding — is what these tests cover. A breaking
// change to the SDK's public surface (renamed/removed export, changed hook
// shape) is caught at module-load or render-time.
// ---------------------------------------------------------------------------

const mockSendMessages = vi.fn<ChatTransport['sendMessages']>();
const mockSeed = vi.fn<ChatTransport['seed']>();

const mockChatTransport: ChatTransport = {
  sendMessages: mockSendMessages,
  // null is the AI SDK's "nothing to resume".
  reconnectToStream: async () => null,
  seed: mockSeed,
  close: () => {},
  streaming: false,
  onStreamingChange: () => () => {},
};

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: undefined,
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
    mockSeed.mockReset();
    mockSendMessages.mockResolvedValue(chunkStreamOf([]));
  });

  // vitest isn't configured with globals, so @testing-library/react's
  // auto-cleanup hook isn't registered — unmount explicitly so a later test's
  // queries don't match an earlier render.
  afterEach(() => {
    cleanup();
  });

  it('seeds the adapter empty on mount (no hydration) so live indexing opens', async () => {
    render(<Chat chatId="ai:test" />);
    await waitFor(() => {
      expect(mockSeed).toHaveBeenCalledWith([]);
    });
  });

  it('sends the user input via the chat transport and renders the streamed reply', async () => {
    mockSendMessages.mockResolvedValue(chunkStreamOf(assistantTextChunks('msg-assistant-1', 'Hi there')));

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

    // useChat consumes the transport's chunk stream; the merged assistant
    // reply renders in the transcript.
    await waitFor(() => {
      expect(screen.queryByText('Hi there')).not.toBeNull();
    });
  });
});
