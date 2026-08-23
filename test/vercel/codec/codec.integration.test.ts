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

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import { toCodecEvents } from '../../../src/core/transport/session-codec.js';
import { getCodecHeaders, getTransportHeaders } from '../../../src/utils.js';
import type { VercelOutput } from '../../../src/vercel/codec/index.js';
import { type VercelProjection } from '../../../src/vercel/codec/reducer.js';
import { createUIMessageSessionCodec } from '../../../src/vercel/codec/session-codec.js';
import type { VercelSessionInput } from '../../../src/vercel/codec/session-events.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

const UIMessageCodec = createUIMessageSessionCodec();

/**
 * Create an onAblyMessage hook that stamps run and message ID headers
 * on every outgoing Ably message.
 * @param runId - The run ID to stamp.
 * @param messageId - The message ID to stamp.
 * @returns An onAblyMessage callback for encoder options.
 */
const stampHeaders = (runId: string, messageId: string) => (msg: Ably.Message) => {
  // CAST: Ably SDK types `extras` as `any`; we trust the encoder always sets it.
  // run-id and codec-message-id are transport-tier headers.
  const transport = (msg.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
  if (transport) {
    transport[HEADER_RUN_ID] = runId;
    transport[HEADER_CODEC_MESSAGE_ID] = messageId;
  }
};

/**
 * Read `codec-message-id` and serial from an Ably inbound message for the reducer meta.
 * @param msg - The Ably inbound message to read meta from.
 * @returns A ReducerMeta-shaped object carrying serial and optional messageId.
 */
const metaOf = (msg: Ably.InboundMessage): { serial: string; messageId?: string } => {
  // codec-message-id is a transport-tier header.
  const headers = getTransportHeaders(msg);
  const messageId = headers[HEADER_CODEC_MESSAGE_ID];
  return messageId === undefined ? { serial: msg.serial ?? '' } : { serial: msg.serial ?? '', messageId };
};

/**
 * Fold the decoded inputs + outputs into the projection, stamping each
 * with the right ReducerMeta from the source Ably message.
 * @param state - Current projection to fold into.
 * @param decoded - DecodedMessage from `decoder.decode(msg)`.
 * @param decoded.inputs - Decoded input events to fold first.
 * @param decoded.outputs - Decoded output events to fold after the inputs.
 * @param msg - Source Ably inbound message (used to derive meta).
 * @returns The updated projection.
 */
const foldDecoded = (
  state: VercelProjection,
  decoded: { inputs: VercelSessionInput[]; outputs: VercelOutput[] },
  msg: Ably.InboundMessage,
): VercelProjection => {
  const meta = metaOf(msg);
  for (const event of toCodecEvents(decoded)) {
    state = UIMessageCodec.fold(state, event, meta);
  }
  return state;
};

const outputTypesOf = (outputs: VercelOutput[]): string[] => outputs.map((e) => e.type);

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

    const allOutputs: VercelOutput[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);

      if (decoded.outputs.some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    // Fire-and-forget deltas: encoder accumulates internally and flushes on close
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: ', ' });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'world!' });
    await encoder.publishOutput({ type: 'text-end', id: textId });
    await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('start');
    expect(types).toContain('start-step');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg).toBeDefined();
    expect(msg?.role).toBe('assistant');

    const textPart = msg?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toBe('Hello, world!');
  });

  /**
   * Scenario 2: Dynamic tool call roundtrip
   */
  it('dynamic tool call roundtrip', async () => {
    const channelName = uniqueChannelName('tool-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-tool-1';
    const toolCallId = 'tc-1';

    const allOutputs: VercelOutput[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);

      if (decoded.outputs.some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-tool-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({
      type: 'tool-input-start',
      toolCallId,
      toolName: 'get_weather',
      dynamic: true,
    });
    void encoder.publishOutput({ type: 'tool-input-delta', toolCallId, inputTextDelta: '{"loc' });
    void encoder.publishOutput({ type: 'tool-input-delta', toolCallId, inputTextDelta: 'ation":"SF"}' });
    await encoder.publishOutput({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'get_weather',
      input: { location: 'SF' },
      dynamic: true,
    });
    await encoder.publishOutput({
      type: 'tool-output-available',
      toolCallId,
      output: { temp: 72 },
    });
    await encoder.publishOutput({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('start');
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('finish');

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
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
   * Scenario 2b: Static tool call roundtrip — a statically-declared tool
   * (no `dynamic` flag) must survive encode → decode → fold with its
   * `tool-<name>` type intact, not collapse to `dynamic-tool`.
   */
  it('static tool call roundtrip preserves the tool-<name> type', async () => {
    const channelName = uniqueChannelName('tool-roundtrip-static');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-tool-static-1';
    const toolCallId = 'tc-static-1';

    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      projection = foldDecoded(projection, decoded, msg);
      if (decoded.outputs.some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-tool-static-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    // No `dynamic` flag — a statically-declared tool.
    await encoder.publishOutput({ type: 'tool-input-start', toolCallId, toolName: 'get_weather' });
    void encoder.publishOutput({ type: 'tool-input-delta', toolCallId, inputTextDelta: '{"loc' });
    void encoder.publishOutput({ type: 'tool-input-delta', toolCallId, inputTextDelta: 'ation":"SF"}' });
    await encoder.publishOutput({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'get_weather',
      input: { location: 'SF' },
    });
    await encoder.publishOutput({ type: 'tool-output-available', toolCallId, output: { temp: 72 } });
    await encoder.publishOutput({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
    expect(messages).toHaveLength(1);
    const [msg] = messages;

    // The part keeps its static `tool-get_weather` type — not `dynamic-tool`.
    const toolPart = msg?.parts.find((p): p is AI.ToolUIPart => p.type === 'tool-get_weather');
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolCallId).toBe(toolCallId);
    expect(toolPart?.state).toBe('output-available');
    // A static tool part carries no separate toolName — the name is in `type`.
    expect(toolPart && 'toolName' in toolPart).toBe(false);
    if (toolPart?.state === 'output-available') {
      expect(toolPart.input).toEqual({ location: 'SF' });
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

    const allOutputs: VercelOutput[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);

      if (decoded.outputs.some((e) => e.type === 'finish')) {
        resolveFinish();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-dt-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({
      type: 'tool-input-available',
      toolCallId,
      toolName: 'calculator',
      input: { expression: '2+2' },
      dynamic: true,
    });
    await encoder.publishOutput({
      type: 'tool-output-available',
      toolCallId,
      output: { result: 4 },
    });
    await encoder.publishOutput({ type: 'finish', finishReason: 'tool-calls' });
    await encoder.close();

    await finished;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
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
   * Scenario 4: Cancel mid-stream
   */
  it('cancel mid-stream', async () => {
    const channelName = uniqueChannelName('abort');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = UIMessageCodec.createDecoder();
    let projection = UIMessageCodec.init();

    const messageId = 'msg-abort-1';
    const textId = 'text-abort-1';

    const allOutputs: VercelOutput[] = [];
    let resolveCancel: () => void;
    const cancelled = new Promise<void>((r) => {
      resolveCancel = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);

      if (decoded.outputs.some((e) => e.type === 'abort')) {
        resolveCancel();
      }
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-abort-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'Hello' });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: ', wo' });
    // The agent's stream emits an abort chunk as ordinary content; cancellation
    // then closes the open text stream as cancelled via cancelStreams() — the
    // same two steps pipeStream performs on the cancel path.
    await encoder.publishOutput({ type: 'abort', reason: 'user cancelled' });
    await encoder.cancelStreams();
    await encoder.close();

    await cancelled;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('abort');

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
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
      onAblyMessage: stampHeaders('run-hist-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'History ' });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.publishOutput({ type: 'text-end', id: textId });
    await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });
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
      const decoded = decoder.decode(msg);
      projection = foldDecoded(projection, decoded, msg);
    }

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
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
      const decoded = decoder1.decode(msg);
      projection1 = foldDecoded(projection1, decoded, msg);
      if (decoded.outputs.some((e) => e.type === 'finish')) resolve1();
    });

    await sub2Channel.subscribe((msg) => {
      const decoded = decoder2.decode(msg);
      projection2 = foldDecoded(projection2, decoded, msg);
      if (decoded.outputs.some((e) => e.type === 'finish')) resolve2();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-multi-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'Sync ' });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'test.' });
    await encoder.publishOutput({ type: 'text-end', id: textId });
    await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await Promise.all([finished1, finished2]);

    const messages1 = UIMessageCodec.getMessages(projection1).map((m) => m.message);
    const messages2 = UIMessageCodec.getMessages(projection2).map((m) => m.message);
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

    const allOutputs: VercelOutput[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);
      if (decoded.outputs.some((e) => e.type === 'finish')) resolveFinish();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-reason-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'reasoning-start', id: reasoningId });
    void encoder.publishOutput({ type: 'reasoning-delta', id: reasoningId, delta: 'Let me think...' });
    await encoder.publishOutput({ type: 'reasoning-end', id: reasoningId });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'The answer is 42.' });
    await encoder.publishOutput({ type: 'text-end', id: textId });
    await encoder.publishOutput({ type: 'finish', finishReason: 'stop' });
    await encoder.close();

    await finished;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('reasoning-start');
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('reasoning-end');
    expect(types).toContain('text-start');
    expect(types).toContain('text-end');

    const messages = UIMessageCodec.getMessages(projection).map((m) => m.message);
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

    const allOutputs: VercelOutput[] = [];
    let resolveError: () => void;
    const gotError = new Promise<void>((r) => {
      resolveError = r;
    });

    await subChannel.subscribe((msg) => {
      const decoded = decoder.decode(msg);
      allOutputs.push(...decoded.outputs);
      projection = foldDecoded(projection, decoded, msg);
      if (decoded.outputs.some((e) => e.type === 'error')) resolveError();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-err-1', messageId),
    });

    await encoder.publishOutput({ type: 'start', messageId });
    await encoder.publishOutput({ type: 'start-step' });
    await encoder.publishOutput({ type: 'text-start', id: textId });
    void encoder.publishOutput({ type: 'text-delta', id: textId, delta: 'Partial...' });
    await encoder.publishOutput({ type: 'error', errorText: 'model rate limit exceeded' });
    await encoder.close();

    await gotError;

    const types = outputTypesOf(allOutputs);
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('error');

    const errorEvent = allOutputs.find((e): e is Extract<AI.UIMessageChunk, { type: 'error' }> => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.errorText).toBe('model rate limit exceeded');
  });

  /**
   * Scenario 9: Client tool output on ai-input wire (AIT-815 fix)
   *
   * Verifies that a client-published `tool-output` input rides the
   * `ai-input` wire (NOT `ai-output`) and carries `codec-type:
   * 'tool-output'`. Parallel-asserted by the encoder unit test; this
   * version goes through a real Ably channel.
   */
  it('client tool result publishes to ai-input wire', async () => {
    const channelName = uniqueChannelName('client-tool-output');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const continuationId = 'continuation-1';

    const received: Ably.InboundMessage[] = [];
    let resolveOne: () => void;
    const gotOne = new Promise<void>((r) => {
      resolveOne = r;
    });

    await subChannel.subscribe((msg) => {
      received.push(msg);
      resolveOne();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-client-tool-1', continuationId),
    });

    await encoder.publishInput(
      {
        kind: 'tool-result',
        codecMessageId: 'msg-1',
        payload: { toolCallId: 'tc-1', output: { latitude: 51.5, longitude: -0.1 } },
      },
      { messageId: continuationId },
    );
    await encoder.close();

    await gotOne;

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg?.name).toBe(EVENT_AI_INPUT);
    const headers = msg ? getCodecHeaders(msg) : {};
    expect(headers.kind).toBe('tool-result');
    expect(headers.toolCallId).toBe('tc-1');
  });

  /**
   * Scenario 10: Agent tool output stays on ai-output wire
   *
   * The agent-published `tool-output-available` UIMessageChunk continues
   * to ride the `ai-output` wire (unchanged by the input/output split).
   */
  it('agent tool output publishes to ai-output wire', async () => {
    const channelName = uniqueChannelName('agent-tool-output');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const messageId = 'msg-agent-tool-1';

    const received: Ably.InboundMessage[] = [];
    let resolveOne: () => void;
    const gotOne = new Promise<void>((r) => {
      resolveOne = r;
    });

    await subChannel.subscribe((msg) => {
      received.push(msg);
      resolveOne();
    });

    const encoder = UIMessageCodec.createEncoder(pubChannel, {
      onAblyMessage: stampHeaders('run-agent-tool-1', messageId),
    });

    await encoder.publishOutput({
      type: 'tool-output-available',
      toolCallId: 'tc-1',
      output: { temp: 72 },
    });
    await encoder.close();

    await gotOne;

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg?.name).toBe(EVENT_AI_OUTPUT);
    const headers = msg ? getCodecHeaders(msg) : {};
    expect(headers.kind).toBe('tool-output-available');
    expect(headers.toolCallId).toBe('tc-1');
  });
});
