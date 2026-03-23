/**
 * ServerTransport integration tests.
 *
 * Validate the full server-side turn lifecycle over real Ably channels
 * using the Vercel UIMessageCodec. Each test creates a ServerTransport
 * on a unique channel and a separate subscriber client to verify messages
 * arrive correctly.
 *
 * These tests prove the wire protocol, turn lifecycle events, cancel
 * routing, and stream piping work end-to-end over real Ably infrastructure.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_CANCEL_TURN_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../../src/constants.js';
import type { DecoderOutput } from '../../../src/core/codec/types.js';
import { createServerTransport } from '../../../src/core/transport/server-transport.js';
import type { ServerTransport } from '../../../src/core/transport/types.js';
import { getHeaders } from '../../../src/utils.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
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
 * Check if a message is a turn-end lifecycle event.
 * @param msg - The Ably message to check.
 * @returns True if the message name is turn-end.
 */
const isTurnEnd = (msg: Ably.InboundMessage): boolean => msg.name === EVENT_TURN_END;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerTransport integration', () => {
  let transport: ServerTransport<AI.UIMessageChunk, AI.UIMessage> | undefined;

  afterEach(() => {
    transport?.close();
    transport = undefined;
    closeAllClients();
  });

  /**
   * Scenario: Full transport text response roundtrip.
   *
   * Creates a ServerTransport, starts a turn, streams a text response,
   * and verifies a subscriber receives the complete decoded message
   * with correct transport headers.
   */
  it('streams a text response through the transport', async () => {
    const channelName = uniqueChannelName('st-text');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    const { allOutputs, accumulator, rawMessages, done } = collectUntil(subChannel, hasFinish);

    const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
    await turn.start();

    const stream = textResponseStream('msg-1', 'text-1', 'Hello, world!');
    const result = await turn.streamResponse(stream);
    await turn.end('complete');

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
    const streamMsg = rawMessages.find((m) => m.name !== EVENT_TURN_START && m.name !== EVENT_TURN_END);
    expect(streamMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const headers = getHeaders(streamMsg!);
    expect(headers[HEADER_ROLE]).toBe('assistant');
    expect(headers[HEADER_TURN_ID]).toBe('turn-1');
    expect(headers[HEADER_MSG_ID]).toBeDefined();
  });

  /**
   * Scenario: Turn lifecycle events are published.
   *
   * Verifies the subscriber receives turn-start and turn-end events
   * with correct headers.
   */
  it('publishes turn-start and turn-end events', async () => {
    const channelName = uniqueChannelName('st-lifecycle');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    const lifecycleMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      lifecycleMessages.push(msg);
      if (isTurnEnd(msg)) resolveEnd();
    });

    const turn = transport.newTurn({ turnId: 'turn-lc-1', clientId: 'user-b' });
    await turn.start();

    const stream = textResponseStream('msg-lc-1', 'text-lc-1', 'test');
    await turn.streamResponse(stream);
    await turn.end('complete');

    await gotEnd;

    const startMsg = lifecycleMessages.find((m) => m.name === EVENT_TURN_START);
    expect(startMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const startHeaders = getHeaders(startMsg!);
    expect(startHeaders[HEADER_TURN_ID]).toBe('turn-lc-1');

    const endMsg = lifecycleMessages.find((m) => m.name === EVENT_TURN_END);
    expect(endMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const endHeaders = getHeaders(endMsg!);
    expect(endHeaders[HEADER_TURN_ID]).toBe('turn-lc-1');
    expect(endHeaders[HEADER_TURN_REASON]).toBe('complete');
  });

  /**
   * Scenario: Cancel chain — client publishes cancel, server stream aborts.
   *
   * Starts a long-running stream, publishes a cancel message from a
   * separate client, and verifies the stream is cancelled.
   */
  it('cancels a turn via channel cancel message', async () => {
    const channelName = uniqueChannelName('st-cancel');
    const serverClient = ablyRealtimeClient();
    const cancelClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const cancelChannel = cancelClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    const turn = transport.newTurn({ turnId: 'turn-cancel-1', clientId: 'user-c' });
    await turn.start();

    // Create a stream that never closes — it will be cancelled
    const stream = new ReadableStream<AI.UIMessageChunk>({
      start: (ctrl) => {
        ctrl.enqueue({ type: 'start', messageId: 'msg-cancel-1' });
        ctrl.enqueue({ type: 'start-step' });
        ctrl.enqueue({ type: 'text-start', id: 'text-cancel-1' });
        ctrl.enqueue({ type: 'text-delta', id: 'text-cancel-1', delta: 'Partial...' });
      },
    });

    const streamPromise = turn.streamResponse(stream);

    // Give the stream time to start publishing
    await new Promise((r) => setTimeout(r, 500));

    // Publish cancel from another client
    await cancelChannel.publish({
      name: EVENT_CANCEL,
      extras: {
        headers: { [HEADER_CANCEL_TURN_ID]: 'turn-cancel-1' },
      },
    });

    const result = await streamPromise;
    expect(result.reason).toBe('cancelled');
    expect(turn.abortSignal.aborted).toBe(true);

    await turn.end('cancelled');
  });

  /**
   * Scenario: Multi-turn sequential.
   *
   * Runs two turns sequentially on the same transport and verifies
   * both complete successfully.
   */
  it('handles sequential turns', async () => {
    const channelName = uniqueChannelName('st-multi-turn');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

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

    // Turn 1
    const turn1 = transport.newTurn({ turnId: 'turn-seq-1', clientId: 'user-d' });
    await turn1.start();
    const result1 = await turn1.streamResponse(textResponseStream('msg-seq-1', 'text-seq-1', 'First response'));
    await turn1.end('complete');
    expect(result1.reason).toBe('complete');

    // Turn 2
    const turn2 = transport.newTurn({ turnId: 'turn-seq-2', clientId: 'user-d' });
    await turn2.start();
    const result2 = await turn2.streamResponse(textResponseStream('msg-seq-2', 'text-seq-2', 'Second response'));
    await turn2.end('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    expect(accumulator.completedMessages).toHaveLength(2);
  });

  /**
   * Scenario: Concurrent turns.
   *
   * Starts two turns concurrently on the same transport and verifies
   * both complete and are distinguishable by turn ID.
   */
  it('handles concurrent turns', async () => {
    const channelName = uniqueChannelName('st-concurrent');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

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

    const turn1 = transport.newTurn({ turnId: 'turn-conc-1', clientId: 'user-e' });
    const turn2 = transport.newTurn({ turnId: 'turn-conc-2', clientId: 'user-f' });

    await Promise.all([turn1.start(), turn2.start()]);

    const [result1, result2] = await Promise.all([
      turn1.streamResponse(textResponseStream('msg-conc-1', 'text-conc-1', 'Response A')),
      turn2.streamResponse(textResponseStream('msg-conc-2', 'text-conc-2', 'Response B')),
    ]);

    await Promise.all([turn1.end('complete'), turn2.end('complete')]);

    expect(result1.reason).toBe('complete');
    expect(result2.reason).toBe('complete');

    await twoFinishes;

    // Both turn IDs appear in raw messages
    const turnIds = new Set(rawMessages.map((m) => getHeaders(m)[HEADER_TURN_ID]).filter(Boolean));
    expect(turnIds.has('turn-conc-1')).toBe(true);
    expect(turnIds.has('turn-conc-2')).toBe(true);
  });

  /**
   * Scenario: Error propagation mid-stream.
   *
   * The event stream throws an error. The transport returns reason "error"
   * and ends the turn with an error reason. The subscriber sees the
   * turn-end event with reason "error".
   */
  it('propagates stream errors', async () => {
    const channelName = uniqueChannelName('st-error');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    const rawMessages: Ably.InboundMessage[] = [];
    let resolveEnd: () => void;
    const gotEnd = new Promise<void>((r) => {
      resolveEnd = r;
    });

    await subChannel.subscribe((msg) => {
      rawMessages.push(msg);
      if (isTurnEnd(msg)) resolveEnd();
    });

    const turn = transport.newTurn({ turnId: 'turn-err-1', clientId: 'user-g' });
    await turn.start();

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

    const result = await turn.streamResponse(stream);
    expect(result.reason).toBe('error');

    await turn.end('error');
    await gotEnd;

    // Subscriber sees turn-end with reason "error"
    const endMsg = rawMessages.find((m) => m.name === EVENT_TURN_END);
    expect(endMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(getHeaders(endMsg!)[HEADER_TURN_REASON]).toBe('error');
  });

  /**
   * Scenario: Multi-client sync — two subscribers see the same stream.
   *
   * Two subscriber clients on the same channel both receive the streamed
   * response from the server transport.
   */
  it('multiple subscribers receive the same stream', async () => {
    const channelName = uniqueChannelName('st-sync');
    const serverClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

    const { accumulator: acc1, done: done1 } = collectUntil(sub1Channel, hasFinish);
    const { accumulator: acc2, done: done2 } = collectUntil(sub2Channel, hasFinish);

    const turn = transport.newTurn({ turnId: 'turn-sync-1', clientId: 'user-h' });
    await turn.start();
    await turn.streamResponse(textResponseStream('msg-sync-1', 'text-sync-1', 'Shared response'));
    await turn.end('complete');

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
   * Verifies that addMessages stamps user role and turn headers, and
   * that the assistant response auto-links its parent to the user message.
   */
  it('addMessages publishes user messages and auto-links parent', async () => {
    const channelName = uniqueChannelName('st-add-msgs');
    const serverClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const serverChannel = serverClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    transport = createServerTransport({
      channel: serverChannel,
      codec: UIMessageCodec,
    });

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

    const turn = transport.newTurn({ turnId: 'turn-add-1', clientId: 'user-i' });
    await turn.start();

    // Publish a user message
    const userMessage: AI.UIMessage = {
      id: 'user-msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'What is the weather?' }],
    };
    await turn.addMessages([{ message: userMessage }]);

    // Stream assistant response
    await turn.streamResponse(textResponseStream('msg-reply-1', 'text-reply-1', 'Sunny!'));
    await turn.end('complete');

    await gotFinish;

    // Find a message with user role
    const userRoleMsg = rawMessages.find((m) => {
      const h = getHeaders(m);
      return h[HEADER_ROLE] === 'user';
    });
    expect(userRoleMsg).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const userHeaders = getHeaders(userRoleMsg!);
    expect(userHeaders[HEADER_TURN_ID]).toBe('turn-add-1');
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
});
