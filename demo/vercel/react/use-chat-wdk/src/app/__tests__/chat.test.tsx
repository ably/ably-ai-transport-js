import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTransport } from '@ably/ai-transport/vercel';

import { Chat } from '../chat';
import { FAULT_COOKIE } from '../lib/fault';

// jsdom doesn't implement scrollIntoView; the transcript's auto-scroll calls it.
Element.prototype.scrollIntoView = () => {};

// The SDK's React entries + ably-js's React hooks are mocked so the demo's glue
// renders without an Ably client or transport. Stubs live in vi.hoisted so the
// (hoisted) vi.mock factories can reference them and `Chat` can import at the
// top. A breaking change to the SDK's public hook surface is caught at render.
const { mockSendMessages, mockSeed, mockChatTransport } = vi.hoisted(() => {
  const send = vi.fn<ChatTransport['sendMessages']>();
  const seed = vi.fn<ChatTransport['seed']>();
  const chatTransport: ChatTransport = {
    sendMessages: send,
    // null is the AI SDK's "nothing to resume".
    reconnectToStream: async () => null,
    seed,
    close: () => {},
    streaming: false,
    onStreamingChange: () => () => {},
  };
  return { mockSendMessages: send, mockSeed: seed, mockChatTransport: chatTransport };
});

vi.mock('@ably/ai-transport/vercel/react', () => ({
  ChatTransportProvider: ({ children }: { children: ReactNode }) => children,
  useChatTransport: () => ({ chatTransport: mockChatTransport, transport: undefined, error: undefined }),
}));

vi.mock('@ably/ai-transport/react', () => ({
  useAblyMessages: () => [],
}));

vi.mock('ably/react', () => ({
  ChannelProvider: ({ children }: { children: ReactNode }) => children,
  useChannel: () => ({}),
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

const emptyChunkStream = (): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream<AI.UIMessageChunk>({ start: (controller) => controller.close() });

describe('<Chat>', () => {
  beforeEach(() => {
    mockSendMessages.mockReset();
    mockSeed.mockClear();
    // Reset the fault cookie between tests (jsdom keeps document.cookie).
    document.cookie = `${FAULT_COOKIE}=; path=/; max-age=0`;
    // The WDK panel polls /api/wdk/runs; keep it inert.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })),
    );
    return () => {
      vi.unstubAllGlobals();
    };
  });

  it('seeds the adapter empty on mount and sends the input via the chat transport', async () => {
    mockSendMessages.mockResolvedValue(emptyChunkStream());

    render(<Chat chatId="ai:test" />);

    // No hydration in this demo: the adapter is seeded with an empty batch so
    // its live indexing starts.
    expect(mockSeed).toHaveBeenCalledWith([]);

    const input = screen.getByPlaceholderText('Type a message...');
    const form = input.closest('form');
    if (!form) throw new Error('input is not nested in a <form>');

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSendMessages).toHaveBeenCalledTimes(1);
    });

    // useChat appends the user message optimistically; the shared Chat renders it.
    expect(screen.queryByText('hello')).not.toBeNull();
  });

  it('arms a fault onto the one-shot cookie when a fault control is clicked', () => {
    render(<Chat chatId="ai:test" />);

    fireEvent.click(screen.getByRole('button', { name: 'Fail once' }));
    expect(document.cookie).toContain(`${FAULT_COOKIE}=fail-once`);

    fireEvent.click(screen.getByRole('button', { name: 'No fault' }));
    expect(document.cookie).not.toContain(`${FAULT_COOKIE}=fail-once`);
  });
});
