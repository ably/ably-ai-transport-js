/**
 * End-to-end integration tests: verify that stream errors from the core
 * transport propagate all the way through to useChat's status and onError.
 *
 * These tests exercise the full chain:
 *   ClientTransport (real Ably channel) → ChatTransport adapter → useChat
 *
 * Scenarios:
 * - POST failure → stream errors with TransportSendFailed → useChat status: error
 * - Channel detach mid-stream → stream errors with ChannelContinuityLost → useChat status: error
 */

// @vitest-environment jsdom
import { useChat } from '@ai-sdk/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import { createServerTransport } from '../../../src/core/transport/server-transport.js';
import type { ClientTransport, ServerTransport } from '../../../src/core/transport/types.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChat error propagation', () => {
  let serverTransport: ServerTransport<AI.UIMessageChunk, AI.UIMessage> | undefined;
  let clientTransport: ClientTransport<AI.UIMessageChunk, AI.UIMessage> | undefined;
  let chatTransport: ChatTransport | undefined;

  afterEach(async () => {
    await clientTransport?.close();
    clientTransport = undefined;
    serverTransport?.close();
    serverTransport = undefined;
    chatTransport = undefined;
    closeAllClients();
  });

  it('transitions to status: error and calls onError when POST fails', async () => {
    const channelName = uniqueChannelName('uc-post-fail');
    const clientClient = ablyRealtimeClient();
    const clientChannel = clientClient.channels.get(channelName);

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      api: 'http://localhost:1/nonexistent',
    });

    chatTransport = createChatTransport(clientTransport);

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

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    // Capture fetch calls so we can extract the turnId from the POST body.
    const fetchCalls: RequestInit[] = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- inline mock returns Promise.resolve directly
    const capturingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push(init ?? {});
      return Promise.resolve(new Response(undefined, { status: 200 }));
    }) as typeof globalThis.fetch;

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      api: '/api/chat',
      fetch: capturingFetch,
    });

    chatTransport = createChatTransport(clientTransport);

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

    // Extract turnId from the POST body sent by the transport.
    await waitFor(
      () => {
        expect(fetchCalls).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const firstCall = fetchCalls[0];
    if (!firstCall) throw new Error('expected fetch to have been called');
    // CAST: transport serialises the POST body as JSON containing turnId.
    const { turnId } = JSON.parse(firstCall.body as string) as { turnId: string };

    // Start a server turn that streams events but doesn't finish.
    // The stream stays open so we can detach the channel mid-stream.
    const serverTurn = serverTransport.newTurn({
      turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn.start();

    const openStream = new ReadableStream<AI.UIMessageChunk>({
      start: (c) => {
        c.enqueue({ type: 'start', messageId: 'asst-1' });
        c.enqueue({ type: 'start-step' });
        c.enqueue({ type: 'text-start', id: 'text-1' });
        c.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      },
    });
    // Fire-and-forget — the stream stays open indefinitely
    void serverTurn.streamResponse(openStream);

    // Poll the transport tree for streamed events. ChatTransport returns an
    // empty stream to useChat (useMessageSync handles message state separately),
    // so result.current.messages won't reflect streamed data. Polling at 50ms
    // (waitFor's default interval) is fine for an integration test.
    const ct = clientTransport;
    await waitFor(
      () => {
        const messages = ct.view.flattenNodes().map((n) => n.message);
        expect(messages.find((m) => m.role === 'assistant')).toBeDefined();
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
