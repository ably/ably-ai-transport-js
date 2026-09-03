/**
 * Tests for the demo's React glue.
 *
 * The SDK's React entry points are mocked so the wiring can be exercised
 * without an Ably client or a Temporal server. `useChat` runs for real against
 * the mocked adapter, so what these cover is this demo's own contribution:
 * hydrating before mount, sending through the adapter, and Stop reaching the
 * channel. A breaking change to the SDK's public hook surface fails at
 * module-load or render time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import type { ChatTransport } from '@ably/ai-transport/vercel';

// jsdom does not implement Element.prototype.scrollIntoView; the transcript's
// auto-scroll effect calls it whenever the message list grows.
Element.prototype.scrollIntoView = () => {};

const mockSendMessages = vi.fn<ChatTransport['sendMessages']>();
const mockCancel = vi.fn<ChatTransport['cancel']>(async () => {});

const mockChatTransport: ChatTransport = {
  sendMessages: mockSendMessages,
  // null is the AI SDK's "nothing to resume".
  reconnectToStream: async () => null,
  readSince: async () => ({ messages: [], exhausted: true }),
  cancel: mockCancel,
  close: () => {},
  streaming: false,
  onStreamingChange: () => () => {},
  onForeignRun: () => () => {},
};

// The hydration hook connects the client transport before walking, so the pair
// the provider hands out must include one.
const mockTransport = { connect: async () => undefined };

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({ transport: mockTransport, chatTransport: mockChatTransport, error: undefined }),
}));

vi.mock('@ably/ai-transport/react', () => ({
  useAblyMessages: () => [],
}));

// The header's AvatarStack enters presence via ably-js's React hooks. Stub them
// so the render needs no Ably client.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// Chat must be imported AFTER vi.mock so it picks up the mocked modules.

import { Chat } from '../chat';

const chunkStreamOf = (chunks: AI.UIMessageChunk[]) =>
  new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const assistantTextChunks = (id: string, text: string): AI.UIMessageChunk[] => [
  { type: 'start', messageId: id },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

const composer = async () => {
  // Hydration walks the channel before the chat mounts.
  const input = await screen.findByPlaceholderText('Type a message...');
  const form = input.closest('form');
  if (!form) throw new Error('input is not nested in a <form>');
  return { input, form };
};

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessages.mockReset();
    mockCancel.mockClear();
    mockSendMessages.mockResolvedValue(chunkStreamOf([]));
  });

  // vitest is not configured with globals, so testing-library's auto-cleanup
  // hook is not registered — unmount explicitly.
  afterEach(() => {
    cleanup();
  });

  it('sends the user input via the chat transport and renders the streamed reply', async () => {
    mockSendMessages.mockResolvedValue(chunkStreamOf(assistantTextChunks('msg-a1', 'Hi there')));

    render(<Chat chatId="ai:test" />);
    const { input, form } = await composer();
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSendMessages).toHaveBeenCalledTimes(1);
    });
    const sent = mockSendMessages.mock.calls[0][0].messages.flatMap((message) =>
      message.parts.filter((part): part is AI.TextUIPart => part.type === 'text').map((part) => part.text),
    );
    expect(sent).toContain('hello');

    await waitFor(() => {
      expect(screen.queryByText('Hi there')).not.toBeNull();
    });
  });

  it('cancels the run on the channel when Stop is pressed', async () => {
    // A stream that never closes keeps useChat streaming, so Stop stays up.
    mockSendMessages.mockResolvedValue(new ReadableStream<AI.UIMessageChunk>({ start: () => {} }));

    render(<Chat chatId="ai:test" />);
    const { input, form } = await composer();
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    fireEvent.click(await screen.findByLabelText('Stop'));

    // useChat.stop() only closes this client's stream. The channel cancel is
    // what aborts the workflow, so the demo must issue both.
    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledTimes(1);
    });
  });
});
