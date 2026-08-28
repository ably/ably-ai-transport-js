// @vitest-environment jsdom

/**
 * ChatTransportProvider lifecycle: the bridge closes a superseded adapter
 * when the transport is recreated (a channelName change), closes the current
 * adapter on a true unmount via the microtask-deferred close, and survives a
 * React Strict Mode remount without closing anything.
 */

import { render } from '@testing-library/react';
import type * as Ably from 'ably';
import { createElement, type ReactElement, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatTransportProvider } from '../../../src/vercel/react/contexts/chat-transport-provider.js';
import { useChatTransport } from '../../../src/vercel/react/use-chat-transport.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';

/** Flush microtasks (but NOT macrotasks) so the deferred unmount close fires. */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

vi.mock('ably/react', async () => {
  const { createElement: h, Fragment } = await import('react');
  // CAST: the provider only calls channels.get; the channel is never used by
  // the mocked transport factory.
  const client = {
    channels: { get: (name: string) => ({ name }) as unknown as Ably.RealtimeChannel },
  } as unknown as Ably.Realtime;
  return {
    useAbly: () => client,
    ChannelProvider: ({ children }: { children?: ReactNode }) => h(Fragment, undefined, children),
  };
});

vi.mock('../../../src/core/transport/client-transport.js', () => ({
  createClientTransport: vi.fn(() => ({
    connect: async () => {
      /* connected */
    },
    close: vi.fn(),
  })),
}));

// Every adapter the mocked factory hands out, in creation order, so the
// tests can assert which one was closed.
const adapters = vi.hoisted(() => [] as { close: ReturnType<typeof vi.fn> }[]);

vi.mock('../../../src/vercel/transport/chat-transport.js', () => ({
  createChatTransport: vi.fn(() => {
    const adapter = { close: vi.fn() };
    adapters.push(adapter);
    // CAST: the bridge stores and closes the adapter; no other member is read.
    return adapter as unknown as ChatTransport;
  }),
}));

// The probe records the slot the provider published on every render.
const captured: { chatTransport: ChatTransport | undefined } = { chatTransport: undefined };
const Probe = (): ReactNode => {
  captured.chatTransport = useChatTransport().chatTransport;
  return false;
};

const ui = (channelName: string): ReactElement =>
  createElement(ChatTransportProvider, { channelName }, createElement(Probe));

describe('ChatTransportProvider lifecycle', () => {
  beforeEach(() => {
    adapters.length = 0;
    captured.chatTransport = undefined;
  });

  it('closes the superseded adapter when channelName changes', () => {
    const { rerender } = render(ui('ai:one'));
    expect(adapters).toHaveLength(1);
    expect(captured.chatTransport).toBeDefined();

    rerender(ui('ai:two'));

    expect(adapters).toHaveLength(2);
    expect(adapters[0]?.close).toHaveBeenCalledTimes(1);
    expect(adapters[1]?.close).not.toHaveBeenCalled();
  });

  it('closes the adapter on a true unmount, deferred a microtask', async () => {
    const { unmount } = render(ui('ai:one'));
    expect(adapters).toHaveLength(1);

    unmount();
    // The close is deferred so a Strict Mode remount could cancel it.
    expect(adapters[0]?.close).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(adapters[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('survives a Strict Mode remount without closing the adapter', async () => {
    render(createElement(StrictMode, undefined, ui('ai:one')));

    await flushMicrotasks();

    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.close).not.toHaveBeenCalled();
  });
});
