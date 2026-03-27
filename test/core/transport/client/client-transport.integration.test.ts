/**
 * ClientTransport integration tests.
 *
 * Validate the full client-side transport lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test pairs a ClientTransport (client)
 * with a ServerTransport (server) on the same channel to exercise the
 * send -> stream -> receive roundtrip end-to-end.
 *
 * These tests prove that the client transport correctly:
 * - Receives and decodes streamed responses from the server
 * - Accumulates streamed events into complete messages
 * - Tracks turn lifecycle (start, end) from the server
 * - Publishes cancel signals that the server receives
 * - Loads conversation history via decodeHistory
 * - Handles sequential and concurrent turns
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_TURN_ID,
} from '../../../../src/constants.js';
import { createClientTransport } from '../../../../src/core/transport/client/client-transport.js';
import type { ClientTransport } from '../../../../src/core/transport/client/types.js';
import { createServerTransport } from '../../../../src/core/transport/server/server-transport.js';
import type { ServerTransport } from '../../../../src/core/transport/server/types.js';
import type { TurnLifecycleEvent } from '../../../../src/core/transport/types.js';
import { UIMessageCodec } from '../../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../../helper/realtime-client.js';
import { textResponseStream } from '../../../integration/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drain a ReadableStream into an array.
 * @param stream - The stream to drain.
 * @returns All enqueued values.
 */
const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const results: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
};

/**
 * Wait for the client transport's message list to reach the expected length.
 * Polls via the 'message' event rather than setTimeout.
 * @param ct - The client transport.
 * @param expected - Target message count.
 * @param timeout - Max wait in ms (default 10000).
 * @returns A promise that resolves when the target count is reached.
 */
 
const waitForMessages = async (
  ct: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
  expected: number,
  timeout = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (ct.getMessages().length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${String(expected)} messages (got ${String(ct.getMessages().length)})`));
    }, timeout);
    const unsub = ct.on('message', () => {
      if (ct.getMessages().length >= expected) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

/**
 * Wait for a specific turn lifecycle event on the client transport.
 * @param ct - The client transport.
 * @param turnId - The turn ID to wait for.
 * @param type - The event type ('x-ably-turn-start' or 'x-ably-turn-end').
 * @param timeout - Max wait in ms (default 10000).
 * @returns The matching turn lifecycle event.
 */
 
const waitForTurnEvent = async (
  ct: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
  turnId: string,
  type: string,
  timeout = 10_000,
): Promise<TurnLifecycleEvent> =>
  new Promise<TurnLifecycleEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${type} on turn ${turnId}`));
    }, timeout);
    const unsub = ct.on('turn', (event) => {
      if (event.turnId === turnId && event.type === type) {
        clearTimeout(timer);
        unsub();
        resolve(event);
      }
    });
  });

/**
 * No-op fetch that always returns 200. The integration tests exercise the
 * Ably channel path, not the HTTP POST path — the server transport receives
 * messages directly rather than via an HTTP handler.
 * @returns A 200 Response.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
const noopFetch = () => Promise.resolve(new Response(undefined, { status: 200 }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientTransport integration', () => {
  let serverTransport: ServerTransport<AI.UIMessageChunk, AI.UIMessage> | undefined;
  let clientTransport: ClientTransport<AI.UIMessageChunk, AI.UIMessage> | undefined;

  afterEach(async () => {
    await clientTransport?.close();
    clientTransport = undefined;
    serverTransport?.close();
    serverTransport = undefined;
    closeAllClients();
  });

  /**
   * Scenario: Full send -> stream -> receive roundtrip.
   *
   * The client sends a message via send(), which optimistically inserts it.
   * The server picks up the turnId and streams an assistant response.
   * The client receives the streamed events, accumulates them into a
   * complete message, and provides both messages via getMessages().
   */
  it('receives a streamed text response and accumulates it into a message', async () => {
    const channelName = uniqueChannelName('ct-roundtrip');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Client sends a user message — optimistically inserted, gets a turn stream
    const clientTurn = await clientTransport.send({
      id: 'user-msg-rt-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello!' }],
    });

    // Optimistic user message should be in the tree
    expect(clientTransport.getMessages()).toHaveLength(1);

    // Server handles the turn using the client's turnId
    const serverTurn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn.start();

    const stream = textResponseStream('asst-msg-rt-1', 'text-rt-1', 'Hello, how can I help?');
    await serverTurn.streamResponse(stream);
    await serverTurn.end('complete');

    // Drain the client stream — events should include finish
    const events = await drain(clientTurn.stream);
    const types = events.map((e) => e.type);
    expect(types).toContain('finish');

    // After the stream completes, the assistant message should be accumulated
    // Wait briefly for the accumulator to process all events
    await waitForMessages(clientTransport, 2);

    const messages = clientTransport.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // Verify user message (optimistic)
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const userTextPart = userMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(userTextPart?.text).toBe('Hello!');

    // Verify assistant message with accumulated text
    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const asstTextPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(asstTextPart?.text).toBe('Hello, how can I help?');
  });

  /**
   * Scenario: Client receives the event stream for its own turn.
   *
   * When the client sends a message, it gets back a ReadableStream of events.
   * Those events should contain the decoded UIMessageChunks from the server's
   * streamed response.
   */
  it('routes streamed events to the own-turn ReadableStream', async () => {
    const channelName = uniqueChannelName('ct-stream');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Client initiates a send — gets back a turn with a stream
    const clientTurn = await clientTransport.send({
      id: 'user-msg-stream-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Test' }],
    });

    // Server handles the turn (using the same turnId the client generated)
    const serverTurn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn.start();

    const stream = textResponseStream('asst-msg-stream-1', 'text-stream-1', 'Server response');
    await serverTurn.streamResponse(stream);
    await serverTurn.end('complete');

    // Drain the client's event stream
    const events = await drain(clientTurn.stream);

    // Should contain text deltas and finish
    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');
  });

  /**
   * Scenario: Turn lifecycle events are received by the client.
   *
   * The client sends a message, the server handles it, and the client
   * observes turn-start and turn-end events via on('turn').
   */
  it('tracks turn lifecycle events from the server', async () => {
    const channelName = uniqueChannelName('ct-lifecycle');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    const turnEvents: TurnLifecycleEvent[] = [];
    clientTransport.on('turn', (e) => turnEvents.push(e));

    // Client sends — ensures channel is attached
    const clientTurn = await clientTransport.send({
      id: 'user-lc-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });

    // Set up event listeners BEFORE server publishes
    const startPromise = waitForTurnEvent(clientTransport, clientTurn.turnId, EVENT_TURN_START);
    const endPromise = waitForTurnEvent(clientTransport, clientTurn.turnId, EVENT_TURN_END);

    // Server handles the turn
    const turn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await turn.start();

    // Wait for the client to see turn-start
    await startPromise;

    const activeBefore = clientTransport.getActiveTurnIds();
    expect(activeBefore.size).toBeGreaterThan(0);

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await turn.streamResponse(stream);
    await turn.end('complete');

    // Wait for the client to see turn-end
    await endPromise;

    expect(turnEvents.some((e) => e.type === EVENT_TURN_START && e.turnId === clientTurn.turnId)).toBe(true);
    expect(turnEvents.some((e) => e.type === EVENT_TURN_END && e.turnId === clientTurn.turnId)).toBe(true);
  });

  /**
   * Scenario: Cancel chain — client publishes cancel, server stream aborts.
   *
   * The client calls cancel() which publishes a cancel message to the channel.
   * The server transport receives it and aborts the in-progress stream.
   */
  it('client cancel aborts the server stream', async () => {
    const channelName = uniqueChannelName('ct-cancel');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Client initiates a send
    const clientTurn = await clientTransport.send({
      id: 'user-msg-cancel-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Long request' }],
    });

    // Server starts a long-running stream (never closes naturally)
    const serverTurn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn.start();

    const longStream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'asst-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = serverTurn.streamResponse(longStream);

    // Give the stream time to publish some events
    await new Promise((r) => setTimeout(r, 500));

    // Client cancels the turn
    await clientTransport.cancel({ turnId: clientTurn.turnId });

    // Server stream should abort
    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(serverTurn.abortSignal.aborted).toBe(true);

    await serverTurn.end('cancelled');
  });

  /**
   * Scenario: Multi-turn sequential.
   *
   * Two turns run sequentially. The client sends and receives both.
   */
  it('handles sequential turns', async () => {
    const channelName = uniqueChannelName('ct-seq');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Turn 1: client sends, server streams response
    const clientTurn1 = await clientTransport.send({
      id: 'user-seq-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Q1' }],
    });

    const serverTurn1 = serverTransport.newTurn({
      turnId: clientTurn1.turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn1.start();
    await serverTurn1.streamResponse(textResponseStream('asst-seq-1', 'text-seq-1', 'Answer 1'));
    await serverTurn1.end('complete');

    await drain(clientTurn1.stream);
    await waitForMessages(clientTransport, 2);

    // Turn 2: client sends again, server streams response
    const clientTurn2 = await clientTransport.send({
      id: 'user-seq-2',
      role: 'user',
      parts: [{ type: 'text', text: 'Q2' }],
    });

    const serverTurn2 = serverTransport.newTurn({
      turnId: clientTurn2.turnId,
      clientId: clientClient.auth.clientId,
    });
    await serverTurn2.start();
    await serverTurn2.streamResponse(textResponseStream('asst-seq-2', 'text-seq-2', 'Answer 2'));
    await serverTurn2.end('complete');

    await drain(clientTurn2.stream);
    await waitForMessages(clientTransport, 4);

    const messages = clientTransport.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(4);

    // Both assistant messages are present
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
  });

  /**
   * Scenario: History hydration via decodeHistory.
   *
   * A server streams a complete turn, then a new client loads history
   * and sees the completed messages.
   */
  it('loads history from the channel', async () => {
    const channelName = uniqueChannelName('ct-history');
    const serverClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const observerChannel = observerClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    // Subscribe an observer to confirm messages are persisted before loading history
    const turnEndSeen = new Promise<void>((resolve) => {
      void observerChannel.subscribe((msg) => {
        if (msg.name === EVENT_TURN_END) resolve();
      });
    });

    // Stream a complete turn first
    const turn = serverTransport.newTurn({ turnId: 'turn-hist-1', clientId: 'user-d' });
    await turn.start();
    await turn.addMessages([{
      message: { id: 'user-hist-1', role: 'user', parts: [{ type: 'text', text: 'History question' }] },
    }]);
    await turn.streamResponse(textResponseStream('asst-hist-1', 'text-hist-1', 'History answer'));
    await turn.end('complete');

    // Wait for the turn-end to arrive on a separate subscriber — confirms persistence
    await turnEndSeen;

    // New client connects and loads history
    const historyClient = ablyRealtimeClient();
    const historyChannel = historyClient.channels.get(channelName);

    clientTransport = createClientTransport({
      channel: historyChannel,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    const page = await clientTransport.history({ limit: 10 });

    // History should contain the completed messages
    expect(page.items.length).toBeGreaterThanOrEqual(1);

    // The messages should also appear in getMessages() after history load
    const messages = clientTransport.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Verify the assistant message has the correct text
    const asstMsg = messages.find((m) => m.role === 'assistant');
    if (asstMsg) {
      const textPart = asstMsg.parts.find((p): p is AI.TextUIPart => p.type === 'text');
      expect(textPart?.text).toBe('History answer');
    }
  });

  /**
   * Scenario: Raw Ably messages are accumulated.
   *
   * The client transport records all raw Ably messages received, accessible
   * via getAblyMessages().
   */
  it('accumulates raw Ably messages', async () => {
    const channelName = uniqueChannelName('ct-raw');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Client sends to ensure attachment
    const clientTurn = await clientTransport.send({
      id: 'user-raw-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });

    // Set up event listener BEFORE server publishes
    const endPromise = waitForTurnEvent(clientTransport, clientTurn.turnId, EVENT_TURN_END);

    const turn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await turn.start();
    await turn.streamResponse(textResponseStream('asst-raw-1', 'text-raw-1', 'test'));
    await turn.end('complete');

    // Wait for turn-end to arrive
    await endPromise;

    const rawMessages = clientTransport.getAblyMessages();
    expect(rawMessages.length).toBeGreaterThan(0);

    // Should include turn-start, encoded messages, and turn-end
    const names = rawMessages.map((m) => m.name);
    expect(names).toContain(EVENT_TURN_START);
    expect(names).toContain(EVENT_TURN_END);
  });

  /**
   * Scenario: Message headers are accessible via getMessageHeaders.
   *
   * After the client sends and the server streams, the client can
   * retrieve transport headers (role, turn-id, msg-id) for messages.
   */
  it('provides message headers from the conversation tree', async () => {
    const channelName = uniqueChannelName('ct-headers');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const clientChannel = clientClient.channels.get(channelName);

    serverTransport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    clientTransport = createClientTransport({
      channel: clientChannel,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
    });

    // Client sends user message
    const clientTurn = await clientTransport.send({
      id: 'user-hdr-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Question' }],
    });

    // Server streams response
    const turn = serverTransport.newTurn({
      turnId: clientTurn.turnId,
      clientId: clientClient.auth.clientId,
    });
    await turn.start();
    await turn.streamResponse(textResponseStream('asst-hdr-1', 'text-hdr-1', 'Answer'));
    await turn.end('complete');

    await drain(clientTurn.stream);
    await waitForMessages(clientTransport, 2);

    const messages = clientTransport.getMessages();
    const userMsg = messages.find((m) => m.role === 'user');
    const asstMsg = messages.find((m) => m.role === 'assistant');

    expect(userMsg).toBeDefined();
    expect(asstMsg).toBeDefined();

    if (userMsg) {
      const userHeaders = clientTransport.getMessageHeaders(userMsg);
      expect(userHeaders).toBeDefined();
      expect(userHeaders?.[HEADER_ROLE]).toBe('user');
      expect(userHeaders?.[HEADER_TURN_ID]).toBe(clientTurn.turnId);
      expect(userHeaders?.[HEADER_MSG_ID]).toBeDefined();
    }

    if (asstMsg) {
      const asstHeaders = clientTransport.getMessageHeaders(asstMsg);
      expect(asstHeaders).toBeDefined();
      expect(asstHeaders?.[HEADER_TURN_ID]).toBe(clientTurn.turnId);
    }
  });
});
