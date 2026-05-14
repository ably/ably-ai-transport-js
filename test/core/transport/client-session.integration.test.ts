/**
 * ClientSession integration tests.
 *
 * Validate the full client-side session lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test pairs a ClientSession (client)
 * with a AgentSession (server) on the same channel to exercise the
 * send -> stream -> receive roundtrip end-to-end.
 *
 * Rewritten against the event-sourced
 * `Codec<TEvent, TProjection, TMessage>` contract and the new client send
 * model: the client publishes its user message on the channel and the agent
 * issues a run-start carrying the invocation-id so the client's pending
 * send() resolves.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CANCEL_INVOCATION_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';
import type { AgentSession, ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { getHeaders } from '../../../src/utils.js';
import type { VercelEvent, VercelProjection } from '../../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ClientSessionT = ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;
type AgentSessionT = AgentSession<VercelEvent, VercelProjection, AI.UIMessage>;

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

const waitForMessages = async (ct: ClientSessionT, expected: number, timeout = 10_000): Promise<void> =>
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

const waitForRunEvent = async (
  ct: ClientSessionT,
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

// eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
const noopFetch = () => Promise.resolve(new Response(undefined, { status: 200 }));

/**
 * Publish a run-start lifecycle event with the invocation-id header attached
 * so the client's defensive run-end guard can identify the winning invocation.
 * @param channel - The channel to publish on.
 * @param runId - The run identifier.
 * @param invocationId - The invocation identifier.
 * @param clientId - The run-owner clientId.
 */
const publishRunStart = async (
  channel: Ably.RealtimeChannel,
  runId: string,
  invocationId: string,
  clientId: string,
): Promise<void> => {
  await channel.publish({
    name: EVENT_RUN_START,
    extras: {
      headers: {
        [HEADER_RUN_ID]: runId,
        [HEADER_RUN_CLIENT_ID]: clientId,
        [HEADER_INVOCATION_ID]: invocationId,
      },
    },
  });
};

/**
 * Publish a run-end lifecycle event with the invocation-id header attached.
 * @param channel - The channel to publish on.
 * @param runId - The run identifier.
 * @param invocationId - The invocation identifier.
 * @param clientId - The run-owner clientId.
 * @param reason - The run-end reason.
 */
const publishRunEnd = async (
  channel: Ably.RealtimeChannel,
  runId: string,
  invocationId: string,
  clientId: string,
  reason: string,
): Promise<void> => {
  await channel.publish({
    name: EVENT_RUN_END,
    extras: {
      headers: {
        [HEADER_RUN_ID]: runId,
        [HEADER_RUN_CLIENT_ID]: clientId,
        [HEADER_INVOCATION_ID]: invocationId,
        [HEADER_RUN_REASON]: reason,
      },
    },
  });
};

/**
 * Publish a user message via the codec encoder under a forced
 * (runId, msgId, invocationId) tuple. Used to simulate a misbehaving client
 * that reuses a run-id across invocations.
 * @param channel - The channel to publish on.
 * @param runId - The shared run identifier.
 * @param invocationId - The unique invocation identifier.
 * @param msgId - The unique message identifier.
 * @param text - The user message text.
 */
const publishUserMessage = async (
  channel: Ably.RealtimeChannel,
  runId: string,
  invocationId: string,
  msgId: string,
  text: string,
): Promise<void> => {
  const headers = buildTransportHeaders({ role: 'user', runId, msgId, invocationId });
  const encoder = UIMessageCodec.createEncoder(channel, { extras: { headers } });
  const event = UIMessageCodec.userMessageEvent({
    id: msgId,
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await encoder.publish(event);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSession integration', () => {
  let agentSession: AgentSessionT | undefined;
  let clientSession: ClientSessionT | undefined;

  afterEach(async () => {
    await clientSession?.close();
    clientSession = undefined;
    agentSession?.close();
    agentSession = undefined;
    closeAllClients();
  });

  it('receives a streamed text response and accumulates it into a message', async () => {
    const channelName = uniqueChannelName('ct-roundtrip');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-msg-rt-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello!' }],
    });

    // Wait briefly so the client's user-message publish has time to land
    await new Promise((r) => setTimeout(r, 50));

    // The send promise hasn't resolved yet — we need an agent run-start. Get
    // runId from the optimistic tree node.
    const tree = clientSession.tree;
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    expect(runId).toBeDefined();
    expect(invocationId).toBeDefined();
    if (!runId || !invocationId) throw new Error('expected run/invocation ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();

    const clientRun = await sendPromise;

    const stream = textResponseStream('asst-msg-rt-1', 'text-rt-1', 'Hello, how can I help?');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    const events = await drain(clientRun.stream);
    const types = events.map((e) => e.type);
    expect(types).toContain('finish');

    await waitForMessages(clientSession, 2);
    const messages = clientSession.view.flattenNodes().map((n) => n.message);
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const userTextPart = userMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(userTextPart?.text).toBe('Hello!');

    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const asstTextPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(asstTextPart?.text).toBe('Hello, how can I help?');

    // Keep `tree` referenced to satisfy unused-locals when typecheck runs in
    // strict mode.
    expect(tree).toBe(clientSession.tree);
  });

  it('routes streamed events to the own-run ReadableStream', async () => {
    const channelName = uniqueChannelName('ct-stream');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-msg-stream-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Test' }],
    });

    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    if (!runId || !invocationId) throw new Error('expected ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();

    const clientRun = await sendPromise;

    const stream = textResponseStream('asst-msg-stream-1', 'text-stream-1', 'Server response');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    const events = await drain(clientRun.stream);
    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');
  });

  it('tracks run lifecycle events from the server', async () => {
    const channelName = uniqueChannelName('ct-lifecycle');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const runEvents: RunLifecycleEvent[] = [];
    clientSession.tree.on('run', (e) => runEvents.push(e));

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-lc-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    if (!runId || !invocationId) throw new Error('expected ids');

    const startPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_START);
    const endPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_END);

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();

    const clientRun = await sendPromise;
    await startPromise;

    const activeBefore = clientSession.tree.getActiveRunIds();
    expect(activeBefore.size).toBeGreaterThan(0);

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await run.pipe(stream);
    await run.end('complete');

    await endPromise;
    await drain(clientRun.stream);

    expect(runEvents.some((e) => e.type === EVENT_RUN_START && e.runId === runId)).toBe(true);
    expect(runEvents.some((e) => e.type === EVENT_RUN_END && e.runId === runId)).toBe(true);
  });

  it('client cancel aborts the server stream', async () => {
    const channelName = uniqueChannelName('ct-cancel');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-msg-cancel-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Long request' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    if (!runId || !invocationId) throw new Error('expected ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await serverRun.start();
    const clientRun = await sendPromise;

    await clientSession.cancel({ runId });
    await new Promise((r) => setTimeout(r, 100));
    expect(serverRun.abortSignal.aborted).toBe(true);
    await clientRun.cancel();
  });

  it('loads history from the channel', async () => {
    const channelName = uniqueChannelName('ct-history');
    const serverClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();
    const observerChannel = observerClient.channels.get(channelName);

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    const runEndSeen = new Promise<void>((resolve) => {
      void observerChannel.subscribe((msg) => {
        if (msg.name === EVENT_RUN_END) resolve();
      });
    });

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

    await runEndSeen;

    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 0,
    });
    await clientSession.connect();

    await clientSession.view.loadOlder(10);

    const messages = clientSession.view.flattenNodes().map((n) => n.message);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const textPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('History answer');
  });

  it('fires ably-message events for raw Ably messages', async () => {
    const channelName = uniqueChannelName('ct-raw');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    clientSession.tree.on('ably-message', (msg) => rawMessages.push(msg));

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-raw-1',
      role: 'user',
      parts: [{ type: 'text', text: 'test' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    if (!runId || !invocationId) throw new Error('expected ids');

    const endPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_END);

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();
    const clientRun = await sendPromise;

    await run.pipe(textResponseStream('asst-raw-1', 'text-raw-1', 'test'));
    await run.end('complete');

    await endPromise;
    await drain(clientRun.stream);

    expect(rawMessages.length).toBeGreaterThan(0);
    const names = rawMessages.map((m) => m.name);
    expect(names).toContain(EVENT_RUN_START);
    expect(names).toContain(EVENT_RUN_END);
  });

  it('provides conversation nodes from the tree', async () => {
    const channelName = uniqueChannelName('ct-headers');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
      runStartDeadlineMs: 5000,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-hdr-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Question' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.headers[HEADER_RUN_ID];
    const invocationId = optimisticNode?.headers['x-ably-invocation-id'];
    if (!runId || !invocationId) throw new Error('expected ids');

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
    });
    await run.start();
    const clientRun = await sendPromise;

    await run.pipe(textResponseStream('asst-hdr-1', 'text-hdr-1', 'Answer'));
    await run.end('complete');

    await drain(clientRun.stream);
    await waitForMessages(clientSession, 2);

    const nodes = clientSession.view.flattenNodes();
    const userNode = nodes.find((n) => n.message.role === 'user');
    const asstNode = nodes.find((n) => n.message.role === 'assistant');

    expect(userNode).toBeDefined();
    expect(asstNode).toBeDefined();

    if (userNode) {
      expect(userNode.msgId).toBeDefined();
      expect(userNode.headers[HEADER_ROLE]).toBe('user');
      expect(userNode.headers[HEADER_RUN_ID]).toBe(runId);
      expect(userNode.headers[HEADER_MSG_ID]).toBeDefined();
    }
    if (asstNode) {
      expect(asstNode.msgId).toBeDefined();
      expect(asstNode.headers[HEADER_RUN_ID]).toBe(runId);
    }
  });

  // -------------------------------------------------------------------------
  // Channel as durable session record
  // -------------------------------------------------------------------------

  /**
   * The user message lands on the channel even when no agent is running at
   * publish time. A late-attaching subscriber can locate it via channel
   * history keyed by invocation-id.
   */
  it('user message lands on the channel even when no agent is running at publish time', async () => {
    const channelName = uniqueChannelName('ct-late-agent');
    const clientClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      runStartDeadlineMs: 0,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Client sends BEFORE any agent is up. send() resolves immediately
    // because runStartDeadlineMs is 0. The channel publish happens regardless.
    const clientRun = await clientSession.view.sendMessage({
      id: 'user-late-agent',
      role: 'user',
      parts: [{ type: 'text', text: 'is anybody home?' }],
    });

    // Allow the publish ack to land in channel history. Real Ably history
    // has slight propagation lag — poll for up to a few seconds.
    const channel = clientClient.channels.get(channelName);
    let found: Ably.InboundMessage | undefined;
    for (let i = 0; i < 30 && !found; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const page = await channel.history({ limit: 10, direction: 'backwards' });
      found = page.items.find((m) => {
        const headers = (m.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
        return headers[HEADER_ROLE] === 'user' && headers[HEADER_RUN_ID] === clientRun.runId;
      });
    }
    expect(found).toBeDefined();

    const foundHeaders = (found?.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    expect(foundHeaders['x-ably-invocation-id']).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Defensive race — latest-serial wins per run-id
  // -------------------------------------------------------------------------

  /**
   * Scenario: two invocations under the same run-id arrive on the channel
   * (forced via raw publish from a second client). The View must surface only
   * the winning invocation's user message, and the losing invocation's
   * run-end must not terminate the active run.
   */
  it('forces dual-invocation race and only the winning invocation surfaces in the view', async () => {
    const channelName = uniqueChannelName('ct-race');
    const observerClient = ablyRealtimeClient();
    const publisherClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: observerClient,
      channelName,
      codec: UIMessageCodec,
      runStartDeadlineMs: 0,
      clientId: observerClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    const publisherChannel = publisherClient.channels.get(channelName);

    const runId = crypto.randomUUID();
    const losingInvocationId = crypto.randomUUID();
    const winningInvocationId = crypto.randomUUID();
    const losingMsgId = crypto.randomUUID();
    const winningMsgId = crypto.randomUUID();
    const ownerClientId = 'race-owner';

    // Publish the LOSING invocation first (lower serial).
    await publishUserMessage(publisherChannel, runId, losingInvocationId, losingMsgId, 'losing prompt');
    await publishRunStart(publisherChannel, runId, losingInvocationId, ownerClientId);
    await publishRunEnd(publisherChannel, runId, losingInvocationId, ownerClientId, 'complete');

    // Then publish the WINNING invocation (higher serial). The view should
    // discard the losing user message and surface only the winning one.
    await publishUserMessage(publisherChannel, runId, winningInvocationId, winningMsgId, 'winning prompt');
    await publishRunStart(publisherChannel, runId, winningInvocationId, ownerClientId);
    await publishRunEnd(publisherChannel, runId, winningInvocationId, ownerClientId, 'complete');

    // Wait for the winning user message to land in the view.
    await waitForMessages(clientSession, 1);
    // Give propagation a brief moment to surface a second user node if the
    // filter were broken — failure of the test would manifest as count > 1.
    await new Promise((r) => setTimeout(r, 300));

    const nodes = clientSession.view.flattenNodes();
    const userNodes = nodes.filter((n) => n.message.role === 'user');
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0]?.headers[HEADER_INVOCATION_ID]).toBe(winningInvocationId);
    expect(userNodes[0]?.headers[HEADER_MSG_ID]).toBe(winningMsgId);

    const userMsg = userNodes[0]?.message;
    const textPart = userMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('winning prompt');

    // Active run state should not be left open by the losing run-end ahead
    // of the winning sequence completing.
    expect(clientSession.tree.getActiveRunIds().has(runId)).toBe(false);
  });

  /**
   * Scenario: history hydration variant of the defensive race. Same forced
   * dual-invocation publish, but a fresh ClientSession attaches afterwards
   * and reconstructs the conversation purely from channel history.
   */
  it('reconstructs only the winning invocation when hydrating history with multiple invocations under one run-id', async () => {
    const channelName = uniqueChannelName('ct-race-hydrate');
    const publisherClient = ablyRealtimeClient();
    const publisherChannel = publisherClient.channels.get(channelName);

    const runId = crypto.randomUUID();
    const losingInvocationId = crypto.randomUUID();
    const winningInvocationId = crypto.randomUUID();
    const losingMsgId = crypto.randomUUID();
    const winningMsgId = crypto.randomUUID();
    const ownerClientId = 'race-hydrate-owner';

    // Publish both invocations to the channel, losing first so it has the
    // lower serial.
    await publishUserMessage(publisherChannel, runId, losingInvocationId, losingMsgId, 'losing prompt');
    await publishRunStart(publisherChannel, runId, losingInvocationId, ownerClientId);
    await publishRunEnd(publisherChannel, runId, losingInvocationId, ownerClientId, 'complete');
    await publishUserMessage(publisherChannel, runId, winningInvocationId, winningMsgId, 'winning prompt');
    await publishRunStart(publisherChannel, runId, winningInvocationId, ownerClientId);
    await publishRunEnd(publisherChannel, runId, winningInvocationId, ownerClientId, 'complete');

    // Wait briefly for Ably to persist the messages for history.
    await new Promise((r) => setTimeout(r, 500));

    // Fresh client hydrates from history.
    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      runStartDeadlineMs: 0,
      clientId: historyClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();
    await clientSession.view.loadOlder(50);

    const nodes = clientSession.view.flattenNodes();
    const userNodes = nodes.filter((n) => n.message.role === 'user');
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0]?.headers[HEADER_INVOCATION_ID]).toBe(winningInvocationId);
    expect(userNodes[0]?.headers[HEADER_MSG_ID]).toBe(winningMsgId);
  });

  // -------------------------------------------------------------------------
  // runStartDeadlineMs timeout
  // -------------------------------------------------------------------------

  /**
   * Scenario: with a non-zero runStartDeadlineMs and no agent on the channel,
   * send() must reject with `RunStartDeadlineExceeded` once the deadline
   * lapses. Most existing tests bypass this path via `runStartDeadlineMs: 0`.
   */
  it('rejects send() when runStartDeadlineMs lapses without seeing run-start', async () => {
    const channelName = uniqueChannelName('ct-run-start-deadline');
    const clientClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      runStartDeadlineMs: 500,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    const started = Date.now();
    await expect(
      clientSession.view.sendMessage({
        id: 'user-deadline-1',
        role: 'user',
        parts: [{ type: 'text', text: 'no-one is listening' }],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RunStartDeadlineExceeded });
    const elapsed = Date.now() - started;
    // Sanity: the rejection should follow the deadline, not fire instantly.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // And it should not take dramatically longer than the deadline in CI.
    expect(elapsed).toBeLessThan(5000);
  });

  // -------------------------------------------------------------------------
  // Invocation-id-scoped cancel
  // -------------------------------------------------------------------------

  /**
   * Scenario: with two concurrent agent runs in flight under different
   * (runId, invocationId) pairs, `cancel({ invocationId })` must abort only
   * the targeted run and leave the sibling untouched. The cancel publish on
   * the channel must carry `x-ably-cancel-invocation-id` and no other cancel
   * filter header.
   */
  it('cancel({ invocationId }) aborts only the targeted invocation', async () => {
    const channelName = uniqueChannelName('ct-cancel-by-invocation');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      runStartDeadlineMs: 0,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Observer captures cancel publishes to verify wire shape.
    const observerChannel = observerClient.channels.get(channelName);
    const cancelMessages: Ably.InboundMessage[] = [];
    await observerChannel.subscribe(EVENT_CANCEL, (msg) => {
      cancelMessages.push(msg);
    });

    // Two long-running agent runs with distinct (runId, invocationId).
    const survivingRunId = crypto.randomUUID();
    const survivingInvocationId = crypto.randomUUID();
    const targetRunId = crypto.randomUUID();
    const targetInvocationId = crypto.randomUUID();

    const survivingRun = createRunFromOpts(agentSession, {
      runId: survivingRunId,
      invocationId: survivingInvocationId,
      clientId: 'agent',
    });
    const targetRun = createRunFromOpts(agentSession, {
      runId: targetRunId,
      invocationId: targetInvocationId,
      clientId: 'agent',
    });
    await survivingRun.start();
    await targetRun.start();

    // Hold the surviving stream's controller so the test can close it
    // explicitly after asserting on the cancel — without external control the
    // pipe would never settle and the test would hang.
    let survivingController!: ReadableStreamDefaultController<AI.UIMessageChunk>;
    const survivingStream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        survivingController = ctrl;
        ctrl.enqueue({ type: 'start', messageId: crypto.randomUUID() });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-survive' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-survive', delta: 'streaming...' });
      },
    });
    const targetStream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: crypto.randomUUID() });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-target' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-target', delta: 'streaming...' });
      },
    });

    const survivingPipe = survivingRun.pipe(survivingStream);
    const targetPipe = targetRun.pipe(targetStream);

    // Give both streams a moment to publish their initial chunks.
    await new Promise((r) => setTimeout(r, 300));

    // Cancel only the target invocation.
    await clientSession.cancel({ invocationId: targetInvocationId });

    // The target run aborts; the surviving run does not.
    const targetResult = await targetPipe;
    expect(targetResult.reason).toBe('cancelled');
    expect(targetRun.abortSignal.aborted).toBe(true);
    expect(survivingRun.abortSignal.aborted).toBe(false);

    // Close the surviving stream so its pipe resolves naturally, then end
    // both runs to clean up.
    survivingController.enqueue({ type: 'text-end', id: 'text-survive' });
    survivingController.enqueue({ type: 'finish', finishReason: 'stop' });
    survivingController.close();
    await survivingPipe;
    await survivingRun.end('complete');
    await targetRun.end('cancelled');

    // Verify the cancel wire message carried exactly the invocation-id header
    // and no other cancel filter headers.
    expect(cancelMessages.length).toBeGreaterThanOrEqual(1);
    const firstCancel = cancelMessages[0];
    expect(firstCancel).toBeDefined();
    if (!firstCancel) return;
    const cancelHeaders = getHeaders(firstCancel);
    expect(cancelHeaders[HEADER_CANCEL_INVOCATION_ID]).toBe(targetInvocationId);
    expect(cancelHeaders['x-ably-cancel-run-id']).toBeUndefined();
    expect(cancelHeaders['x-ably-cancel-own']).toBeUndefined();
    expect(cancelHeaders['x-ably-cancel-all']).toBeUndefined();
    expect(cancelHeaders['x-ably-cancel-client-id']).toBeUndefined();
  });

  /**
   * Scenario: real run-start await on the happy path.
   *
   * Almost every other test in this file sets `runStartDeadlineMs: 0` to
   * skip the run-start wait — so a regression in the client's run-start
   * handling would not be caught here. This test exercises the real
   * `runStartDeadlineMs` path end-to-end: the client uses the default
   * deadline, a real `DefaultAgentSession` on a second Ably client
   * collects the user prompt via the real lookup, publishes run-start,
   * pipes a short assistant stream, and ends the run. `send()` resolves
   * cleanly (no `RunStartDeadlineExceeded`) and the resulting stream
   * carries the assistant response.
   */
  it('resolves send() against the real run-start await when an agent publishes run-start', async () => {
    const channelName = uniqueChannelName('ct-run-start-happy');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Use the default `promptLookupTimeoutMs` so the agent's real
      // lookup path runs against the client's published user message.
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      // No `runStartDeadlineMs` override — the default (30s) wait is the SUT.
      clientId: clientClient.auth.clientId,
      fetch: noopFetch as typeof globalThis.fetch,
      api: '/test',
    });
    await clientSession.connect();

    // Snoop on the channel BEFORE issuing send() so we don't race the
    // client's publish. Use the agent's serverClient channel (already
    // attached via `agentSession.connect()` above) so subscribe is
    // effectively instant — a separate observer client would risk
    // missing the publish while it attaches.
    const observerChannel = serverClient.channels.get(channelName);
    let resolveIds!: (ids: { runId: string; invocationId: string }) => void;
    const idsPromise = new Promise<{ runId: string; invocationId: string }>((resolve) => {
      resolveIds = resolve;
    });
    const observerListener = (msg: Ably.InboundMessage): void => {
      const headers = getHeaders(msg);
      if (headers[HEADER_ROLE] !== 'user') return;
      const runId = headers[HEADER_RUN_ID];
      const invocationId = headers[HEADER_INVOCATION_ID];
      if (!runId || !invocationId) return;
      observerChannel.unsubscribe(observerListener);
      resolveIds({ runId, invocationId });
    };
    await observerChannel.subscribe(observerListener);

    // Kick off the client send; do NOT await yet — the agent has to handle
    // the lookup and publish run-start before this resolves.
    const sendPromise = clientSession.view.sendMessage({
      id: 'user-rs-happy-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Need a run-start' }],
    });

    const { runId, invocationId } = await idsPromise;

    // Stand up the server-side run; its `start()` triggers the real
    // lookup (which finds the user message) and publishes run-start.
    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      clientId: clientClient.auth.clientId,
      userMessageCount: 1,
    });
    await serverRun.start();
    const responseStream = textResponseStream('asst-rs-happy-1', 'text-rs-happy-1', 'Started');
    await serverRun.pipe(responseStream);
    await serverRun.end('complete');

    // The client's send() must now resolve (run-start has landed) and the
    // returned stream must carry the assistant response.
    const activeRun = await sendPromise;
    expect(activeRun.runId).toBe(runId);
    const events = await drain(activeRun.stream);
    expect(events.some((e) => e.type === 'finish')).toBe(true);
  });
});
