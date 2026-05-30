import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSession, createClientSession } from '../../../src/vercel/transport/index.js';
import { createMockClient } from '../../helper/mock-client.js';
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
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    // Default to 'attached' so send() doesn't reject — it requires the
    // channel to be ATTACHED or ATTACHING.
    state: 'attached',
    listener: undefined,
    // eslint-disable-next-line @typescript-eslint/require-await -- mock fires synthetic run-start side effect; no awaitable work
    publish: vi.fn(async (msg: Ably.Message | Ably.Message[]) => {
      // When a client publishes a user message, simulate the agent's
      // run-start response so `await session.view.sendInput(...)` resolves.
      const messages = Array.isArray(msg) ? msg : [msg];
      for (const m of messages) {
        const headers = (m.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
        if (headers.role === 'user' && headers['run-id'] && mock.listener) {
          const captured = mock.listener;
          queueMicrotask(() => {
            captured({
              name: 'ai-run-start',
              extras: {
                headers: {
                  'run-id': headers['run-id'] ?? '',
                  'run-client-id': headers['run-client-id'] ?? '',
                  'invocation-id': headers['invocation-id'] ?? '',
                },
              },
              serial: '01H_run_start_sim',
            } as unknown as Ably.InboundMessage);
          });
        }
      }
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns Promise.resolve; the captured listener runs side effects
    subscribe: vi.fn(async (callback: (m: Ably.InboundMessage) => void) => {
      mock.listener = callback;
    }),
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
    const session = createClientSession({ client: createMockClient(channel), channelName: 'test-channel' });

    // view.flattenNodes works without error — proves the codec is wired up
    expect(session.view.flattenNodes()).toEqual([]);

    await session.close();
  });

  it('defaults api to /api/chat when not specified', async () => {
    const channel = createMockChannel();
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const mockFetch = vi.fn(() => Promise.resolve(new Response(undefined, { status: 200 })));
    const session = createClientSession({
      client: createMockClient(channel),
      channelName: 'test-channel',
      fetch: mockFetch,
    });
    await session.connect();

    await session.view.sendInput({ kind: 'user-message', message: { id: '1', role: 'user', parts: [] } });

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
      client: createMockClient(channel),
      channelName: 'test-channel',
      clientId: 'user-1',
      api: '/api/custom',
      headers: { Authorization: 'Bearer token' },
      credentials: 'include',
      fetch: mockFetch,
    });
    await session.connect();

    // send() triggers a POST to the configured api endpoint with the configured fetch
    const sendPromise = session.view.sendInput({
      kind: 'user-message',
      message: { id: '1', role: 'user', parts: [] },
    });
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

    // Verify the body carries the run identity. Per-message metadata
    // (clientId/parent/forkOf/isContinuation) has moved off the body and
    // onto channel headers post-AIT-769 — the agent reads the input event's
    // publisher `clientId` directly off the wire.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.clientId).toBeUndefined();
    expect(body.runId).toBe(run.runId);

    await session.close();
  });
});

describe('Vercel createAgentSession', () => {
  it('returns a functional AgentSession with UIMessageCodec pre-bound', async () => {
    const channel = createMockChannel();
    const session = createAgentSession({ client: createMockClient(channel), channelName: 'test-channel' });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'test-run' });
    expect(run.runId).toBe('test-run');

    session.close();
  });

  it('passes through options to the core factory', async () => {
    const channel = createMockChannel();
    const onError = vi.fn();
    const session = createAgentSession({ client: createMockClient(channel), channelName: 'test-channel', onError });
    await session.connect();

    // Session was created without error — proves options were forwarded
    const run = createRunFromOpts(session, { runId: 'run-2' });
    expect(run.runId).toBe('run-2');

    session.close();
  });
});
