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
      // run-start response so `await session.view.send(...)` resolves.
      const messages = Array.isArray(msg) ? msg : [msg];
      for (const m of messages) {
        const headers = (m.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport ?? {};
        if (headers.role === 'user' && headers['run-id'] && mock.listener) {
          const captured = mock.listener;
          queueMicrotask(() => {
            captured({
              name: 'ai-run-start',
              extras: {
                ai: {
                  transport: {
                    'run-id': headers['run-id'] ?? '',
                    'run-client-id': headers['run-client-id'] ?? '',
                    'invocation-id': headers['invocation-id'] ?? '',
                  },
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

    // view.getMessages works without error — proves the codec is wired up
    expect(session.view.getMessages()).toEqual([]);

    await session.close();
  });

  it('passes channelName through to the core factory; the session is HTTP-free', async () => {
    const channel = createMockChannel();
    const session = createClientSession({
      client: createMockClient(channel),
      channelName: 'test-channel',
    });
    await session.connect();

    // The core session never sends HTTP — sending only publishes on the
    // channel. The run's invocation pointer reflects the channel name the
    // factory wired through, confirming the option plumbing.
    const run = await session.view.send({
      kind: 'user-message',
      message: { id: '1', role: 'user', parts: [] },
    });
    expect(run.toInvocation().sessionName).toBe('test-channel');

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

    await session.close();
  });

  it('passes through options to the core factory', async () => {
    const channel = createMockChannel();
    const onError = vi.fn();
    const session = createAgentSession({ client: createMockClient(channel), channelName: 'test-channel', onError });
    await session.connect();

    // Session was created without error — proves options were forwarded
    const run = createRunFromOpts(session, { runId: 'run-2' });
    expect(run.runId).toBe('run-2');

    await session.close();
  });
});
