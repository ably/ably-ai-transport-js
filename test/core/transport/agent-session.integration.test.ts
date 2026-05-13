/**
 * AgentSession integration tests.
 *
 * Validate the full server-side run lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test creates a AgentSession
 * on a unique channel and a separate subscriber client to verify messages
 * arrive correctly.
 *
 * These tests prove the wire protocol, run lifecycle events, cancel
 * routing, and stream piping work end-to-end over real Ably infrastructure.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_ERROR,
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
import type { DecoderOutput } from '../../../src/core/codec/types.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { buildTransportHeaders } from '../../../src/core/transport/headers.js';
import type { AgentSession } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { getHeaders } from '../../../src/utils.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';
import { eventsOf, eventTypesOf, textResponseStream } from '../../integration/helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all messages on a channel into decoder outputs until a predicate is met.
 * @param channel - The Ably channel to subscribe to.
 * @param predicate - Stop collecting when this returns true for a batch of events.
 * @returns An object with the collected outputs and a promise that resolves when done.
 */
const collectUntil = (channel: Ably.RealtimeChannel, predicate: (events: AI.UIMessageChunk[]) => boolean) => {
  const decoder = UIMessageCodec.createDecoder();
  const accumulator = UIMessageCodec.createAccumulator();
  const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
  const rawMessages: Ably.InboundMessage[] = [];

  let resolve: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  const subscription = channel.subscribe((msg) => {
    rawMessages.push(msg);
    const outputs = decoder.decode(msg);
    allOutputs.push(...outputs);
    accumulator.processOutputs(outputs);
    if (predicate(eventsOf(outputs))) resolve();
  });

  return { allOutputs, accumulator, rawMessages, done, subscription };
};

/**
 * Check if any event in a batch is a 'finish' event.
 * @param events - Events to check.
 * @returns True if a finish event is present.
 */
const hasFinish = (events: AI.UIMessageChunk[]): boolean => events.some((e) => e.type === 'finish');

/**
 * Check if a message is a run-end lifecycle event.
 * @param msg - The Ably message to check.
 * @returns True if the message name is run-end.
 */
const isRunEnd = (msg: Ably.InboundMessage): boolean => msg.name === EVENT_RUN_END;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSession integration', () => {
  let session: AgentSession<AI.UIMessageChunk, AI.UIMessage> | undefined;

  afterEach(() => {
    session?.close();
    session = undefined;
    closeAllClients();
  });

  /**
   * Scenario: Full transport text response roundtrip.
   *
   * Creates a AgentSession, starts a run, streams a text response,
   * and verifies a subscriber receives the complete decoded message
   * with correct transport headers.
   */
  it('streams a text response through the transport', async () => {
    const channelName = uniqueChannelName('st-text');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
    });
    await session.connect();

    const { allOutputs, accumulator, rawMessages, done } = collectUntil(subChannel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
    await run.start();

    const stream = textResponseStream('msg-1', 'text-1', 'Hello, world!');
    const result = await run.pipe(stream);
    await run.end('complete');

    await done;

    // Stream completed successfully
    expect(result.reason).toBe('complete');

    // Subscriber received all expected event types
    const types = eventTypesOf(allOutputs);
    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');

    // Accumulator reconstructed the message
    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('Hello, world!');

    // Transport headers were stamped on raw messages
    const streamMsg = rawMessages.find((m) => m.name !== EVENT_RUN_START && m.name !== EVENT_RUN_END);
    expect(streamMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const headers = getHeaders(streamMsg!);
    expect(headers[HEADER_ROLE]).toBe('assistant');
    expect(headers[HEADER_RUN_ID]).toBe('run-1');
    expect(headers[HEADER_MSG_ID]).toBeDefined();
  });

  /**
   * Scenario: Run lifecycle events are published.
   *
   * Verifies the subscriber receives run-start and run-end events
   * with correct headers.
   */
  it('publishes run-start and run-end events', async () => {
    const channelName = uniqueChannelName('st-lifecycle');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const startHeaders = getHeaders(startMsg!);
    expect(startHeaders[HEADER_RUN_ID]).toBe('run-lc-1');

    const endMsg = lifecycleMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const endHeaders = getHeaders(endMsg!);
    expect(endHeaders[HEADER_RUN_ID]).toBe('run-lc-1');
    expect(endHeaders[HEADER_RUN_REASON]).toBe('complete');
  });

  /**
   * Scenario: Cancel chain — client publishes cancel, server stream aborts.
   *
   * Starts a long-running stream, publishes a cancel message from a
   * separate client, and verifies the stream is cancelled.
   */
  it('cancels a run via channel cancel message', async () => {
    const channelName = uniqueChannelName('st-cancel');
    const serverClient = ablyRealtimeClient();
    const cancelClient = ablyRealtimeClient();

    const cancelChannel = cancelClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-cancel-1', clientId: 'user-c' });
    await run.start();

    // Create a stream that never closes — it will be cancelled
    const stream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'msg-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = run.pipe(stream);

    // Give the stream time to start publishing
    await new Promise((r) => setTimeout(r, 500));

    // Publish cancel from another client
    await cancelChannel.publish({
      name: EVENT_CANCEL,
      extras: {
        headers: { [HEADER_CANCEL_RUN_ID]: 'run-cancel-1' },
      },
    });

    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(run.abortSignal.aborted).toBe(true);

    await run.end('cancelled');
  });

  /**
   * Scenario: Multi-run sequential.
   *
   * Runs two runs sequentially on the same session and verifies
   * both complete successfully.
   */
  it('handles sequential runs', async () => {
    const channelName = uniqueChannelName('st-multi-run');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
    });
    await session.connect();

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();
    let finishCount = 0;
    let resolveTwoFinishes: () => void;
    const twoFinishes = new Promise<void>((r) => {
      resolveTwoFinishes = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      accumulator.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) {
        finishCount++;
        if (finishCount === 2) resolveTwoFinishes();
      }
    });

    // Run 1
    const run1 = createRunFromOpts(session, { runId: 'run-seq-1', clientId: 'user-d' });
    await run1.start();
    const result1 = await run1.pipe(textResponseStream('msg-seq-1', 'text-seq-1', 'First response'));
    await run1.end('complete');
    expect(result1.reason).toBe('complete');

    // Run 2
    const run2 = createRunFromOpts(session, { runId: 'run-seq-2', clientId: 'user-d' });
    await run2.start();
    const result2 = await run2.pipe(textResponseStream('msg-seq-2', 'text-seq-2', 'Second response'));
    await run2.end('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    expect(accumulator.completedMessages).toHaveLength(2);
  });

  /**
   * Scenario: Concurrent runs.
   *
   * Starts two runs concurrently on the same session and verifies
   * both complete and are distinguishable by run IDs.
   */
  it('handles concurrent runs', async () => {
    const channelName = uniqueChannelName('st-concurrent');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
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
      const outputs = decoder.decode(msg);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) {
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

    // Both run IDs appear in raw messages
    const runIds = new Set(rawMessages.map((m) => getHeaders(m)[HEADER_RUN_ID]).filter(Boolean));
    expect(runIds.has('run-conc-1')).toBe(true);
    expect(runIds.has('run-conc-2')).toBe(true);
  });

  /**
   * Scenario: Error propagation mid-stream.
   *
   * The event stream throws an error. The transport returns reason "error"
   * and ends the run with an error reason. The subscriber sees the
   * run-end event with reason "error".
   */
  it('propagates stream errors', async () => {
    const channelName = uniqueChannelName('st-error');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
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

    // Stream that errors after some events
    const stream = new ReadableStream<AI.UIMessageChunk>({
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

    // Subscriber sees run-end with reason "error"
    const endMsg = rawMessages.find((m) => m.name === EVENT_RUN_END);
    expect(endMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(getHeaders(endMsg!)[HEADER_RUN_REASON]).toBe('error');
  });

  /**
   * Scenario: Multi-client sync — two subscribers see the same stream.
   *
   * Two subscriber clients on the same channel both receive the streamed
   * response from the server session.
   */
  it('multiple subscribers receive the same stream', async () => {
    const channelName = uniqueChannelName('st-sync');
    const serverClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();

    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
    });
    await session.connect();

    const { accumulator: acc1, done: done1 } = collectUntil(sub1Channel, hasFinish);
    const { accumulator: acc2, done: done2 } = collectUntil(sub2Channel, hasFinish);

    const run = createRunFromOpts(session, { runId: 'run-sync-1', clientId: 'user-h' });
    await run.start();
    await run.pipe(textResponseStream('msg-sync-1', 'text-sync-1', 'Shared response'));
    await run.end('complete');

    await Promise.all([done1, done2]);

    expect(acc1.completedMessages).toHaveLength(1);
    expect(acc2.completedMessages).toHaveLength(1);

    const text1 = acc1.completedMessages[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    const text2 = acc2.completedMessages[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(text1?.text).toBe('Shared response');
    expect(text2?.text).toBe('Shared response');
  });

  /**
   * Scenario: addMessages publishes user messages with correct headers.
   *
   * Verifies that addMessages stamps user role and run headers, and
   * that the assistant response auto-links its parent to the user message.
   */
  it('addMessages returns msg-ids and explicit parent links assistant', async () => {
    const channelName = uniqueChannelName('st-add-msgs');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
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
      const outputs = decoder.decode(msg);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) resolveFinish();
    });

    const run = createRunFromOpts(session, { runId: 'run-add-1', clientId: 'user-i' });
    await run.start();

    // Publish a user message
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

    // Stream assistant response — pass parent explicitly from addMessages result
    await run.pipe(textResponseStream('msg-reply-1', 'text-reply-1', 'Sunny!'), {
      parent: msgIds.at(-1),
    });
    await run.end('complete');

    await gotFinish;

    // Find a message with user role
    const userRoleMsg = rawMessages.find((m) => {
      const h = getHeaders(m);
      return h[HEADER_ROLE] === 'user';
    });
    expect(userRoleMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const userHeaders = getHeaders(userRoleMsg!);
    expect(userHeaders[HEADER_RUN_ID]).toBe('run-add-1');
    const userMsgId = userHeaders[HEADER_MSG_ID];
    expect(userMsgId).toBeDefined();

    // Find assistant message and verify parent links to user msg-id
    const assistantMsg = rawMessages.find((m) => {
      const h = getHeaders(m);
      return h[HEADER_ROLE] === 'assistant';
    });
    expect(assistantMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const assistantHeaders = getHeaders(assistantMsg!);
    expect(assistantHeaders[HEADER_PARENT]).toBe(userMsgId);
  });

  /**
   * Scenario: Channel continuity loss is surfaced via onError (AIT-ST12).
   *
   * The session is mid-run when the channel is detached. The developer's
   * onError callback must be invoked with a ChannelContinuityLost error so
   * they can decide whether to abort in-flight work.
   */
  it('invokes onError with ChannelContinuityLost when the channel detaches', async () => {
    const channelName = uniqueChannelName('st-continuity');
    const serverClient = ablyRealtimeClient();

    const errors: Ably.ErrorInfo[] = [];

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
      onError: (err) => errors.push(err),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
    await run.start();

    // Channel is ATTACHED after start() — any subsequent transition that
    // breaks continuity must surface via onError.
    await serverClient.channels.get(channelName).detach();

    await vi.waitFor(
      () => {
        expect(errors.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);
  });

  /**
   * Scenario: Per-event WriteOptions override via resolveWriteOptions.
   *
   * Streams a mix of text and tool-output chunks. The resolveWriteOptions
   * hook rewrites the tool-output-available chunk's `msgId` to a target
   * and attaches `x-ably-amend`. Verifies the received Ably messages
   * carry the expected headers: the text-start chunk uses the stream's
   * default `msgId`; the tool-output-available chunk uses the override
   * and carries `x-ably-amend`.
   */
  it('stamps per-event WriteOptions overrides on discrete publishes', async () => {
    const channelName = uniqueChannelName('st-resolve-write-options');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 0,
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

    const stream = new ReadableStream<AI.UIMessageChunk>({
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const textHeaders = getHeaders(textStartMsg!);
    // Stream operation: hook was ignored, default msg-id applies, no amend.
    expect(textHeaders[HEADER_MSG_ID]).not.toBe('target-msg-id');
    expect(textHeaders[HEADER_AMEND]).toBeUndefined();

    const toolMsg = rawMessages.find((m) => m.name === 'tool-output-available');
    expect(toolMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const toolHeaders = getHeaders(toolMsg!);
    // Discrete publish: hook overrode msg-id and added amend header.
    expect(toolHeaders[HEADER_MSG_ID]).toBe('target-msg-id');
    expect(toolHeaders[HEADER_AMEND]).toBe('target-msg-id');

    await run.end('complete');
  });

  /**
   * Scenario: prompt-not-found error propagation.
   *
   * When the agent's `lookupUserPrompt` deadline lapses without seeing a
   * matching user message, `run.start()` must reject with a PromptNotFound
   * `ErrorInfo` and publish a corresponding `x-ably-error` event on the
   * channel carrying both `x-ably-run-id` and `x-ably-invocation-id` so
   * clients can correlate the failure.
   */
  it('rejects start() and emits x-ably-error when the user prompt is not found within the lookup deadline', async () => {
    const channelName = uniqueChannelName('st-prompt-not-found');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();
    const subChannel = subClient.channels.get(channelName);

    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 200,
    });
    await session.connect();

    const errorMessages: Ably.InboundMessage[] = [];
    await subChannel.subscribe(EVENT_ERROR, (msg) => {
      errorMessages.push(msg);
    });

    const runId = crypto.randomUUID();
    const invocationId = crypto.randomUUID();

    const run = createRunFromOpts(session, {
      runId,
      invocationId,
      clientId: 'prompt-not-found-client',
      // Signal that the client published a user message — the agent will
      // then wait for it on the channel. We never publish one, so the wait
      // hits promptLookupTimeoutMs and emits PromptNotFound.
      userMessageCount: 1,
    });

    // start() must reject — the invocation has no matching user message on
    // the channel and `invocation.messages` is empty (createRunFromOpts).
    await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.PromptNotFound);

    // Poll briefly for the x-ably-error message to land. Real Ably has a
    // small propagation lag from publish to subscriber callback.
    for (let i = 0; i < 30 && errorMessages.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    const errMsg = errorMessages[0];
    expect(errMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded above
    const headers = getHeaders(errMsg!);
    expect(headers[HEADER_RUN_ID]).toBe(runId);
    expect(headers[HEADER_INVOCATION_ID]).toBe(invocationId);
    // The payload carries the error code so clients can dispatch on it.
    const data = errMsg?.data as { code?: number } | undefined;
    expect(data?.code).toBe(ErrorCode.PromptNotFound);
  });

  /**
   * Scenario: agent-not-running-at-publish (rewind buffer).
   *
   * The client publishes a user message before any agent is listening.
   * A fresh AgentSession attaches with a 2-minute rewind. The rewind
   * replays the user message through the session's unfiltered listener
   * before* `run.start()` registers a per-invocation prompt callback —
   * so the session must buffer the message by invocation-id and drain
   * the buffer when the callback is registered. Without the buffer the
   * lookup would wait the full `promptLookupTimeoutMs` for a live
   * arrival that never comes.
   */
  it('finds a rewind-replayed user prompt published before the agent attached', async () => {
    const channelName = uniqueChannelName('st-rewind-prompt');
    const publisherClient = ablyRealtimeClient();
    const publisherChannel = publisherClient.channels.get(channelName);
    await publisherChannel.attach();

    const runId = crypto.randomUUID();
    const invocationId = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    const text = 'Hello from the past';

    // Publish the user message before any agent session exists.
    const headers = buildTransportHeaders({ role: 'user', runId, msgId, invocationId });
    const encoder = UIMessageCodec.createEncoder(publisherChannel, { extras: { headers } });
    await encoder.writeMessages([{ id: msgId, role: 'user', parts: [{ type: 'text', text }] }]);

    // Now create the agent session — it attaches with rewind '2m' and
    // should pick up the prior publish.
    const serverClient = ablyRealtimeClient();
    session = createAgentSession({
      client: serverClient,
      channelName,
      codec: UIMessageCodec,
      promptLookupTimeoutMs: 5000,
    });
    await session.connect();

    const run = createRunFromOpts(session, {
      runId,
      invocationId,
      clientId: 'rewind-client',
      userMessageCount: 1,
    });

    await run.start();

    expect(run.view.messages.length).toBe(1);
    const found = run.view.messages[0];
    expect(found).toBeDefined();
    expect(found?.msgId).toBe(msgId);
    expect(found?.headers[HEADER_INVOCATION_ID]).toBe(invocationId);
    const message = found?.message;
    expect(message?.id).toBe(msgId);
    expect(message?.role).toBe('user');
    expect(message?.parts[0]).toEqual({ type: 'text', text });

    await run.end('complete');
  });
});
