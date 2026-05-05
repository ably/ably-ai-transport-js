import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSession, createClientSession } from '../../../src/vercel/transport/index.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';

// ---------------------------------------------------------------------------
// Mock channel
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    // Default to 'attached' so send() doesn't reject — it requires the
    // channel to be ATTACHED or ATTACHING.
    state: 'attached',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    publish: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    subscribe: vi.fn(() => Promise.resolve()),
    unsubscribe: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const emptyPage = { items: [], hasNext: () => false, next: () => Promise.resolve(emptyPage) };
      return Promise.resolve(emptyPage);
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe/on/off/attach/history — other members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Vercel createClientSession', () => {
  it('returns a functional ClientSession with UIMessageCodec pre-bound', async () => {
    const channel = createMockChannel();
    const session = createClientSession({ channel });

    // view.flattenNodes works without error — proves the codec is wired up
    expect(session.view.flattenNodes()).toEqual([]);

    await session.close();
  });

  it('defaults api to /api/chat when not specified', async () => {
    const channel = createMockChannel();
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const mockFetch = vi.fn(() => Promise.resolve(new Response(undefined, { status: 200 })));
    const session = createClientSession({
      channel,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
    await session.connect();

    await session.view.send({ id: '1', role: 'user', parts: [] });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chat');

    await session.close();
  });

  it('passes through all options to the core factory', async () => {
    const channel = createMockChannel();
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const mockFetch = vi.fn(() => Promise.resolve(new Response(undefined, { status: 200 })));
    const session = createClientSession({
      channel,
      clientId: 'user-1',
      api: '/api/custom',
      headers: { Authorization: 'Bearer token' },
      credentials: 'include',
      fetch: mockFetch,
    });
    await session.connect();

    // send() triggers a POST to the configured api endpoint with the configured fetch
    const sendPromise = session.view.send({ id: '1', role: 'user', parts: [] });
    const run = await sendPromise;

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
    expect(body.runId).toBe(run.runId);

    await session.close();
  });
});

describe('Vercel createAgentSession', () => {
  it('returns a functional AgentSession with UIMessageCodec pre-bound', async () => {
    const channel = createMockChannel();
    const session = createAgentSession({ channel });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'test-run' });
    expect(run.runId).toBe('test-run');

    session.close();
  });

  it('passes through options to the core factory', async () => {
    const channel = createMockChannel();
    const onError = vi.fn();
    const session = createAgentSession({ channel, onError });
    await session.connect();

    // Session was created without error — proves options were forwarded
    const run = createRunFromOpts(session, { runId: 'run-2', clientId: 'user-1' });
    expect(run.runId).toBe('run-2');

    session.close();
  });
});
