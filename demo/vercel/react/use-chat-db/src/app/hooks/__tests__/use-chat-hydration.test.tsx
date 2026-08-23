import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { FakeClientTransport, messageEvent, userEvent, userMessage } from '../../lib/__tests__/helpers';

// The hydration pass is keyed per adapter instance, so each test builds a
// fresh pair; the mock hands the current pair to the hook.
let fakeTransport: FakeClientTransport;
let fakeChatTransport: { seed: ReturnType<typeof vi.fn> };

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

describe('useChatHydration', () => {
  beforeEach(() => {
    fakeTransport = new FakeClientTransport();
    fakeChatTransport = { seed: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges the store seed with the history gap and seeds the adapter once', async () => {
    const stored = [userMessage('u1', 'stored question'), userMessage('a1', 'stored reply')];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(stored)));
    // The gap: the batch referencing the newest stored id (a1) plus the
    // suspended tail the store never saw.
    const gapEvents = [
      messageEvent({ codecMessageId: 'wire-a1', runId: 'run-1' }, { outputs: [{ type: 'start', messageId: 'a1' }] }),
      userEvent('wire-u2', 'u2', 'unpersisted turn'),
    ];
    fakeTransport.historyBatches = [
      { events: gapEvents, exhausted: false },
      { events: [userEvent('wire-u0', 'u0', 'never paged')], exhausted: true },
    ];

    // StrictMode re-runs the effect against the same adapter; the pass must
    // still walk history once and seed once, or the shared cursor would be
    // advanced past the gap.
    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(result.current.hasOlder).toBe(true);
    expect(result.current.chatTransport).toBe(fakeChatTransport);
    expect(fakeChatTransport.seed).toHaveBeenCalledTimes(1);
    expect(fakeChatTransport.seed).toHaveBeenCalledWith(gapEvents);
    expect(fakeTransport.historyCount).toBe(1);
  });

  it('walks to channel exhaustion when the store is empty and reports no older history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])));
    fakeTransport.historyBatches = [{ events: [userEvent('wire-u1', 'u1')], exhausted: true }];

    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.initialMessages.map((m) => m.id)).toEqual(['u1']);
    expect(result.current.hasOlder).toBe(false);
  });

  it('reports an error when the seed request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    const { result } = renderHook(() => useChatHydration({ channelName: 'ai:test' }), {
      wrapper: strictModeWrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    if (result.current.status !== 'error') throw new Error('expected error');
    expect(result.current.error.message).toContain('500');
    expect(fakeChatTransport.seed).not.toHaveBeenCalled();
  });
});
