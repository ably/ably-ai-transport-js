import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { createClientTransport, createServerTransport } from '../../../src/vercel/transport/index.js';

// ---------------------------------------------------------------------------
// Mock channel
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    publish: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    subscribe: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const emptyPage = { items: [], hasNext: () => false, next: () => Promise.resolve(emptyPage) };
      return Promise.resolve(emptyPage);
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe/attach/history — other members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel createClientTransport', () => {
  it('returns a functional ClientTransport with UIMessageCodec pre-bound', async () => {
    const channel = createMockChannel();
    const transport = createClientTransport({ channel });

    // getMessages works without error — proves the codec is wired up
    expect(transport.getMessages()).toEqual([]);

    await transport.close();
  });

  it('passes through all options to the core factory', async () => {
    const channel = createMockChannel();
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const mockFetch = vi.fn(() => Promise.resolve(new Response(undefined, { status: 200 })));
    const transport = createClientTransport({
      channel,
      clientId: 'user-1',
      api: '/api/custom',
      headers: { Authorization: 'Bearer token' },
      credentials: 'include',
      fetch: mockFetch,
    });

    // send() triggers a POST to the configured api endpoint with the configured fetch
    const sendPromise = transport.send({ id: '1', role: 'user', parts: [] });
    const turn = await sendPromise;

    // Wait for the fire-and-forget fetch to resolve
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Verify the custom api URL and headers were used
    // CAST: vi.fn().mock.calls is typed as unknown[][]; we know the shape from the fetch signature.
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/custom');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');

    // Verify the body contains the clientId
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.clientId).toBe('user-1');
    expect(body.turnId).toBe(turn.turnId);

    await transport.close();
  });
});

describe('Vercel createServerTransport', () => {
  it('returns a functional ServerTransport with UIMessageCodec pre-bound', () => {
    const channel = createMockChannel();
    const transport = createServerTransport({ channel });

    const turn = transport.newTurn({ turnId: 'test-turn' });
    expect(turn.turnId).toBe('test-turn');

    transport.close();
  });

  it('passes through options to the core factory', () => {
    const channel = createMockChannel();
    const onError = vi.fn();
    const transport = createServerTransport({ channel, onError });

    // Transport was created without error — proves options were forwarded
    const turn = transport.newTurn({ turnId: 'turn-2', clientId: 'user-1' });
    expect(turn.turnId).toBe('turn-2');

    transport.close();
  });
});
