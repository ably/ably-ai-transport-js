/**
 * AgentSession integration tests.
 *
 * Validate the full server-side run lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test creates an AgentSession on
 * a unique channel and a separate subscriber client to verify messages
 * arrive correctly.
 *
 * Rewritten against the event-sourced
 * `Codec<TEvent, TProjection, TMessage>` contract — the subscriber
 * decodes via `Decoder.decode()` and folds events into a `VercelProjection`
 * via `init` + `fold`, then reads `getMessages(projection)` to verify the
 * reconstructed conversation.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_AMEND,
  HEADER_CANCEL_RUN_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';
import type { AgentSession } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { getHeaders } from '../../../src/utils.js';
import type { VercelEvent, VercelProjection } from '../../../src/vercel/codec/index.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { eventsOf, eventTypesOf, textResponseStream } from '../../integration/helpers.js';

type AgentSessionT = AgentSession<VercelEvent, VercelProjection, AI.UIMessage>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FoldingCollector {
  allEvents: VercelEvent[];
  rawMessages: Ably.InboundMessage[];
  /** Fully folded projection across all messages observed so far. */
  projection: VercelProjection;
  done: Promise<void>;
}

/**
 * Subscribe to the given channel and decode every inbound message via the
 * codec, folding each event into a per-channel projection. Resolves the
 * returned `done` promise the first time `predicate` returns true for a
 * decoded event batch.
 * @param channel - The Ably channel to subscribe to.
 * @param predicate - Stop collecting when this returns true for a batch of events.
 * @returns A collector with running raw messages, events, and projection state.
 */
const collectUntil = (
  channel: Ably.RealtimeChannel,
  predicate: (events: AI.UIMessageChunk[]) => boolean,
): FoldingCollector => {
  const decoder = UIMessageCodec.createDecoder();
  let projection = UIMessageCodec.init();
  const allEvents: VercelEvent[] = [];
  const rawMessages: Ably.InboundMessage[] = [];

  let resolve: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  void channel.subscribe((msg) => {
    rawMessages.push(msg);
    const events = decoder.decode(msg);
    allEvents.push(...events);
    const headers = getHeaders(msg);
    const msgId = headers[HEADER_AMEND] ?? headers[HEADER_MSG_ID];
    for (const event of events) {
      projection = UIMessageCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: msgId });
    }
    if (predicate(eventsOf(events))) resolve();
  });

  return {
    allEvents,
    rawMessages,
    get projection() {
      return projection;
    },
    done,
  };
};

const hasFinish = (events: AI.UIMessageChunk[]): boolean => events.some((e) => e.type === 'finish');
const isRunEnd = (msg: Ably.InboundMessage): boolean => msg.name === EVENT_RUN_END;

// eslint-disable-next-line @typescript-eslint/promise-function-async -- noop fetch
const noopFetch: typeof globalThis.fetch = () => Promise.resolve(new Response(undefined, { status: 200 }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSession integration', () => {
  let session: AgentSessionT | undefined;

  afterEach(() => {
    session?.close();
    session = undefined;
    closeAllClients();
  });

  it('streams a text response through the transport', async () => {
    const channelName = uniqueChannelName('st-text');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const collector = collectUntil(subChannel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
    await run.start();

    const stream = textResponseStream('msg-1', 'text-1', 'Hello, world!');
    const result = await run.pipe(stream);
    await run.end('complete');

    await collector.done;

    expect(result.reason).toBe('complete');

    const types = eventTypesOf(collector.allEvents);
    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(collector.projection);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('Hello, world!');

    const streamMsg = collector.rawMessages.find((m) => m.name !== EVENT_RUN_START && m.name !== EVENT_RUN_END);
    expect(streamMsg).toBeDefined();
    if (streamMsg) {
      const headers = getHeaders(streamMsg);
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_MSG_ID]).toBeDefined();
    }
  });

  it('publishes run-start and run-end events', async () => {
    const channelName = uniqueChannelName('st-lifecycle');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const lifecycleMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      lifecycleMessages.push(msg);
      if (isRunEnd(msg)) resolveEnd();
    });

    const run = createRunFromOpts(session, { runId: 'run-lc-1', clientId: 'user-b' });
    await run.start();

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await run.pipe(stream);
    await run.end('complete');

    await gotEnd;

    const startMsg = lifecycleMessages.find((m) => m.name === EVENT_RUN_START);
    expect(startMsg).toBeDefined();
    if (startMsg) {
      const startHeaders = getHeaders(startMsg);
      expect(startHeaders[HEADER_RUN_ID]).toBe('run-lc-1');
    }

    const endMsg = lifecycleMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    if (endMsg) {
      const endHeaders = getHeaders(endMsg);
      expect(endHeaders[HEADER_RUN_ID]).toBe('run-lc-1');
      expect(endHeaders[HEADER_RUN_REASON]).toBe('complete');
    }
  });

  it('cancels a run via channel cancel message', async () => {
    const channelName = uniqueChannelName('st-cancel');
    const serverClient = ablyRealtimeClient();
    const cancelClient = ablyRealtimeClient();
    const cancelChannel = cancelClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-cancel-1', clientId: 'user-c' });
    await run.start();

    const stream = new ReadableStream<VercelEvent>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'msg-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = run.pipe(stream);
    await new Promise((r) => setTimeout(r, 500));

    await cancelChannel.publish({
      name: EVENT_CANCEL,
      extras: { headers: { [HEADER_CANCEL_RUN_ID]: 'run-cancel-1' } },
    });

    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(run.abortSignal.aborted).toBe(true);
    await run.end('cancelled');
  });

  it('handles sequential runs', async () => {
    const channelName = uniqueChannelName('st-multi-run');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    let projection = UIMessageCodec.init();
    const decoder = UIMessageCodec.createDecoder();
    let finishCount = 0;
    let resolveTwoFinishes: () => void;
    const twoFinishes = new Promise<void>((r) => {
      resolveTwoFinishes = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      const headers = getHeaders(msg);
      const msgId = headers[HEADER_AMEND] ?? headers[HEADER_MSG_ID];
      for (const event of events) {
        projection = UIMessageCodec.fold(projection, event, { serial: msg.serial ?? '', messageId: msgId });
      }
      if (eventsOf(events).some((e) => e.type === 'finish')) {
        finishCount++;
        if (finishCount === 2) resolveTwoFinishes();
      }
    });

    const run1 = createRunFromOpts(session, { runId: 'run-seq-1', clientId: 'user-d' });
    await run1.start();
    const result1 = await run1.pipe(textResponseStream('msg-seq-1', 'text-seq-1', 'First response'));
    await run1.end('complete');
    expect(result1.reason).toBe('complete');

    const run2 = createRunFromOpts(session, { runId: 'run-seq-2', clientId: 'user-d' });
    await run2.start();
    const result2 = await run2.pipe(textResponseStream('msg-seq-2', 'text-seq-2', 'Second response'));
    await run2.end('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(2);
  });

  it('handles concurrent runs', async () => {
    const channelName = uniqueChannelName('st-concurrent');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let finishCount = 0;
    let resolveTwoFinishes: () => void;
    const twoFinishes = new Promise<void>((r) => {
      resolveTwoFinishes = r;
    });

    const decoder = UIMessageCodec.createDecoder();
    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      const events = decoder.decode(msg);
      if (eventsOf(events).some((e) => e.type === 'finish')) {
        finishCount++;
        if (finishCount === 2) resolveTwoFinishes();
      }
    });

    const run1 = createRunFromOpts(session, { runId: 'run-conc-1', clientId: 'user-e' });
    const run2 = createRunFromOpts(session, { runId: 'run-conc-2', clientId: 'user-f' });

    await Promise.all([run1.start(), run2.start()]);

    const [result1, result2] = await Promise.all([
      run1.pipe(textResponseStream('msg-conc-1', 'text-conc-1', 'Response A')),
      run2.pipe(textResponseStream('msg-conc-2', 'text-conc-2', 'Response B')),
    ]);

    await Promise.all([run1.end('complete'), run2.end('complete')]);

    expect(result1.reason).toBe('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    const runIds = new Set(rawMessages.map((m) => getHeaders(m)[HEADER_RUN_ID]).filter(Boolean));
    expect(runIds.has('run-conc-1')).toBe(true);
    expect(runIds.has('run-conc-2')).toBe(true);
  });

  it('propagates stream errors', async () => {
    const channelName = uniqueChannelName('st-error');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      if (isRunEnd(msg)) resolveEnd();
    });

    const run = createRunFromOpts(session, { runId: 'run-err-1', clientId: 'user-g' });
    await run.start();

    const stream = new ReadableStream<VercelEvent>({
      start: (controller) => {
        controller.enqueue({ type: 'start', messageId: 'msg-err-1' });
        controller.enqueue({ type: 'start-step' });
        controller.enqueue({ type: 'text-start', id: 'text-err-1' });
        controller.enqueue({ type: 'text-delta', id: 'text-err-1', delta: 'Partial...' });
        controller.error(new Error('model rate limit exceeded'));
      },
    });

    const result = await run.pipe(stream);
    expect(result.reason).toBe('error');

    await run.end('error');
    await gotEnd;

    const endMsg = rawMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    if (endMsg) {
      expect(getHeaders(endMsg)[HEADER_RUN_REASON]).toBe('error');
    }
  });

  it('multiple subscribers receive the same stream', async () => {
    const channelName = uniqueChannelName('st-sync');
    const serverClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();
    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const c1 = collectUntil(sub1Channel, hasFinish);
    const c2 = collectUntil(sub2Channel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-sync-1', clientId: 'user-h' });
    await run.start();
    await run.pipe(textResponseStream('msg-sync-1', 'text-sync-1', 'Shared response'));
    await run.end('complete');

    await Promise.all([c1.done, c2.done]);

    const m1 = UIMessageCodec.getMessages(c1.projection);
    const m2 = UIMessageCodec.getMessages(c2.projection);
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);

    const text1 = m1[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    const text2 = m2[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(text1?.text).toBe('Shared response');
    expect(text2?.text).toBe('Shared response');
  });

  it('addMessages returns msg-ids and explicit parent links assistant', async () => {
    const channelName = uniqueChannelName('st-add-msgs');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let resolveFinish: () => void;
    const gotFinish = new Promise<void>((r) => {
      resolveFinish = r;
    });

    const decoder = UIMessageCodec.createDecoder();
    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      const events = decoder.decode(msg);
      if (eventsOf(events).some((e) => e.type === 'finish')) resolveFinish();
    });

    const run = createRunFromOpts(session, { runId: 'run-add-1', clientId: 'user-i' });
    await run.start();

    const userMessage: AI.UIMessage = {
      id: 'user-msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'What is the weather?' }],
    };
    const { msgIds } = await run.addMessages([
      {
        kind: 'message',
        message: userMessage,
        msgId: crypto.randomUUID(),
        parentId: undefined,
        forkOf: undefined,
        headers: {},
        serial: undefined,
      },
    ]);

    await run.pipe(textResponseStream('msg-reply-1', 'text-reply-1', 'Sunny!'), {
      parent: msgIds.at(-1),
    });
    await run.end('complete');

    await gotFinish;

    const userRoleMsg = rawMessages.find((m) => getHeaders(m)[HEADER_ROLE] === 'user');
    expect(userRoleMsg).toBeDefined();
    if (!userRoleMsg) return;
    const userHeaders = getHeaders(userRoleMsg);
    expect(userHeaders[HEADER_RUN_ID]).toBe('run-add-1');
    const userMsgId = userHeaders[HEADER_MSG_ID];
    expect(userMsgId).toBeDefined();

    const assistantMsg = rawMessages.find((m) => getHeaders(m)[HEADER_ROLE] === 'assistant');
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) return;
    const assistantHeaders = getHeaders(assistantMsg);
    expect(assistantHeaders[HEADER_PARENT]).toBe(userMsgId);
  });

  it('invokes onError with ChannelContinuityLost when the channel detaches', async () => {
    const channelName = uniqueChannelName('st-continuity');
    const serverClient = ablyRealtimeClient();

    const errors: Ably.ErrorInfo[] = [];

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      onError: (err) => errors.push(err),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
    await run.start();

    await serverClient.channels.get(channelName).detach();

    await vi.waitFor(
      () => {
        expect(errors.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);
  });

  it('stamps per-event WriteOptions overrides on discrete publishes', async () => {
    const channelName = uniqueChannelName('st-resolve-write-options');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
    });
    await session.connect();

    const rawMessages: Ably.InboundMessage[] = [];
    let resolve: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      if (msg.name === 'tool-output-available') resolve();
    });

    const run = createRunFromOpts(session, { runId: 'run-rwo', clientId: 'user-a' });
    await run.start();

    const stream = new ReadableStream<VercelEvent>({
      start: (controller) => {
        controller.enqueue({ type: 'text-start', id: 'txt-1' });
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId: 't1',
          output: { result: 'ok' },
          dynamic: true,
          providerExecuted: false,
          preliminary: false,
        });
        controller.close();
      },
    });

    await run.pipe(stream, {
      resolveWriteOptions: (event) =>
        event.type === 'tool-output-available'
          ? { messageId: 'target-msg-id', extras: { headers: { [HEADER_AMEND]: 'target-msg-id' } } }
          : undefined,
    });

    await done;

    const textStartMsg = rawMessages.find((m) => m.name === 'text');
    expect(textStartMsg).toBeDefined();
    if (textStartMsg) {
      const textHeaders = getHeaders(textStartMsg);
      expect(textHeaders[HEADER_MSG_ID]).not.toBe('target-msg-id');
      expect(textHeaders[HEADER_AMEND]).toBeUndefined();
    }

    const toolMsg = rawMessages.find((m) => m.name === 'tool-output-available');
    expect(toolMsg).toBeDefined();
    if (toolMsg) {
      const toolHeaders = getHeaders(toolMsg);
      expect(toolHeaders[HEADER_MSG_ID]).toBe('target-msg-id');
      expect(toolHeaders[HEADER_AMEND]).toBe('target-msg-id');
    }

    await run.end('complete');
  });

  /**
   * Scenario: forward-looking live wait for a user prompt.
   *
   * The agent registers its prompt-lookup listener BEFORE the client
   * publishes the user message — exercising the live-wait path inside
   * `lookupUserPrompt` (not the rewind/buffer-drain path that other
   * tests in this file cover). The lookup must pick the message up as
   * it arrives live and resolve `run.start()`.
   *
   * Pre-allocating the runId / invocationId is what makes this
   * orderable: the agent can stand up its run with known identifiers
   * and call `start()` first, then the publisher publishes a message
   * tagged with the same invocation-id.
   */
  it('collects a user prompt that arrives live after the lookup is registered', async () => {
    const channelName = uniqueChannelName('st-live-lookup');
    const serverClient = ablyRealtimeClient();
    const publisherClient = ablyRealtimeClient();

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Default `promptLookupTimeoutMs` — the live wait must succeed
      // well before the 30s default.
    });
    await session.connect();

    const runId = crypto.randomUUID();
    const invocationId = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    const text = 'Live arrival';

    const serverRun = createRunFromOpts(session, {
      runId,
      invocationId,
      clientId: 'live-lookup-client',
      userMessageCount: 1,
    });

    // Begin the lookup. `start()` will not resolve until a user prompt
    // with `invocationId` arrives — and that message has not been
    // published yet.
    const startPromise = serverRun.start();

    // Publish the user prompt from a separate client after the lookup
    // has had a chance to register. A short sleep here is enough to
    // ensure `start()` has crossed the requireConnected await and
    // installed the listener; the lookup itself has a 30s budget so
    // a few hundred ms is safe.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const publisherChannel = publisherClient.channels.get(channelName);
    const headers = buildTransportHeaders({ role: 'user', runId, msgId, invocationId });
    const encoder = UIMessageCodec.createEncoder(publisherChannel, { extras: { headers } });
    const userEvent = UIMessageCodec.userMessageEvent({
      id: msgId,
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    await encoder.publish(userEvent);

    await startPromise;

    expect(serverRun.view.messages).toHaveLength(1);
    const found = serverRun.view.messages[0];
    expect(found?.msgId).toBe(msgId);
    expect(found?.headers[HEADER_INVOCATION_ID]).toBe(invocationId);
    expect(found?.message.parts[0]).toEqual({ type: 'text', text });

    await serverRun.end('complete');
  });

  /**
   * Scenario: multi-message `send([m1, m2])` round-trip.
   *
   * The client publishes two user messages on the channel under a single
   * invocation-id (each as its own Ably message). The agent's
   * `lookupUserPrompt` must collect both before resolving, surface them in
   * `run.view.messages` ordered by publish order, then the agent can pipe
   * an assistant response that the client receives.
   *
   * This is the regression test for PR #90: previously the lookup settled
   * on the first matching arrival and dropped subsequent messages.
   */
  it('collects all messages in a multi-message send before run.start() resolves', async () => {
    // Lazy-import to keep the existing test imports above stable.
    const { createClientSession } = await import('../../../src/core/transport/client-session.js');
    const channelName = uniqueChannelName('st-multi-msg');
    const serverClient = ablyRealtimeClient();
    const clientClient = ablyRealtimeClient();

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      // Use the default promptLookupTimeoutMs so the real lookup path runs.
    });
    await session.connect();

    const clientSession = createClientSession<VercelEvent, VercelProjection, AI.UIMessage>({
      client: clientClient,
      channelName,
      codec: UIMessageCodec,
      // `send()` would otherwise block awaiting `x-ably-run-start` — but
      // the agent only publishes that AFTER its lookup resolves, which
      // requires `send()` to publish the user messages first. The
      // happy-path run-start wait is exercised in client-session integration
      // tests (Commit 2); this test focuses on the lookup itself.
      runStartDeadlineMs: 0,
      clientId: clientClient.auth.clientId,
      fetch: noopFetch,
      api: '/test',
    });
    await clientSession.connect();

    try {
      const activeRun = await clientSession.view.send([
        UIMessageCodec.userMessageEvent({
          id: 'user-multi-1',
          role: 'user',
          parts: [{ type: 'text', text: 'First' }],
        }),
        UIMessageCodec.userMessageEvent({
          id: 'user-multi-2',
          role: 'user',
          parts: [{ type: 'text', text: 'Second' }],
        }),
      ]);

      const serverRun = createRunFromOpts(session, {
        runId: activeRun.runId,
        invocationId: activeRun.invocationId,
        clientId: clientClient.auth.clientId,
        userMessageCount: 2,
      });
      await serverRun.start();

      expect(serverRun.view.messages).toHaveLength(2);
      const ids = serverRun.view.messages.map((n) => n.message.id);
      expect(ids).toEqual(['user-multi-1', 'user-multi-2']);
      const firstText = serverRun.view.messages[0]?.message.parts.find(
        (p): p is AI.TextUIPart => p.type === 'text',
      )?.text;
      const secondText = serverRun.view.messages[1]?.message.parts.find(
        (p): p is AI.TextUIPart => p.type === 'text',
      )?.text;
      expect(firstText).toBe('First');
      expect(secondText).toBe('Second');

      const responseStream = textResponseStream('asst-multi-1', 'text-multi-1', 'Got both');
      const result = await serverRun.pipe(responseStream);
      await serverRun.end('complete');
      expect(result.reason).toBe('complete');

      // Drain the client's stream to verify the response reached it.
      const reader = activeRun.stream.getReader();
      const events: VercelEvent[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(value);
      }
      expect(events.some((e) => e.type === 'finish')).toBe(true);
    } finally {
      await clientSession.close();
    }
  });
});
