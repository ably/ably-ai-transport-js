/**
 * End-to-end integration tests: verify that failures propagate all the way
 * through to useChat's status and onError.
 *
 * These tests exercise the full chain:
 *   ClientTransport (real Ably channel) → ChatTransport adapter → useChat
 *
 * Scenarios:
 * - POST failure → sendMessages rejects → useChat status: error
 * - Channel detach mid-stream → continuity loss errors the stream → useChat status: error
 */

// @vitest-environment jsdom
import { useChat } from '@ai-sdk/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentTransport, ClientTransport } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createAgentTransport, createClientTransport } from '../../../src/vercel/transport/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

describe('useChat error propagation', () => {
  let agentTransport: AgentTransport<VercelInput, VercelOutput> | undefined;
  let clientTransport: ClientTransport<VercelInput, VercelOutput> | undefined;
  let chatTransport: ChatTransport | undefined;

  afterEach(() => {
    chatTransport?.close();
    chatTransport = undefined;
    clientTransport?.close();
    clientTransport = undefined;
    agentTransport?.close();
    agentTransport = undefined;
    closeAllClients();
    vi.unstubAllGlobals();
  });

  it('transitions to status: error and calls onError when the POST fails', async () => {
    const channelName = uniqueChannelName('uc-post-fail');
    const clientClient = ablyRealtimeClient();

    clientTransport = createClientTransport({ channel: clientClient.channels.get(channelName) });
    await clientTransport.connect();

    // The adapter owns the agent-invocation POST — point it at a dead
    // endpoint so the POST fails and the useChat-facing send errors.
    chatTransport = createChatTransport({
      transport: clientTransport,
      channelName,
      api: 'http://localhost:1/nonexistent',
    });

    const onError = vi.fn();
    const { result } = renderHook(() => useChat({ id: 'test-post-fail', transport: chatTransport, onError }));

    expect(result.current.status).toBe('ready');

    // eslint-disable-next-line @typescript-eslint/require-await -- act() requires an async callback for React state updates
    await act(async () => {
      void result.current.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    });

    await waitFor(
      () => {
        expect(result.current.status).toBe('error');
      },
      { timeout: 10_000 },
    );

    expect(onError).toHaveBeenCalled();
  });

  it('transitions to status: error and calls onError when the channel is DETACHED mid-stream', async () => {
    const channelName = uniqueChannelName('uc-detach');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const clientChannel = clientClient.channels.get(channelName);

    agentTransport = createAgentTransport({ channel: serverClient.channels.get(channelName) });
    await agentTransport.connect();

    clientTransport = createClientTransport({ channel: clientChannel });
    await clientTransport.connect();

    // The adapter POSTs the invocation pointer; answer with the run id the
    // agent below opens, so the useChat stream tracks that run.
    const runId = 'run-detach-1';

    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/require-await -- mock resolves synchronously
      vi.fn(async () => Response.json({ runId }, { status: 200 })),
    );

    chatTransport = createChatTransport({ transport: clientTransport, channelName });

    const onError = vi.fn();
    const { result } = renderHook(() => useChat({ id: 'test-detach', transport: chatTransport, onError }));

    expect(result.current.status).toBe('ready');

    // eslint-disable-next-line @typescript-eslint/require-await -- act() requires an async callback for React state updates
    await act(async () => {
      void result.current.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    });

    // Start the agent's run and stream events without finishing, so the
    // channel can be detached mid-stream.
    const run = agentTransport.openRun({ runId });
    const openStream = new ReadableStream<AI.UIMessageChunk>({
      start: (c) => {
        c.enqueue({ type: 'start', messageId: 'asst-1' });
        c.enqueue({ type: 'start-step' });
        c.enqueue({ type: 'text-start', id: 'text-1' });
        c.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      },
    });
    // Fire-and-forget — the stream stays open indefinitely.
    void run.pipe(openStream);

    // The streamed delta reaches useChat's own message state through the
    // adapter's stream — no external sync involved.
    await waitFor(
      () => {
        expect(result.current.messages.some((m) => m.role === 'assistant')).toBe(true);
      },
      { timeout: 10_000 },
    );

    // Detach the channel mid-stream: continuity is lost, and the adapter
    // errors the open stream rather than leaving useChat stuck on streaming.
    await act(async () => {
      await clientChannel.detach();
    });

    await waitFor(
      () => {
        expect(result.current.status).toBe('error');
      },
      { timeout: 10_000 },
    );

    expect(onError).toHaveBeenCalled();
    expect(result.current.error?.message).toContain('channel continuity lost');
  });
});
