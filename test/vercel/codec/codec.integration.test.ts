/**
 * Vercel UIMessageCodec integration tests.
 *
 * Validate encode → publish → subscribe → decode → accumulate roundtrips
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

import { HEADER_MSG_ID, HEADER_TURN_ID } from '../../../src/constants.js';
import type { DecoderOutput } from '../../../src/core/codec/types.js';
import { UIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { eventsOf, eventTypesOf } from '../../integration/helpers.js';

/**
 * Create an onMessage hook that stamps turn and message ID headers
 * on every outgoing Ably message.
 * @param turnId - The turn ID to stamp.
 * @param messageId - The message ID to stamp.
 * @returns An onMessage callback for encoder options.
 */
const stampHeaders = (turnId: string, messageId: string) => (msg: Ably.Message) => {
  // CAST: Ably SDK types `extras` as `any`; we trust the encoder always sets it.
  const headers = (msg.extras as { headers?: Record<string, string> } | undefined)?.headers;
  if (headers) {
    headers[HEADER_TURN_ID] = turnId;
    headers[HEADER_MSG_ID] = messageId;
  }
};

describe('Vercel UIMessageCodec integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  /**
   * Scenario 1: Text response roundtrip
   *
   * Encodes a complete text stream (start → text-start → text-delta(s) →
   * text-end → finish) through a real Ably channel and verifies the decoder
   * + accumulator reconstruct the expected UIMessage.
   */
  it('text response roundtrip', async () => {
    const channelName = uniqueChannelName('text-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-1';
    const textId = 'text-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    // Fire-and-forget deltas: encoder accumulates internally and flushes on close
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: ', ' });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'world!' });
    await encoder.appendEvent({ type: 'text-end', id: textId });
    await encoder.appendEvent({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('start');
    expect(types).toContain('start-step');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    expect(msg).toBeDefined();
    expect(msg?.role).toBe('assistant');

    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toBe('Hello, world!');
    expect(accumulator.hasActiveStream).toBe(false);
  });

  /**
   * Scenario 2: Tool call roundtrip
   *
   * Encodes a streamed tool-input (start → tool-input-start → tool-input-delta(s) →
   * tool-input-available → tool-output-available → finish) and verifies the
   * roundtrip produces the correct DynamicToolUIPart state transitions.
   */
  it('tool call roundtrip', async () => {
    const channelName = uniqueChannelName('tool-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-tool-1';
    const toolCallId = 'tc-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-tool-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({
      type: 'tool-input-start',
      toolCallId,
      toolName: 'get_weather',
    });
    void encoder.appendEvent({ type: 'tool-input-delta', toolCallId, inputTextDelta: '{"loc' });
    void encoder.appendEvent({ type: 'tool-input-delta', toolCallId, inputTextDelta: 'ation":"SF"}' });
    await encoder.appendEvent({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'get_weather',
      input: { location: 'SF' },
    });
    await encoder.appendEvent({
      type: 'tool-output-available',
      toolCallId,
      output: { temp: 72 },
    });
    await encoder.appendEvent({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('start');
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('finish');

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;

    const toolPart = msg?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolName).toBe('get_weather');
    expect(toolPart?.toolCallId).toBe(toolCallId);
    expect(toolPart?.state).toBe('output-available');
    expect(toolPart?.input).toEqual({ location: 'SF' });
    expect(toolPart?.output).toEqual({ temp: 72 });
  });

  /**
   * Scenario 3: Discrete tool call (non-streaming)
   *
   * Publishes a tool-input-available without a preceding tool-input-start,
   * verifying the encoder falls back to discrete publish and the decoder
   * synthesizes tool-input-start + tool-input-available events.
   */
  it('non-streaming tool call roundtrip', async () => {
    const channelName = uniqueChannelName('discrete-tool');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-dt-1';
    const toolCallId = 'tc-discrete-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-dt-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'calculator',
      input: { expression: '2+2' },
    });
    await encoder.appendEvent({
      type: 'tool-output-available',
      toolCallId,
      output: { result: 4 },
    });
    await encoder.appendEvent({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    const toolPart = msg?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolName).toBe('calculator');
    expect(toolPart?.state).toBe('output-available');
    expect(toolPart?.input).toEqual({ expression: '2+2' });
    expect(toolPart?.output).toEqual({ result: 4 });
  });

  /**
   * Scenario 4: Abort mid-stream
   *
   * Starts a text stream, sends some deltas, then aborts. Verifies the
   * encoder sends the abort signal and the decoder/accumulator handle
   * the aborted stream correctly.
   */
  it('abort mid-stream', async () => {
    const channelName = uniqueChannelName('abort');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-abort-1';
    const textId = 'text-abort-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveAbort: () => void;
    const aborted = new Promise<void>((r) => {
      resolveAbort = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'abort')) {
        resolveAbort();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-abort-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: ', wo' });
    await encoder.appendEvent({ type: 'abort', reason: 'user cancelled' });
    await encoder.close();

    await aborted;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('abort');

    expect(accumulator.completedMessages).toHaveLength(1);
    expect(accumulator.hasActiveStream).toBe(false);
  });

  /**
   * Scenario 5: History hydration via channel history
   *
   * Publishes a complete text stream, then fetches channel history
   * and feeds it through a fresh decoder + accumulator. Verifies
   * the decoder handles history messages correctly.
   */
  it('history hydration', async () => {
    const channelName = uniqueChannelName('history');
    const pubClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);

    const messageId = 'msg-hist-1';
    const textId = 'text-hist-1';

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-hist-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'History ' });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.appendEvent({ type: 'text-end', id: textId });
    await encoder.appendEvent({ type: 'finish', finishReason: 'stop' });
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
    const accumulator = UIMessageCodec.createAccumulator();

    for (const msg of historyMessages) {
      const outputs = decoder.decode(msg);
      accumulator.processOutputs(outputs);
    }

    expect(accumulator.messages.length).toBeGreaterThanOrEqual(1);

    const textMsg = accumulator.messages.find((m) =>
      m.parts.some((p) => p.type === 'text' && p.text.includes('History test.')),
    );
    expect(textMsg).toBeDefined();
  });

  /**
   * Scenario 6: Multi-client sync
   *
   * Two subscribers on the same channel both receive a streamed response.
   * Verifies both decoders/accumulators reconstruct the same message.
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
    const accumulator1 = UIMessageCodec.createAccumulator();
    const decoder2 = UIMessageCodec.createDecoder();
    const accumulator2 = UIMessageCodec.createAccumulator();

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
      const outputs = decoder1.decode(msg);
      accumulator1.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) resolve1();
    });

    await sub2Channel.subscribe((msg) => {
      const outputs = decoder2.decode(msg);
      accumulator2.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) resolve2();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-multi-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'Sync ' });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.appendEvent({ type: 'text-end', id: textId });
    await encoder.appendEvent({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await Promise.all([finished1, finished2]);

    expect(accumulator1.completedMessages).toHaveLength(1);
    expect(accumulator2.completedMessages).toHaveLength(1);

    const text1 = accumulator1.completedMessages[0]?.parts.find(
      (p): p is AI.TextUIPart => p.type === 'text',
    );
    const text2 = accumulator2.completedMessages[0]?.parts.find(
      (p): p is AI.TextUIPart => p.type === 'text',
    );
    expect(text1?.text).toBe('Sync test.');
    expect(text2?.text).toBe('Sync test.');
  });

  /**
   * Scenario 7: Reasoning stream roundtrip
   *
   * Verifies reasoning content streams through the codec correctly.
   */
  it('reasoning stream roundtrip', async () => {
    const channelName = uniqueChannelName('reasoning');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-reason-1';
    const reasoningId = 'reason-1';
    const textId = 'text-after-reason-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'finish')) resolveFinish();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-reason-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'reasoning-start', id: reasoningId });
    void encoder.appendEvent({ type: 'reasoning-delta', id: reasoningId, delta: 'Let me think...' });
    await encoder.appendEvent({ type: 'reasoning-end', id: reasoningId });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'The answer is 42.' });
    await encoder.appendEvent({ type: 'text-end', id: textId });
    await encoder.appendEvent({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('reasoning-start');
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('reasoning-end');
    expect(types).toContain('text-start');
    expect(types).toContain('text-end');

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;

    const reasoningPart = msg?.parts.find((p): p is AI.ReasoningUIPart => p.type === 'reasoning');
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart?.text).toBe('Let me think...');

    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toBe('The answer is 42.');
  });

  /**
   * Scenario 8: Error propagation
   *
   * Server publishes an error event mid-stream. Verifies the decoder
   * surfaces the error event.
   */
  it('error propagation mid-stream', async () => {
    const channelName = uniqueChannelName('error-prop');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    const accumulator = UIMessageCodec.createAccumulator();

    const messageId = 'msg-err-1';
    const textId = 'text-err-1';

    const allOutputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[] = [];
    let resolveError: () => void;
    const gotError = new Promise<void>((r) => {
      resolveError = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'error')) resolveError();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-err-1', messageId),
    });

    await encoder.appendEvent({ type: 'start', messageId });
    await encoder.appendEvent({ type: 'start-step' });
    await encoder.appendEvent({ type: 'text-start', id: textId });
    void encoder.appendEvent({ type: 'text-delta', id: textId, delta: 'Partial...' });
    await encoder.appendEvent({ type: 'error', errorText: 'model rate limit exceeded' });
    await encoder.close();

    await gotError;

    const types = eventTypesOf(allOutputs);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('error');

    const errorEvent = eventsOf(allOutputs).find(
      (e): e is Extract<AI.UIMessageChunk, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.errorText).toBe('model rate limit exceeded');
  });
});
