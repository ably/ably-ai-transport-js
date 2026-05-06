/**
 * ClientSession integration tests.
 *
 * Validate the full client-side session lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test pairs a ClientSession (client)
 * with a AgentSession (server) on the same channel to exercise the
 * send -> stream -> receive roundtrip end-to-end.
 *
 * These tests prove that the client session correctly:
 * - Receives and decodes streamed responses from the server
 * - Accumulates streamed events into complete messages
 * - Tracks run lifecycle (start, end) from the server
 * - Publishes cancel signals that the server receives
 * - Loads conversation history via decodeHistory
 * - Handles sequential and concurrent runs
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { EVENT_RUN_END, EVENT_RUN_START, HEADER_MSG_ID, HEADER_ROLE, HEADER_RUN_ID } from '../../../src/constants.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import type { AgentSession, ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

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
 * Wait for the client session's visible message list to reach the expected length.
 * Polls via the view's 'update' event rather than setTimeout.
 * @param ct - The client session.
 * @param expected - Target message count.
 * @param timeout - Max wait in ms (default 10000).
 * @returns A promise that resolves when the target count is reached.
 */

const waitForMessages = async (
  ct: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  expected: number,
  timeout = 10_000,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (ct.view.flattenNodes().length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(`timed out waiting for ${String(expected)} messages (got ${String(ct.view.flattenNodes().length)})`),
      );
    }, timeout);
    const unsub = ct.view.on('update', () => {
      if (ct.view.flattenNodes().length >= expected) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

/**
 * Wait for a specific run lifecycle event on the client session.
 * @param ct - The client session.
 * @param runId - The run IDs to wait for.
 * @param type - The event type ('x-ably-run-start' or 'x-ably-run-end').
 * @param timeout - Max wait in ms (default 10000).
 * @returns The matching run lifecycle event.
 */

const waitForRunEvent = async (
  ct: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  runId: string,
  type: string,
  timeout = 10_000,
): Promise<RunLifecycleEvent> =>
  new Promise<RunLifecycleEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${type} on run ${runId}`));
    }, timeout);
    const unsub = ct.tree.on('run', (event) => {
      if (event.runId === runId && event.type === type) {
        clearTimeout(timer);
        unsub();
        resolve(event);
      }
    });
  });

/**
 * No-op fetch that always returns 200. The integration tests exercise the
 * Ably channel path, not the HTTP POST path — the agent session receives
 * messages directly rather than via an HTTP handler.
 * @returns A 200 Response.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
const noopFetch = () => Promise.resolve(new Response(undefined, { status: 200 }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSession integration', () => {
  let agentSession: AgentSession<AI.UIMessageChunk, AI.UIMessage> | undefined;
  let clientSession: ClientSession<AI.UIMessageChunk, AI.UIMessage> | undefined;

  afterEach(async () => {
    await clientSession?.close();
    clientSession = undefined;
    agentSession?.close();
    agentSession = undefined;
    closeAllClients();
  });

  /**
   * Scenario: Full send -> stream -> receive roundtrip.
   *
   * The client sends a message via send(), which optimistically inserts it.
   * The server picks up the runId and streams an assistant response.
   * The client receives the streamed events, accumulates them into a
   * complete message, and provides both messages via getMessages().
   */
  it('receives a streamed text response and accumulates it into a message', async () => {
    const channelName = uniqueChannelName('ct-roundtrip');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Client sends a user message — optimistically inserted, gets a run stream
    const clientRun = await clientSession.view.send({
      id: 'user-msg-rt-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello!' }],
    });

    // Optimistic user message should be in the tree
    expect(clientSession.view.flattenNodes().map((n) => n.message)).toHaveLength(1);

    // Server handles the run using the client's runId
    const serverRun = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();

    const stream = textResponseStream('asst-msg-rt-1', 'text-rt-1', 'Hello, how can I help?');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    // Drain the client stream — events should include finish
    const events = await drain(clientRun.stream);
    const types = events.map((e) => e.type);
    expect(types).toContain('finish');

    // After the stream completes, the assistant message should be accumulated
    // Wait briefly for the accumulator to process all events
    await waitForMessages(clientSession, 2);

    const messages = clientSession.view.flattenNodes().map((n) => n.message);
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
   * Scenario: Client receives the event stream for its own run.
   *
   * When the client sends a message, it gets back a ReadableStream of events.
   * Those events should contain the decoded UIMessageChunks from the server's
   * streamed response.
   */
  it('routes streamed events to the own-run ReadableStream', async () => {
    const channelName = uniqueChannelName('ct-stream');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Client initiates a send — gets back a run with a stream
    const clientRun = await clientSession.view.send({
      id: 'user-msg-stream-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Test' }],
    });

    // Server handles the run (using the same runId the client generated)
    const serverRun = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();

    const stream = textResponseStream('asst-msg-stream-1', 'text-stream-1', 'Server response');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    // Drain the client's event stream
    const events = await drain(clientRun.stream);

    // Should contain text deltas and finish
    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');
  });

  /**
   * Scenario: Run lifecycle events are received by the client.
   *
   * The client sends a message, the server handles it, and the client
   * observes run-start and run-end events via on('run').
   */
  it('tracks run lifecycle events from the server', async () => {
    const channelName = uniqueChannelName('ct-lifecycle');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    const runEvents: RunLifecycleEvent[] = [];
    clientSession.tree.on('run', (e) => runEvents.push(e));

    // Client sends — ensures channel is attached
    const clientRun = await clientSession.view.send({
      id: 'user-lc-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });

    // Set up event listeners BEFORE server publishes
    const startPromise = waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_START);
    const endPromise = waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_END);

    // Server handles the run
    const run = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();

    // Wait for the client to see run-start
    await startPromise;

    const activeBefore = clientSession.tree.getActiveRunIds();
    expect(activeBefore.size).toBeGreaterThan(0);

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await run.pipe(stream);
    await run.end('complete');

    // Wait for the client to see run-end
    await endPromise;

    expect(runEvents.some((e) => e.type === EVENT_RUN_START && e.runId === clientRun.runId)).toBe(true);
    expect(runEvents.some((e) => e.type === EVENT_RUN_END && e.runId === clientRun.runId)).toBe(true);
  });

  /**
   * Scenario: Cancel chain — client publishes cancel, server stream aborts.
   *
   * The client calls cancel() which publishes a cancel message to the channel.
   * The agent session receives it and aborts the in-progress stream.
   */
  it('client cancel aborts the server stream', async () => {
    const channelName = uniqueChannelName('ct-cancel');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Client initiates a send
    const clientRun = await clientSession.view.send({
      id: 'user-msg-cancel-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Long request' }],
    });

    // Server starts a long-running stream (never closes naturally)
    const serverRun = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();

    const longStream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'asst-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = serverRun.pipe(longStream);

    // Give the stream time to publish some events
    await new Promise((r) => setTimeout(r, 500));

    // Client cancels the run
    await clientSession.cancel({ runId: clientRun.runId });

    // Server stream should abort
    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(serverRun.abortSignal.aborted).toBe(true);

    await serverRun.end('cancelled');
  });

  /**
   * Scenario: Multi-run sequential.
   *
   * Two runs run sequentially. The client sends and receives both.
   */
  it('handles sequential runs', async () => {
    const channelName = uniqueChannelName('ct-seq');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Run 1: client sends, server streams response
    const clientRun1 = await clientSession.view.send({
      id: 'user-seq-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Q1' }],
    });

    const serverRun1 = createRunFromOpts(agentSession, {
      runId: clientRun1.runId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun1.start();
    await serverRun1.pipe(textResponseStream('asst-seq-1', 'text-seq-1', 'Answer 1'));
    await serverRun1.end('complete');

    await drain(clientRun1.stream);
    await waitForMessages(clientSession, 2);

    // Run 2: client sends again, server streams response
    const clientRun2 = await clientSession.view.send({
      id: 'user-seq-2',
      role: 'user',
      parts: [{ type: 'text', text: 'Q2' }],
    });

    const serverRun2 = createRunFromOpts(agentSession, {
      runId: clientRun2.runId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun2.start();
    await serverRun2.pipe(textResponseStream('asst-seq-2', 'text-seq-2', 'Answer 2'));
    await serverRun2.end('complete');

    await drain(clientRun2.stream);
    await waitForMessages(clientSession, 4);

    const messages = clientSession.view.flattenNodes().map((n) => n.message);
    expect(messages.length).toBeGreaterThanOrEqual(4);

    // Both assistant messages are present
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
  });

  /**
   * Scenario: History hydration via decodeHistory.
   *
   * A server streams a complete run, then a new client loads history
   * and sees the completed messages.
   */
  it('loads history from the channel', async () => {
    const channelName = uniqueChannelName('ct-history');
    const serverClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();

    const observerChannel = observerClient.channels.get(channelName);

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    // Subscribe an observer to confirm messages are persisted before loading history
    const runEndSeen = new Promise<void>((resolve) => {
      void observerChannel.subscribe((msg) => {
        if (msg.name === EVENT_RUN_END) resolve();
      });
    });

    // Stream a complete run first
    const run = createRunFromOpts(agentSession, { runId: 'run-hist-1', clientId: 'user-d' });
    await run.start();
    await run.addMessages([
      {
        kind: 'message',
        message: { id: 'user-hist-1', role: 'user', parts: [{ type: 'text', text: 'History question' }] },
        msgId: crypto.randomUUID(),
        parentId: undefined,
        forkOf: undefined,
        headers: {},
        serial: undefined,
      },
    ]);
    await run.pipe(textResponseStream('asst-hist-1', 'text-hist-1', 'History answer'));
    await run.end('complete');

    // Wait for the run-end to arrive on a separate subscriber — confirms persistence
    await runEndSeen;

    // New client connects and loads history
    const historyClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    await clientSession.view.loadOlder(10);

    // After loading history, the messages should appear in the view
    const messages = clientSession.view.flattenNodes().map((n) => n.message);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Verify the assistant message has the correct text
    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const textPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('History answer');
  });

  /**
   * Scenario: Raw Ably messages are received via tree.on('ably-message').
   *
   * The client session fires ably-message events for all raw Ably messages
   * received on the channel.
   */
  it('fires ably-message events for raw Ably messages', async () => {
    const channelName = uniqueChannelName('ct-raw');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Collect raw Ably messages via the tree event
    const rawMessages: Ably.InboundMessage[] = [];
    clientSession.tree.on('ably-message', (msg) => rawMessages.push(msg));

    // Client sends to ensure attachment
    const clientRun = await clientSession.view.send({
      id: 'user-raw-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });

    // Set up event listener BEFORE server publishes
    const endPromise = waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_END);

    const run = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();
    await run.pipe(textResponseStream('asst-raw-1', 'text-raw-1', 'test'));
    await run.end('complete');

    // Wait for run-end to arrive
    await endPromise;

    expect(rawMessages.length).toBeGreaterThan(0);

    // Should include run-start, encoded messages, and run-end
    const names = rawMessages.map((m) => m.name);
    expect(names).toContain(EVENT_RUN_START);
    expect(names).toContain(EVENT_RUN_END);
  });

  /**
   * Scenario: Conversation nodes are accessible via tree.flattenNodes().
   *
   * After the client sends and the server streams, the client can
   * retrieve full conversation nodes with transport headers and typed fields.
   */
  it('provides conversation nodes from the tree', async () => {
    const channelName = uniqueChannelName('ct-headers');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Client sends user message
    const clientRun = await clientSession.view.send({
      id: 'user-hdr-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Question' }],
    });

    // Server streams response
    const run = createRunFromOpts(agentSession, {
      runId: clientRun.runId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();
    await run.pipe(textResponseStream('asst-hdr-1', 'text-hdr-1', 'Answer'));
    await run.end('complete');

    await drain(clientRun.stream);
    await waitForMessages(clientSession, 2);

    const nodes = clientSession.view.flattenNodes();
    const userNode = nodes.find((n: { message: { role: string } }) => n.message.role === 'user');
    const asstNode = nodes.find((n: { message: { role: string } }) => n.message.role === 'assistant');

    expect(userNode).toBeDefined();
    expect(asstNode).toBeDefined();

    if (userNode) {
      expect(userNode.msgId).toBeDefined();
      expect(userNode.headers[HEADER_ROLE]).toBe('user');
      expect(userNode.headers[HEADER_RUN_ID]).toBe(clientRun.runId);
      expect(userNode.headers[HEADER_MSG_ID]).toBeDefined();
    }

    if (asstNode) {
      expect(asstNode.msgId).toBeDefined();
      expect(asstNode.headers[HEADER_RUN_ID]).toBe(clientRun.runId);
    }
  });
});
