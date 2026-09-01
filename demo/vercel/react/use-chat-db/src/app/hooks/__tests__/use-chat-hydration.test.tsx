import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { FakeClientTransport, userMessage } from '../../lib/__tests__/helpers';

// The hydration pass is keyed per adapter instance, so each test builds a
// fresh pair; the mock hands the current pair to the hook.
let fakeTransport: FakeClientTransport;
let fakeChatTransport: { readSince: ReturnType<typeof vi.fn> };

vi.mock('@ably/ai-transport/vercel/react', () => ({
  useChatTransport: () => ({
    transport: fakeTransport,
    chatTransport: fakeChatTransport,
    error: undefined,
  }),
}));

// Imported AFTER vi.mock so the hook picks up the mocked provider reader.
import { useChatHydration } from '../use-chat-hydration';

const strictModeWrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

const walked = (messages: UIMessage[], exhausted: boolean) => vi.fn().mockResolvedValue({ messages, exhausted });

describe('useChatHydration', () => {
  beforeEach(() => {
    fakeTransport = new FakeClientTransport();
    fakeChatTransport = { readSince: walked([], true) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('walks from the stored serial and appends what the channel has since', async () => {
    const stored = { messages: [userMessage('u1', 'stored question'), userMessage('a1', 'stored reply')] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...stored, latestSerial: '01ABC@7' })));
    fakeChatTransport.readSince = walked([userMessage('u2', 'unpersisted turn')], false);

    // StrictMode re-runs the effect against the same adapter; the pass must
    // still walk once, or the second walk would advance the transport's
    // shared history cursor past the window.
    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(result.current.hasOlder).toBe(true);
    expect(result.current.chatTransport).toBe(fakeChatTransport);
    expect(fakeChatTransport.readSince).toHaveBeenCalledTimes(1);
    expect(fakeChatTransport.readSince).toHaveBeenCalledWith('01ABC@7');
  });

  it('walks to the channel start when the store is empty and reports no older history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ messages: [] })));
    fakeChatTransport.readSince = walked([userMessage('u1', 'first')], true);

    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['u1']);
    expect(result.current.hasOlder).toBe(false);
    // No stored serial means walk everything.
    expect(fakeChatTransport.readSince).toHaveBeenCalledWith(undefined);
  });

  it('reports an error when the store request fails, without walking', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    if (result.current.status !== 'error') throw new Error('expected error');
    expect(result.current.error.message).toContain('500');
    expect(fakeChatTransport.readSince).not.toHaveBeenCalled();
  });
});
