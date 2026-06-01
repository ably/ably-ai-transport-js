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
 * issues a run-start carrying the invocation-id so the client's `run.started`
 * promise resolves.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_AI_INPUT,
  EVENT_AI_OUTPUT,
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_INVOCATION_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';
import type { AgentSession, ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { getCodecHeaders, getTransportHeaders } from '../../../src/utils.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { textResponseStream } from '../../integration/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ClientSessionT = ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
type AgentSessionT = AgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

// Merged view of the transport and codec header tiers. The two tiers carry
// disjoint keys, so merging is unambiguous and lets assertions read either
// tier by bare key.
const getHeaders = (msg: Ably.InboundMessage): Record<string, string> => ({
  ...getTransportHeaders(msg),
  ...getCodecHeaders(msg),
});

const waitForMessages = async (ct: ClientSessionT, expected: number, timeout = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (ct.view.getMessages().length >= expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(`timed out waiting for ${String(expected)} messages (got ${String(ct.view.getMessages().length)})`),
      );
    }, timeout);
    const unsub = ct.view.on('update', () => {
      if (ct.view.getMessages().length >= expected) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

const waitForRunEvent = async (ct: ClientSessionT, runId: string, type: string, timeout = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // The run may already have reached the awaited lifecycle state before we
    // subscribe: events arrive over Ably asynchronously and a fast agent can
    // publish (and the client process) run-end before this helper runs. The
    // tree records the terminal status, so treat a non-active run status as a
    // run-end already observed. Check before subscribing AND immediately
    // after, to close the gap between the initial check and the subscription.
    const alreadyEnded = (): boolean =>
      type === EVENT_RUN_END && (ct.tree.getRunNode(runId)?.status ?? 'active') !== 'active';
    if (alreadyEnded()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${type} on run ${runId}`));
    }, timeout);
    const unsub = ct.tree.on('run', (event) => {
      if (event.runId === runId && event.type === type) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
    if (alreadyEnded()) {
      clearTimeout(timer);
      unsub();
      resolve();
    }
  });

/**
 * Publish a run-start lifecycle event with the invocation-id header attached
 * so the client's run-end gate can match the invocation bound to the run.
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
      ai: {
        transport: {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: clientId,
          [HEADER_INVOCATION_ID]: invocationId,
        },
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
      ai: {
        transport: {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: clientId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_RUN_REASON]: reason,
        },
      },
    },
  });
};

/**
 * Publish a user message via the codec encoder under a forced
 * (runId, codecMessageId, invocationId) tuple. Used to simulate a misbehaving client
 * that reuses a run-id across invocations.
 * @param channel - The channel to publish on.
 * @param runId - The shared run identifier.
 * @param invocationId - The unique invocation identifier.
 * @param codecMessageId - The unique message identifier.
 * @param text - The user message text.
 */
/**
 * Publish a complete Run (user message + assistant text + lifecycle) on
 * the channel, ordering the user message before run-start so the Tree
 * sees fork/parent metadata from the user wire on Run creation. Used by
 * integration tests to seed history without standing up a client to
 * drive the live send flow.
 * @param channel - The channel to publish on.
 * @param opts - Run identifiers, content, and branching metadata.
 * @param opts.runId - Run identifier.
 * @param opts.invocationId - Invocation identifier for the publish.
 * @param opts.clientId - Client identifier stamped on the wire.
 * @param opts.userMsgId - Codec-message-id of the user message.
 * @param opts.userText - User message text.
 * @param opts.userParentMsgId - Optional parent codec-message-id for the user message.
 * @param opts.userForkOfMsgId - Optional fork-of codec-message-id for the user message.
 * @param opts.asstMsgId - Codec-message-id of the assistant message.
 * @param opts.asstText - Assistant message text.
 */
const publishCompleteRun = async (
  channel: Ably.RealtimeChannel,
  opts: {
    runId: string;
    invocationId: string;
    clientId: string;
    userMsgId: string;
    userText: string;
    userParentMsgId?: string;
    userForkOfMsgId?: string;
    asstMsgId: string;
    asstText: string;
  },
): Promise<void> => {
  const userHeaders = buildTransportHeaders({
    role: 'user',
    runId: opts.runId,
    codecMessageId: opts.userMsgId,
    invocationId: opts.invocationId,
    runClientId: opts.clientId,
    parent: opts.userParentMsgId,
    forkOf: opts.userForkOfMsgId,
  });
  const userEncoder = UIMessageCodec.createEncoder(channel, {
    extras: { headers: userHeaders },
    messageId: opts.userMsgId,
  });
  await userEncoder.publishInput({
    kind: 'user-message',
    message: { id: opts.userMsgId, role: 'user', parts: [{ type: 'text', text: opts.userText }] },
  });

  await publishRunStart(channel, opts.runId, opts.invocationId, opts.clientId);

  const asstHeaders = buildTransportHeaders({
    role: 'assistant',
    runId: opts.runId,
    codecMessageId: opts.asstMsgId,
    invocationId: opts.invocationId,
    runClientId: opts.clientId,
    parent: opts.userMsgId,
  });
  const asstEncoder = UIMessageCodec.createEncoder(channel, {
    extras: { headers: asstHeaders },
    messageId: opts.asstMsgId,
  });
  const stream = textResponseStream(opts.asstMsgId, `text-${opts.asstMsgId}`, opts.asstText);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await asstEncoder.publishOutput(value);
  }

  await publishRunEnd(channel, opts.runId, opts.invocationId, opts.clientId, 'complete');
};

/**
 * Publish a regenerate Run lifecycle on the channel. Emits a run-start
 * lifecycle carrying `msg-regenerate` and `parent`, streams
 * an assistant text response under the new runId via the codec encoder,
 * then publishes run-end. Used to seed history for tests that exercise
 * the View's regenerate-sibling surface without standing up a separate
 * client to trigger the flow.
 * @param channel - The channel to publish on.
 * @param opts - Regenerate Run identifiers and content.
 * @param opts.runId - Run identifier of the regenerate Run.
 * @param opts.invocationId - Invocation identifier for the publish.
 * @param opts.clientId - Client identifier stamped on the wire.
 * @param opts.parentMsgId - Codec-message-id of the parent user message.
 * @param opts.regeneratesMsgId - Codec-message-id of the assistant message being regenerated.
 * @param opts.asstMsgId - Codec-message-id of the new assistant message.
 * @param opts.asstText - New assistant message text.
 */
const publishRegenerateRun = async (
  channel: Ably.RealtimeChannel,
  opts: {
    runId: string;
    invocationId: string;
    clientId: string;
    parentMsgId: string;
    regeneratesMsgId: string;
    asstMsgId: string;
    asstText: string;
  },
): Promise<void> => {
  await channel.publish({
    name: EVENT_RUN_START,
    extras: {
      ai: {
        transport: {
          [HEADER_RUN_ID]: opts.runId,
          [HEADER_RUN_CLIENT_ID]: opts.clientId,
          [HEADER_INVOCATION_ID]: opts.invocationId,
          parent: opts.parentMsgId,
          'msg-regenerate': opts.regeneratesMsgId,
        },
      },
    },
  });

  const encoderHeaders = buildTransportHeaders({
    role: 'assistant',
    runId: opts.runId,
    codecMessageId: opts.asstMsgId,
    invocationId: opts.invocationId,
    runClientId: opts.clientId,
    parent: opts.parentMsgId,
  });
  const encoder = UIMessageCodec.createEncoder(channel, {
    extras: { headers: encoderHeaders },
    messageId: opts.asstMsgId,
  });
  const stream = textResponseStream(opts.asstMsgId, `text-${opts.asstMsgId}`, opts.asstText);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await encoder.publishOutput(value);
  }

  await publishRunEnd(channel, opts.runId, opts.invocationId, opts.clientId, 'complete');
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

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
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
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    expect(runId).toBeDefined();
    expect(invocationId).toBeDefined();
    if (!runId || !invocationId) throw new Error('expected run/invocation ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await serverRun.start();

    const clientRun = await sendPromise;

    const stream = textResponseStream('asst-msg-rt-1', 'text-rt-1', 'Hello, how can I help?');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    // Observe via the View: wait for the run to reach a terminal state, then
    // assert the accumulated message (the codec folds chunks into the message).
    await waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_END);

    await waitForMessages(clientSession, 2);
    const messages = clientSession.view.getMessages();
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

  it('folds streamed events into the own-run assistant message', async () => {
    const channelName = uniqueChannelName('ct-stream');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-msg-stream-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Test' }],
    });

    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await serverRun.start();

    const clientRun = await sendPromise;

    const stream = textResponseStream('asst-msg-stream-1', 'text-stream-1', 'Server response');
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    // The generic client no longer exposes a stream; the codec folds the
    // streamed chunks into the assistant message. Wait for the run to reach a
    // terminal state, then assert the accumulated message via the View.
    await waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_END);
    await waitForMessages(clientSession, 2);

    const messages = clientSession.view.getMessages();
    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const asstTextPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(asstTextPart?.text).toBe('Server response');
  });

  it('tracks run lifecycle events from the server', async () => {
    const channelName = uniqueChannelName('ct-lifecycle');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
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
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    const startPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_START);
    const endPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_END);

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await run.start();

    await sendPromise;
    await startPromise;

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await run.pipe(stream);
    await run.end('complete');

    // Run-end is the completion barrier now that the client exposes no stream.
    await endPromise;

    expect(runEvents.some((e) => e.type === EVENT_RUN_START && e.runId === runId)).toBe(true);
    expect(runEvents.some((e) => e.type === EVENT_RUN_END && e.runId === runId)).toBe(true);
  });

  it('client cancel aborts the server stream', async () => {
    const channelName = uniqueChannelName('ct-cancel');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-msg-cancel-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Long request' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await serverRun.start();
    const clientRun = await sendPromise;

    await clientSession.cancel(runId);
    await new Promise((r) => setTimeout(r, 100));
    expect(serverRun.abortSignal.aborted).toBe(true);
    await clientRun.cancel();
  });

  it('loads history from the channel', async () => {
    const channelName = uniqueChannelName('ct-history');
    const serverClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();
    const observerChannel = observerClient.channels.get(channelName);

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
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

    const run = createRunFromOpts(agentSession, { runId: 'run-hist-1' });
    await run.start();
    await run.addMessages([
      {
        kind: 'message',
        message: { id: 'user-hist-1', role: 'user', parts: [{ type: 'text', text: 'History question' }] },
        codecMessageId: crypto.randomUUID(),
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
    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
    });
    await clientSession.connect();

    await clientSession.view.loadOlder(10);

    const messages = clientSession.view.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const textPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('History answer');
  });

  // Spec: AIT-CT11, AIT-773 §7.1 - cross-Run history concatenation.
  it('loads multi-turn history and concatenates messages across Runs in publish order', async () => {
    const channelName = uniqueChannelName('ct-multi-turn-history');
    const serverClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    // Publish three turns. Each turn = one Run with a user prompt and an
    // assistant reply. Threading is established via parentId on the
    // MessageNode + the assistant pipe's natural parent default (last
    // viewMessages msgId).
    // Captured by closure so the helper doesn't need a parameter for the
    // already-narrowed agent session reference.
    const agent = agentSession;
    const publishTurn = async (turn: number, userParentId?: string): Promise<string> => {
      const runId = `run-turn-${String(turn)}`;
      const userMsgId = `u-${String(turn)}`;
      const run = createRunFromOpts(agent, { runId });
      await run.start();
      await run.addMessages([
        {
          kind: 'message',
          message: {
            id: userMsgId,
            role: 'user',
            parts: [{ type: 'text', text: `q${String(turn)}` }],
          },
          codecMessageId: userMsgId,
          parentId: userParentId,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);
      const asstMsgId = `a-${String(turn)}`;
      await run.pipe(textResponseStream(asstMsgId, `text-turn-${String(turn)}`, `r${String(turn)}`));
      await run.end('complete');
      return asstMsgId;
    };

    const a1 = await publishTurn(1);
    const a2 = await publishTurn(2, a1);
    await publishTurn(3, a2);

    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
    });
    await clientSession.connect();

    // Run-based pagination: ask for 10 Runs; all three should fit in one page.
    await clientSession.view.loadOlder(10);

    const nodes = clientSession.view.flattenNodes();
    expect(nodes.map((n) => n.runId)).toEqual(['run-turn-1', 'run-turn-2', 'run-turn-3']);

    const messages = clientSession.view.getMessages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

    // Per-message text content verifies cross-Run concatenation order.
    const texts = messages.map((m) => {
      const textPart = m.parts.find((p): p is AI.TextUIPart => p.type === 'text');
      return textPart?.text ?? '';
    });
    expect(texts).toEqual(['q1', 'r1', 'q2', 'r2', 'q3', 'r3']);
  });

  it('edit at turn 2: forked Run replaces the original branch, select() restores it', async () => {
    const channelName = uniqueChannelName('ct-edit-branch');
    const seedClient = ablyRealtimeClient();
    const seedChannel = seedClient.channels.get(channelName);

    await publishCompleteRun(seedChannel, {
      runId: 'run-t1',
      invocationId: 'inv-t1',
      clientId: 'seed',
      userMsgId: 'u1',
      userText: 'q1',
      asstMsgId: 'a1',
      asstText: 'r1',
    });
    await publishCompleteRun(seedChannel, {
      runId: 'run-t2',
      invocationId: 'inv-t2',
      clientId: 'seed',
      userMsgId: 'u2',
      userText: 'q2',
      userParentMsgId: 'a1',
      asstMsgId: 'a2',
      asstText: 'r2',
    });
    // Edit at turn 2: new Run forks the u2 user prompt.
    await publishCompleteRun(seedChannel, {
      runId: 'run-t2-edit',
      invocationId: 'inv-t2-edit',
      clientId: 'seed',
      userMsgId: 'u2-edit',
      userText: 'q2-edited',
      userParentMsgId: 'a1',
      userForkOfMsgId: 'u2',
      asstMsgId: 'a2-edit',
      asstText: 'r2-edited',
    });

    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
    });
    await clientSession.connect();
    await clientSession.view.loadOlder(10);

    // Default selection at the fork is the latest sibling — run-t2-edit.
    const nodesDefault = clientSession.view.flattenNodes();
    expect(nodesDefault.map((n) => n.runId)).toEqual(['run-t1', 'run-t2-edit']);
    const messagesDefault = clientSession.view.getMessages();
    expect(messagesDefault.map((m) => m.id)).toEqual(['u1', 'a1', 'u2-edit', 'a2-edit']);

    // The fork point exposes two siblings — go through the Tree (the
    // low-level surface) since the View no longer exposes runId-keyed
    // sibling enumeration.
    const siblings = clientSession.tree.getSiblingRuns('run-t2');
    expect(siblings.map((n) => n.runId).toSorted()).toEqual(['run-t2', 'run-t2-edit'].toSorted());

    // Navigate back to the original branch.
    const originalIdx = siblings.findIndex((n) => n.runId === 'run-t2');
    clientSession.view.select('run-t2', originalIdx);

    const nodesOriginal = clientSession.view.flattenNodes();
    expect(nodesOriginal.map((n) => n.runId)).toEqual(['run-t1', 'run-t2']);
    const messagesOriginal = clientSession.view.getMessages();
    expect(messagesOriginal.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('regenerate at turn 2: assistant sibling appears, message-anchored nav switches between them', async () => {
    const channelName = uniqueChannelName('ct-regenerate');
    const seedClient = ablyRealtimeClient();
    const seedChannel = seedClient.channels.get(channelName);

    await publishCompleteRun(seedChannel, {
      runId: 'run-t1',
      invocationId: 'inv-t1',
      clientId: 'seed',
      userMsgId: 'u1',
      userText: 'q1',
      asstMsgId: 'a1',
      asstText: 'r1',
    });
    await publishCompleteRun(seedChannel, {
      runId: 'run-t2',
      invocationId: 'inv-t2',
      clientId: 'seed',
      userMsgId: 'u2',
      userText: 'q2',
      userParentMsgId: 'a1',
      asstMsgId: 'a2',
      asstText: 'r2-original',
    });

    await publishRegenerateRun(seedChannel, {
      runId: 'run-t2-regen',
      invocationId: 'inv-regen',
      clientId: 'regen-owner',
      parentMsgId: 'u2',
      regeneratesMsgId: 'a2',
      asstMsgId: 'a2-regen',
      asstText: 'r2-regen',
    });

    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
    });
    await clientSession.connect();
    await clientSession.view.loadOlder(10);

    // Default selection picks the newest regenerator.
    const messagesDefault = clientSession.view.getMessages();
    const asstDefault = messagesDefault.find((m) => m.role === 'assistant' && m.id !== 'a1');
    const asstTextDefault = asstDefault?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
    expect(asstTextDefault).toBe('r2-regen');

    // a2 is the regenerate-group anchor; both members surface as siblings.
    expect(clientSession.view.hasMessageSiblings('a2')).toBe(true);
    expect(clientSession.view.getMessageSiblings('a2')).toHaveLength(2);

    // Sibling order is chronological by startSerial — the original
    // (run-t2) is index 0, the regenerator (run-t2-regen) is index 1.
    // Navigate back to the original assistant.
    clientSession.view.selectMessageSibling('a2', 0);

    const messagesOriginal = clientSession.view.getMessages();
    const asstOriginal = messagesOriginal.find((m) => m.role === 'assistant' && m.id !== 'a1');
    const asstTextOriginal = asstOriginal?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
    expect(asstTextOriginal).toBe('r2-original');
  });

  it('two clients on the same channel render the same conversation', async () => {
    const channelName = uniqueChannelName('ct-concurrent');
    const serverClient = ablyRealtimeClient();
    const aClient = ablyRealtimeClient();
    const bClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: aClient,
      channelName,
      codec: UIMessageCodec,
      clientId: aClient.auth.clientId,
    });
    await clientSession.connect();

    const observer = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: bClient,
      channelName,
      codec: UIMessageCodec,
      clientId: bClient.auth.clientId,
    });
    await observer.connect();

    try {
      const sendPromise = clientSession.view.sendMessage({
        id: 'u-concurrent-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi from A' }],
      });

      // Wait for A's optimistic Run to appear, then drive the agent so the
      // send resolves.
      await new Promise((r) => setTimeout(r, 100));
      const aOptimistic = clientSession.view.flattenNodes()[0];
      if (!aOptimistic) throw new Error('expected A optimistic node');
      const serverRun = createRunFromOpts(agentSession, {
        runId: aOptimistic.runId,
        invocationId: aOptimistic.invocationId,
      });
      await serverRun.start();
      await serverRun.pipe(textResponseStream('a-concurrent-1', 'text-concurrent-1', 'hi from agent'));
      await serverRun.end('complete');
      await sendPromise;

      // Both views should now see the same conversation.
      await waitForMessages(clientSession, 2);
      await waitForMessages(observer, 2);

      const aMessages = clientSession.view.getMessages();
      const bMessages = observer.view.getMessages();

      expect(aMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(bMessages.map((m) => m.role)).toEqual(['user', 'assistant']);

      expect(aMessages.map((m) => m.id)).toEqual(bMessages.map((m) => m.id));
      const aText = aMessages[1]?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
      const bText = bMessages[1]?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text;
      expect(aText).toBe('hi from agent');
      expect(bText).toBe('hi from agent');

      // Run identity matches across both views.
      const aRunIds = clientSession.view.flattenNodes().map((n) => n.runId);
      const bRunIds = observer.view.flattenNodes().map((n) => n.runId);
      expect(aRunIds).toEqual(bRunIds);
    } finally {
      await observer.close();
    }
  });

  it('loadOlder paginates by Run across multiple calls and drains the withhold buffer', async () => {
    const channelName = uniqueChannelName('ct-paginate');
    const serverClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    const agent = agentSession;
    const publishTurn = async (turn: number, parentId: string | undefined): Promise<string> => {
      const runId = `run-page-${String(turn)}`;
      const userMsgId = `pu-${String(turn)}`;
      const run = createRunFromOpts(agent, { runId });
      await run.start();
      await run.addMessages([
        {
          kind: 'message',
          message: { id: userMsgId, role: 'user', parts: [{ type: 'text', text: `pq${String(turn)}` }] },
          codecMessageId: userMsgId,
          parentId,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);
      const asstMsgId = `pa-${String(turn)}`;
      await run.pipe(textResponseStream(asstMsgId, `text-page-${String(turn)}`, `pr${String(turn)}`));
      await run.end('complete');
      return asstMsgId;
    };

    // Publish six turns; chained via assistant->user parent links.
    let parent: string | undefined;
    for (let i = 1; i <= 6; i++) {
      parent = await publishTurn(i, parent);
    }

    const historyClient = ablyRealtimeClient();
    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: historyClient,
      channelName,
      codec: UIMessageCodec,
      clientId: historyClient.auth.clientId,
    });
    await clientSession.connect();

    // Reveal two Runs at a time. The loader fetches enough channel pages to
    // satisfy the Run-unit limit and withholds the rest.
    await clientSession.view.loadOlder(2);
    const after1 = clientSession.view.flattenNodes().map((n) => n.runId);
    expect(after1.length).toBe(2);
    // Newest two Runs revealed first.
    expect(after1).toEqual(['run-page-5', 'run-page-6']);
    expect(clientSession.view.hasOlder()).toBe(true);

    await clientSession.view.loadOlder(2);
    const after2 = clientSession.view.flattenNodes().map((n) => n.runId);
    expect(after2).toEqual(['run-page-3', 'run-page-4', 'run-page-5', 'run-page-6']);
    expect(clientSession.view.hasOlder()).toBe(true);

    await clientSession.view.loadOlder(2);
    const after3 = clientSession.view.flattenNodes().map((n) => n.runId);
    expect(after3).toEqual(['run-page-1', 'run-page-2', 'run-page-3', 'run-page-4', 'run-page-5', 'run-page-6']);

    // One more call to let the loader probe past the last page and learn
    // there is no more history. `hasOlder()` only flips when either the
    // withhold buffer drains AND a subsequent fetch confirms no next page,
    // so the UI keeps showing a load-more affordance until probed.
    await clientSession.view.loadOlder(2);
    expect(clientSession.view.flattenNodes()).toHaveLength(6);
    expect(clientSession.view.hasOlder()).toBe(false);

    // Final view: 6 turns x (user + assistant) = 12 messages, fully ordered.
    const messages = clientSession.view.getMessages();
    expect(messages).toHaveLength(12);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const userIds = messages.filter((m) => m.role === 'user').map((m) => m.id);
    expect(userIds).toEqual(['pu-1', 'pu-2', 'pu-3', 'pu-4', 'pu-5', 'pu-6']);
  });

  it('surfaces streamed tool-input chunks via view update so client tool runners can react', async () => {
    // Validates that the View emits `update` events for streaming chunks
    // even when the codec mutates the projection in place. A regression
    // in this path silently strands client-side tool runners (e.g.
    // useClientTools in the use-chat demo), since they react to the
    // `dynamic-tool` part transitioning to `input-available` on the
    // assistant message.
    const channelName = uniqueChannelName('ct-tool-stream');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'u-tool-1',
      role: 'user',
      parts: [{ type: 'text', text: "what's the weather like?" }],
    });

    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    // Watch for the View to surface a dynamic-tool part with state
    // `input-available`. If the View suppresses streaming updates (the
    // bug this test guards against), this listener never fires.
    // CAST: clientSession is non-null after the connect() above; narrowing
    // to a local for the listener closure avoids the optional-chain calls
    // the linter flags when the listener fires asynchronously.
    const sessionRef = clientSession;
    const toolPartAvailable = new Promise<AI.DynamicToolUIPart>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('timed out waiting for dynamic-tool input-available via view update'));
      }, 5000);
      const unsub = sessionRef.view.on('update', () => {
        for (const m of sessionRef.view.getMessages()) {
          if (m.role !== 'assistant') continue;
          for (const part of m.parts) {
            if (part.type !== 'dynamic-tool') continue;
            if (part.state === 'input-available') {
              clearTimeout(timer);
              unsub();
              resolve(part);
              return;
            }
          }
        }
      });
    });

    const serverRun = createRunFromOpts(agentSession, { runId, invocationId });
    await serverRun.start();

    const toolCallId = 'tool-call-stream-1';
    const stream = new ReadableStream<AI.UIMessageChunk>({
      start: (controller) => {
        controller.enqueue({ type: 'start', messageId: 'asst-tool-1' });
        controller.enqueue({ type: 'start-step' });
        controller.enqueue({ type: 'tool-input-start', toolCallId, toolName: 'getLocation' });
        controller.enqueue({ type: 'tool-input-delta', toolCallId, inputTextDelta: '{"highAcc' });
        controller.enqueue({ type: 'tool-input-delta', toolCallId, inputTextDelta: 'uracy":false}' });
        controller.enqueue({
          type: 'tool-input-available',
          toolCallId,
          toolName: 'getLocation',
          input: { highAccuracy: false },
        });
        controller.enqueue({ type: 'finish', finishReason: 'tool-calls' });
        controller.close();
      },
    });
    await serverRun.pipe(stream);
    await serverRun.end('complete');
    await sendPromise;

    const toolPart = await toolPartAvailable;
    expect(toolPart.toolName).toBe('getLocation');
    expect(toolPart.toolCallId).toBe(toolCallId);
    if (toolPart.state === 'input-available' || toolPart.state === 'output-available') {
      expect(toolPart.input).toEqual({ highAccuracy: false });
    }
  });

  it('fires ably-message events for raw Ably messages', async () => {
    const channelName = uniqueChannelName('ct-raw');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
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
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    const endPromise = waitForRunEvent(clientSession, runId, EVENT_RUN_END);

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await run.start();
    await sendPromise;

    await run.pipe(textResponseStream('asst-raw-1', 'text-raw-1', 'test'));
    await run.end('complete');

    // Run-end is the completion barrier now that the client exposes no stream.
    await endPromise;

    expect(rawMessages.length).toBeGreaterThan(0);
    const names = rawMessages.map((m) => m.name);
    expect(names).toContain(EVENT_RUN_START);
    expect(names).toContain(EVENT_RUN_END);
  });

  it('provides conversation nodes from the tree', async () => {
    const channelName = uniqueChannelName('ct-headers');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    clientSession = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    const sendPromise = clientSession.view.sendMessage({
      id: 'user-hdr-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Question' }],
    });
    await new Promise((r) => setTimeout(r, 50));
    const optimisticNode = clientSession.view.flattenNodes()[0];
    const runId = optimisticNode?.runId;
    const invocationId = optimisticNode?.invocationId;
    if (!runId || !invocationId) throw new Error('expected ids');

    const run = createRunFromOpts(agentSession, {
      runId,
      invocationId,
    });
    await run.start();
    const clientRun = await sendPromise;

    await run.pipe(textResponseStream('asst-hdr-1', 'text-hdr-1', 'Answer'));
    await run.end('complete');

    // Run-end is the completion barrier now that the client exposes no stream.
    await waitForRunEvent(clientSession, clientRun.runId, EVENT_RUN_END);
    await waitForMessages(clientSession, 2);

    const messages = clientSession.view.getMessages();
    const userMsg = messages.find((m) => m.role === 'user');
    const asstMsg = messages.find((m) => m.role === 'assistant');

    expect(userMsg).toBeDefined();
    expect(asstMsg).toBeDefined();

    if (userMsg) {
      expect(userMsg.id).toBeDefined();
      const metadata = clientSession.view.getMessageMetadata(userMsg.id);
      expect(metadata?.runId).toBe(runId);
    }
    if (asstMsg) {
      expect(asstMsg.id).toBeDefined();
      const metadata = clientSession.view.getMessageMetadata(asstMsg.id);
      expect(metadata?.runId).toBe(runId);
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
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    // Client sends BEFORE any agent is up. send() resolves as soon as the
    // input is published — it never blocks on run-start.
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
        const headers = getHeaders(m);
        return headers[HEADER_ROLE] === 'user' && headers[HEADER_RUN_ID] === clientRun.runId;
      });
    }
    expect(found).toBeDefined();

    const foundHeaders = found ? getHeaders(found) : {};
    expect(foundHeaders['invocation-id']).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Non-blocking send
  // -------------------------------------------------------------------------

  /**
   * Scenario: with no agent on the channel, send() still resolves as soon as
   * the input is published — it does not block on run-start. The returned
   * run's `started` promise stays pending until an agent publishes run-start
   * (which never happens here).
   */
  it('send() resolves on publish even when no agent ever sends run-start', async () => {
    const channelName = uniqueChannelName('ct-nonblocking-send');
    const clientClient = ablyRealtimeClient();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    // send() resolves promptly off the channel publish, with no agent present.
    const activeRun = await clientSession.view.sendMessage({
      id: 'user-nonblocking-1',
      role: 'user',
      parts: [{ type: 'text', text: 'no-one is listening' }],
    });
    expect(activeRun.runId).toBeDefined();

    // `started` must stay pending — no agent published run-start. Race it
    // against a short timer to prove it neither resolves nor rejects.
    const pendingMarker = Symbol('pending');
    const outcome = await Promise.race([
      activeRun.started.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<symbol>((resolve) => {
        setTimeout(() => {
          resolve(pendingMarker);
        }, 500);
      }),
    ]);
    expect(outcome).toBe(pendingMarker);
  });

  // -------------------------------------------------------------------------
  // Per-run cancel isolation
  // -------------------------------------------------------------------------

  /**
   * Scenario: with two concurrent agent runs in flight under different runIds,
   * `cancel(runId)` must cancel only the targeted run and leave the sibling
   * untouched. The cancel publish on the channel must carry `run-id`
   * and no other cancel headers.
   */
  it('cancel(runId) cancels only the targeted run', async () => {
    const channelName = uniqueChannelName('ct-cancel-by-runid');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      inputEventLookupTimeoutMs: 0,
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    // Observer captures cancel publishes to verify wire shape.
    const observerChannel = observerClient.channels.get(channelName);
    const cancelMessages: Ably.InboundMessage[] = [];
    await observerChannel.subscribe(EVENT_CANCEL, (msg) => {
      cancelMessages.push(msg);
    });

    // Two long-running agent runs with distinct runIds.
    const survivingRunId = crypto.randomUUID();
    const survivingInvocationId = crypto.randomUUID();
    const targetRunId = crypto.randomUUID();
    const targetInvocationId = crypto.randomUUID();

    const survivingRun = createRunFromOpts(agentSession, {
      runId: survivingRunId,
      invocationId: survivingInvocationId,
    });
    const targetRun = createRunFromOpts(agentSession, {
      runId: targetRunId,
      invocationId: targetInvocationId,
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

    // Cancel only the target run.
    await clientSession.cancel(targetRunId);

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

    // Verify the cancel wire message carried run-id pointing at the target.
    expect(cancelMessages.length).toBeGreaterThanOrEqual(1);
    const firstCancel = cancelMessages[0];
    expect(firstCancel).toBeDefined();
    if (!firstCancel) return;
    const cancelHeaders = getHeaders(firstCancel);
    expect(cancelHeaders[HEADER_RUN_ID]).toBe(targetRunId);
  });

  /**
   * Scenario: `run.started` against a real agent on the happy path.
   *
   * `send()` resolves immediately off the channel publish and hands back the
   * run's identity directly. A real `DefaultAgentSession` on a second Ably
   * client then collects the user prompt via the real lookup, publishes
   * run-start, pipes a short assistant stream, and ends the run. The client's
   * `run.started` resolves cleanly when run-start lands and the returned
   * stream carries the assistant response.
   */
  it('resolves run.started when an agent publishes run-start', async () => {
    const channelName = uniqueChannelName('ct-run-start-happy');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    agentSession = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Use the default `inputEventLookupTimeoutMs` so the agent's real
      // lookup path runs against the client's published user message.
    });
    await agentSession.connect();

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    // send() resolves on publish and carries the run's identity directly —
    // no need to snoop the channel for the published ids.
    const activeRun = await clientSession.view.sendMessage({
      id: 'user-rs-happy-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Need a run-start' }],
    });
    const { runId, invocationId, inputEventId } = activeRun;

    // Stand up the server-side run; its `start()` triggers the real
    // lookup (which finds the user message) and publishes run-start.
    const serverRun = createRunFromOpts(agentSession, {
      runId,
      invocationId,
      inputEventId,
    });
    await serverRun.start();

    // run-start has now landed — `started` must resolve.
    await expect(activeRun.started).resolves.toBeUndefined();

    const responseStream = textResponseStream('asst-rs-happy-1', 'text-rs-happy-1', 'Started');
    await serverRun.pipe(responseStream);
    await serverRun.end('complete');

    // The generic client exposes no stream; observe completion via the View:
    // wait for run-end, then assert the codec-folded assistant message.
    expect(activeRun.runId).toBe(runId);
    await waitForRunEvent(clientSession, activeRun.runId, EVENT_RUN_END);
    await waitForMessages(clientSession, 2);

    const messages = clientSession.view.getMessages();
    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    const asstTextPart = asstMsg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(asstTextPart?.text).toBe('Started');
  });

  // -------------------------------------------------------------------------
  // ai-input / ai-output wire seam (regression for AIT-815)
  // -------------------------------------------------------------------------

  /**
   * A client-published `ToolResult` must land on the `ai-input` wire
   * (not `ai-output`). This is the regression guard for AIT-815: client-side
   * tool resolutions are inputs and must travel on the input wire so the
   * agent-side projection sees them and the message-direction invariant
   * holds.
   */
  it('publishes a client tool result on the ai-input wire (not ai-output)', async () => {
    const channelName = uniqueChannelName('ct-tool-result-wire');
    const clientClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();
    const observerChannel = observerClient.channels.get(channelName);

    const inputMessages: Ably.InboundMessage[] = [];
    const outputMessages: Ably.InboundMessage[] = [];
    let resolveInput!: () => void;
    const gotInput = new Promise<void>((resolve) => {
      resolveInput = resolve;
    });
    await observerChannel.subscribe((msg) => {
      if (msg.name === EVENT_AI_INPUT) {
        inputMessages.push(msg);
        if (getHeaders(msg).type === 'tool-result') resolveInput();
      } else if (msg.name === EVENT_AI_OUTPUT) {
        outputMessages.push(msg);
      }
    });

    clientSession = createClientSession({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      clientId: clientClient.auth.clientId,
    });
    await clientSession.connect();

    const codecMessageId = 'asst-tool-result-1';
    const toolCallId = 'tc-result-1';
    await clientSession.view.sendInput({
      kind: 'tool-result',
      codecMessageId,
      toolCallId,
      output: { temperature: 22 },
    });

    await gotInput;

    const toolResult = inputMessages.find((m) => getHeaders(m).type === 'tool-result');
    expect(toolResult).toBeDefined();
    if (toolResult) {
      const headers = getHeaders(toolResult);
      expect(headers.toolCallId).toBe(toolCallId);
    }
    // Crucially, no client tool result should ever appear on the ai-output wire.
    expect(outputMessages.some((m) => getHeaders(m).type === 'tool-result')).toBe(false);
  });

  /**
   * An agent-published `tool-output-available` UIMessageChunk continues to
   * land on the `ai-output` wire. This is the symmetric assertion: agent
   * tool outputs are outputs and stay on the output wire.
   */
  it('agent-published tool-output-available lands on the ai-output wire', async () => {
    const channelName = uniqueChannelName('ct-agent-tool-output-wire');
    const serverClient = ablyRealtimeClient();
    const observerClient = ablyRealtimeClient();
    const observerChannel = observerClient.channels.get(channelName);

    agentSession = createAgentSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await agentSession.connect();

    const inputMessages: Ably.InboundMessage[] = [];
    const outputMessages: Ably.InboundMessage[] = [];
    let resolveOutput!: () => void;
    const gotOutput = new Promise<void>((resolve) => {
      resolveOutput = resolve;
    });
    await observerChannel.subscribe((msg) => {
      if (msg.name === EVENT_AI_INPUT) {
        inputMessages.push(msg);
      } else if (msg.name === EVENT_AI_OUTPUT) {
        outputMessages.push(msg);
        if (getHeaders(msg).type === 'tool-output-available') resolveOutput();
      }
    });

    const serverRun = createRunFromOpts(agentSession, { runId: 'run-agent-tool-output' });
    await serverRun.start();

    const stream = new ReadableStream<VercelOutput>({
      start: (controller) => {
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId: 'tc-agent-1',
          output: { ok: true },
          dynamic: true,
          providerExecuted: false,
          preliminary: false,
        });
        controller.close();
      },
    });
    await serverRun.pipe(stream);
    await serverRun.end('complete');

    await gotOutput;

    expect(outputMessages.some((m) => getHeaders(m).type === 'tool-output-available')).toBe(true);
    // The agent must NOT publish tool outputs on the input wire.
    expect(inputMessages.some((m) => getHeaders(m).type === 'tool-output-available')).toBe(false);
  });
});
