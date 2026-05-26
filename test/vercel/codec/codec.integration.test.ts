/**
 * Vercel UIMessageCodec integration tests.
 *
 * Validate encode -> publish -> subscribe -> decode -> fold roundtrips
 * over real Ably channels using message appends. These tests prove the
 * wire format and Ably message serialization work end-to-end without
 * transport machinery.
 *
 * Each test uses a unique channel name in the `mutable:` namespace and
 * a dedicated Ably client pair (publisher + subscriber) to avoid crosstalk.
 * The sandbox app is created by the globalSetup in test-setup.ts.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import { UIMessageCodec, type VercelEvent, type VercelProjection } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { eventsOf, eventTypesOf } from '../../integration/helpers.js';

/**
 * Create an onMessage hook that stamps run and message ID headers
 * on every outgoing Ably message.
 * @param runId - The run ID to stamp.
 * @param messageId - The message ID to stamp.
 * @returns An onMessage callback for encoder options.
 */
const stampHeaders = (runId: string, messageId: string) => (msg: Ably.Message) => {
  // CAST: Ably SDK types `extras` as `any`; we trust the encoder always sets it.
  const headers = (msg.extras as { headers?: Record<string, string> } | undefined)?.headers;
  if (headers) {
    headers[HEADER_RUN_ID] = runId;
    headers[HEADER_CODEC_MESSAGE_ID] = messageId;
  }
};

/**
 * Read `x-ably-codec-message-id` and serial from an Ably inbound message for the reducer meta.
 * @param msg - The Ably inbound message to read meta from.
 * @returns A ReducerMeta-shaped object carrying serial and optional messageId.
 */
const metaOf = (msg: Ably.InboundMessage): { serial: string; messageId?: string } => {
  // CAST: Ably SDK types `extras` as `any`; we trust the runtime shape.
  const headers = (msg.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
  const messageId = headers[HEADER_CODEC_MESSAGE_ID];
  return messageId === undefined ? { serial: msg.serial ?? '' } : { serial: msg.serial ?? '', messageId };
};

/**
 * Fold a batch of decoder events into the projection, stamping each with
 * the right ReducerMeta carried from the source Ably message.
 * @param state - Current projection to fold into.
 * @param events - Decoder events to fold.
 * @param msg - Source Ably inbound message (used to derive meta).
 * @returns The updated projection.
 */
const foldBatch = (state: VercelProjection, events: VercelEvent[], msg: Ably.InboundMessage): VercelProjection => {
  const meta = metaOf(msg);
  for (const event of events) {
    state = UIMessageCodec.fold(state, event, meta);
  }
  return state;
};

describe('Vercel UIMessageCodec integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  /**
   * Scenario 1: Text response roundtrip
   *
   * Encodes a complete text stream (start -> text-start -> text-delta(s) ->
   * text-end -> finish) through a real Ably channel and verifies the decoder
   * + reducer reconstruct the expected UIMessage.
   */
  it('text response roundtrip', async () => {
    const channelName = uniqueChannelName('text-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-1';
    const textId = 'text-1';

    const allEvents: VercelEvent[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);

      if (eventsOf(events).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'text-start', id: textId });
    // Fire-and-forget deltas: encoder accumulates internally and flushes on close
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.publish({ type: 'text-delta', id: textId, delta: ', ' });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'world!' });
    await encoder.publish({ type: 'text-end', id: textId });
    await encoder.publish({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('start');
    expect(types).toContain('start-step');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg).toBeDefined();
    expect(msg?.role).toBe('assistant');

    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toBe('Hello, world!');
  });

  /**
   * Scenario 2: Tool call roundtrip
   */
  it('tool call roundtrip', async () => {
    const channelName = uniqueChannelName('tool-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-tool-1';
    const toolCallId = 'tc-1';

    const allEvents: VercelEvent[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);

      if (eventsOf(events).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-tool-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({
      type: 'tool-input-start',
      toolCallId,
      toolName: 'get_weather',
    });
    void encoder.publish({ type: 'tool-input-delta', toolCallId, inputTextDelta: '{"loc' });
    void encoder.publish({ type: 'tool-input-delta', toolCallId, inputTextDelta: 'ation":"SF"}' });
    await encoder.publish({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'get_weather',
      input: { location: 'SF' },
    });
    await encoder.publish({
      type: 'tool-output-available',
      toolCallId,
      output: { temp: 72 },
    });
    await encoder.publish({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('start');
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    const [msg] = messages;

    const toolPart = msg?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolName).toBe('get_weather');
    expect(toolPart?.toolCallId).toBe(toolCallId);
    expect(toolPart?.state).toBe('output-available');
    if (toolPart?.state === 'output-available' || toolPart?.state === 'input-available') {
      expect(toolPart.input).toEqual({ location: 'SF' });
    }
    if (toolPart?.state === 'output-available') {
      expect(toolPart.output).toEqual({ temp: 72 });
    }
  });

  /**
   * Scenario 3: Discrete tool call (non-streaming)
   */
  it('non-streaming tool call roundtrip', async () => {
    const channelName = uniqueChannelName('discrete-tool');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-dt-1';
    const toolCallId = 'tc-discrete-1';

    const allEvents: VercelEvent[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);

      if (eventsOf(events).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-dt-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'calculator',
      input: { expression: '2+2' },
    });
    await encoder.publish({
      type: 'tool-output-available',
      toolCallId,
      output: { result: 4 },
    });
    await encoder.publish({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    const toolPart = msg?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolName).toBe('calculator');
    expect(toolPart?.state).toBe('output-available');
    if (toolPart?.state === 'output-available') {
      expect(toolPart.input).toEqual({ expression: '2+2' });
      expect(toolPart.output).toEqual({ result: 4 });
    }
  });

  /**
   * Scenario 4: Abort mid-stream
   */
  it('abort mid-stream', async () => {
    const channelName = uniqueChannelName('abort');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-abort-1';
    const textId = 'text-abort-1';

    const allEvents: VercelEvent[] = [];
    let resolveAbort: () => void;
    const aborted = new Promise<void>((r) => {
      resolveAbort = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);

      if (eventsOf(events).some((e) => e.type === 'abort')) {
        resolveAbort();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-abort-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'text-start', id: textId });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.publish({ type: 'text-delta', id: textId, delta: ', wo' });
    await encoder.publish({ type: 'abort', reason: 'user cancelled' });
    await encoder.close();

    await aborted;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('abort');

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
  });

  /**
   * Scenario 5: History hydration via channel history
   */
  it('history hydration', async () => {
    const channelName = uniqueChannelName('history');
    const pubClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);

    const messageId = 'msg-hist-1';
    const textId = 'text-hist-1';

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-hist-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'text-start', id: textId });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'History ' });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.publish({ type: 'text-end', id: textId });
    await encoder.publish({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    // Wait for Ably's history API to become consistent — real network propagation
    // cannot be flushed with microtasks.
    await new Promise((r) => setTimeout(r, 1000));

    const histClient = ablyRealtimeClient();
    const histChannel = histClient.channels.get(channelName);

    const historyPage = await histChannel.history({ direction: 'forwards' });
    const historyMessages = historyPage.items;

    expect(historyMessages.length).toBeGreaterThan(0);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    for (const msg of historyMessages) {
      const events = decoder.decode(msg);
      projection = foldBatch(projection, events, msg);
    }

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const textMsg = messages.find((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('History test.')));
    expect(textMsg).toBeDefined();
  });

  /**
   * Scenario 6: Multi-client sync
   */
  it('multi-client sync', async () => {
    const channelName = uniqueChannelName('multi-client');
    const pubClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    const decoder1 = UIMessageCodec.createDecoder();
    let projection1 = UIMessageCodec.init();
    const decoder2 = UIMessageCodec.createDecoder();
    let projection2 = UIMessageCodec.init();

    const messageId = 'msg-multi-1';
    const textId = 'text-multi-1';

    let resolve1: () => void;
    let resolve2: () => void;
    const finished1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    const finished2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    await sub1Channel.subscribe((msg) => {
      const events = decoder1.decode(msg);
      projection1 = foldBatch(projection1, events, msg);
      if (eventsOf(events).some((e) => e.type === 'finish')) resolve1();
    });

    await sub2Channel.subscribe((msg) => {
      const events = decoder2.decode(msg);
      projection2 = foldBatch(projection2, events, msg);
      if (eventsOf(events).some((e) => e.type === 'finish')) resolve2();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-multi-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'text-start', id: textId });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'Sync ' });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.publish({ type: 'text-end', id: textId });
    await encoder.publish({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await Promise.all([finished1, finished2]);

    const messages1 = UIMessageCodec.getMessages(projection1);
    const messages2 = UIMessageCodec.getMessages(projection2);
    expect(messages1).toHaveLength(1);
    expect(messages2).toHaveLength(1);

    const text1 = messages1[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    const text2 = messages2[0]?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(text1?.text).toBe('Sync test.');
    expect(text2?.text).toBe('Sync test.');
  });

  /**
   * Scenario 7: Reasoning stream roundtrip
   */
  it('reasoning stream roundtrip', async () => {
    const channelName = uniqueChannelName('reasoning');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-reason-1';
    const reasoningId = 'reason-1';
    const textId = 'text-after-reason-1';

    const allEvents: VercelEvent[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);
      if (eventsOf(events).some((e) => e.type === 'finish')) resolveFinish();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-reason-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'reasoning-start', id: reasoningId });
    void encoder.publish({ type: 'reasoning-delta', id: reasoningId, delta: 'Let me think...' });
    await encoder.publish({ type: 'reasoning-end', id: reasoningId });
    await encoder.publish({ type: 'text-start', id: textId });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'The answer is 42.' });
    await encoder.publish({ type: 'text-end', id: textId });
    await encoder.publish({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('reasoning-start');
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('reasoning-end');
    expect(types).toContain('text-start');
    expect(types).toContain('text-end');

    const messages = UIMessageCodec.getMessages(projection);
    expect(messages).toHaveLength(1);
    const [msg] = messages;

    const reasoningPart = msg?.parts.find((p): p is AI.ReasoningUIPart => p.type === 'reasoning');
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart?.text).toBe('Let me think...');

    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toBe('The answer is 42.');
  });

  /**
   * Scenario 8: Error propagation
   */
  it('error propagation mid-stream', async () => {
    const channelName = uniqueChannelName('error-prop');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-err-1';
    const textId = 'text-err-1';

    const allEvents: VercelEvent[] = [];
    let resolveError: () => void;
    const gotError = new Promise<void>((r) => {
      resolveError = r;
    });

    await subChannel.subscribe((msg) => {
      const events = decoder.decode(msg);
      allEvents.push(...events);
      projection = foldBatch(projection, events, msg);
      if (eventsOf(events).some((e) => e.type === 'error')) resolveError();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('run-err-1', messageId),
    });

    await encoder.publish({ type: 'start', messageId });
    await encoder.publish({ type: 'start-step' });
    await encoder.publish({ type: 'text-start', id: textId });
    void encoder.publish({ type: 'text-delta', id: textId, delta: 'Partial...' });
    await encoder.publish({ type: 'error', errorText: 'model rate limit exceeded' });
    await encoder.close();

    await gotError;

    const types = eventTypesOf(allEvents);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('error');

    const errorEvent = eventsOf(allEvents).find(
      (e): e is Extract<AI.UIMessageChunk, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.errorText).toBe('model rate limit exceeded');
  });
});
