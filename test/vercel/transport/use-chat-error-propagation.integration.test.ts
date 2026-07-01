/**
 * End-to-end integration tests: verify that stream errors from the core
 * session propagate all the way through to useChat's status and onError.
 *
 * These tests exercise the full chain:
 *   ClientSession (real Ably channel) → ChatTransport adapter → useChat
 *
 * Scenarios:
 * - POST failure → stream errors with SessionSendFailed → useChat status: error
 * - Channel detach mid-stream → stream errors with ChannelContinuityLost → useChat status: error
 */

// @vitest-environment jsdom
import { useChat } from '@ai-sdk/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import type { AgentSession, ClientSession } from '../../../src/core/transport/types.js';
import {
  UIMessageCodec,
  type VercelInput,
  type VercelOutput,
  type VercelProjection,
} from '../../../src/vercel/codec/index.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChat error propagation', () => {
  let agentSession: AgentSession<VercelOutput, VercelProjection, AI.UIMessage> | undefined;
  let clientSession: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage> | undefined;
  let chatTransport: ChatTransport | undefined;

  afterEach(async () => {
    await clientSession?.close();
    clientSession = undefined;
    await agentSession?.detach();
    agentSession = undefined;
    chatTransport = undefined;
    closeAllClients();
  });

  it('transitions to status: error and calls onError when POST fails', async () => {
    const channelName = uniqueChannelName('uc-post-fail');
    const clientClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
    });
    await clientSession.connect();

    // The transport owns the agent-invocation POST — point it at a dead
    // endpoint so the POST fails and the useChat-facing stream errors.
    chatTransport = createChatTransport(clientSession, { api: 'http://localhost:1/nonexistent' });

    const onError = vi.fn();

    const { result } = renderHook(() =>
      useChat({
        id: 'test-post-fail',
        transport: chatTransport,
        onError,
      }),
    );

    expect(result.current.status).toBe('ready');

    // eslint-disable-next-line @typescript-eslint/require-await -- act() requires async callback for React state updates
    await act(async () => {
      void result.current.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      });
    });

    await waitFor(
      () => {
        expect(result.current.status).toBe('error');
      },
      { timeout: 10_000 },
    );

    expect(onError).toHaveBeenCalled();
    expect(result.current.error?.message).toContain('unable to send');
  });

  it('transitions to status: error and calls onError when channel is DETACHED mid-stream', async () => {
    const channelName = uniqueChannelName('uc-detach');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const clientChannel = clientClient.channels.get(channelName);

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Tests use the runId-coordination pattern (invocationId from the
      // client doesn't reach the test-driven serverRun), so skip the
      // channel input-event lookup entirely.
    });
    await agentSession.connect();

    // Capture the transport's invocation POST so we can extract the runId.
    const fetchCalls: RequestInit[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- inline mock returns Promise.resolve directly
    const capturingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(init ?? {});
      return Promise.resolve(new Response(undefined, { status: 200 }));
    }) as typeof globalThis.fetch;

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
    });
    await clientSession.connect();

    // The transport POSTs the invocation; capture it to read the runId, and
    // succeed (status 200) so the run proceeds and we can detach mid-stream.
    chatTransport = createChatTransport(clientSession, { api: '/api/chat', fetch: capturingFetch });

    const onError = vi.fn();

    const { result } = renderHook(() =>
      useChat({
        id: 'test-detach',
        transport: chatTransport,
        onError,
      }),
    );

    expect(result.current.status).toBe('ready');

    // eslint-disable-next-line @typescript-eslint/require-await -- act() requires async callback for React state updates
    await act(async () => {
      void result.current.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      });
    });

    // Extract runId from the POST body sent by the session.
    await waitFor(
      () => {
        expect(fetchCalls).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const firstCall = fetchCalls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    // CAST: session serialises the POST body as JSON containing runId.
    const { runId } = JSON.parse(firstCall.body as string) as { runId: string };

    // Start a server run that streams events but doesn't finish.
    // The stream stays open so we can detach the channel mid-stream.
    const serverRun = createRunFromOpts(agentSession, {
      runId,
    });
    await serverRun.start();

    const openStream = new ReadableStream<AI.UIMessageChunk>({
      start: (c) => {
        c.enqueue({ type: 'start', messageId: 'asst-1' });
        c.enqueue({ type: 'start-step' });
        c.enqueue({ type: 'text-start', id: 'text-1' });
        c.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      },
    });
    // Fire-and-forget — the stream stays open indefinitely
    void serverRun.pipe(openStream);

    // Poll the session tree for streamed events. ChatTransport returns an
    // empty stream to useChat (useMessageSync handles message state separately),
    // so result.current.messages won't reflect streamed data. Polling at 50ms
    // (waitFor's default interval) is fine for an integration test.
    const ct = clientSession;
    await waitFor(
      () => {
        const messages = ct.view.getMessages();
        expect(messages.find((m) => m.message.role === 'assistant')).toBeDefined();
      },
      { timeout: 10_000 },
    );

    // Detach the channel mid-stream
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
