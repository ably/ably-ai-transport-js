/**
 * Anthropic AgentCodec integration tests.
 *
 * Validate encode -> publish -> subscribe -> decode -> accumulate roundtrips
 * over real Ably channels using message appends. These tests prove the
 * wire format and Ably message serialization work end-to-end without
 * transport machinery.
 *
 * Each test uses a unique channel name in the `mutable:` namespace and
 * a dedicated Ably client pair (publisher + subscriber) to avoid crosstalk.
 * The sandbox app is created by the globalSetup in test-setup.ts.
 */

import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import type * as Ably from 'ably';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentCodec } from '../../../src/anthropic/codec/index.js';
import type { AgentCodecEvent, AgentMessage } from '../../../src/anthropic/codec/types.js';
import { HEADER_MSG_ID, HEADER_TURN_ID } from '../../../src/constants.js';
import type { DecoderOutput } from '../../../src/core/codec/types.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Out = DecoderOutput<AgentCodecEvent, AgentMessage>;

/**
 * Extract events from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of AgentCodecEvent events.
 */
const eventsOf = (outputs: Out[]): AgentCodecEvent[] =>
  outputs.filter((o): o is Extract<Out, { kind: 'event' }> => o.kind === 'event').map((o) => o.event);

/**
 * Extract messages from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of AgentMessage messages.
 */
const messagesOf = (outputs: Out[]): AgentMessage[] =>
  outputs.filter((o): o is Extract<Out, { kind: 'message' }> => o.kind === 'message').map((o) => o.message);

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

/**
 * Wrap a BetaRawMessageStreamEvent in an SDKPartialAssistantMessage envelope.
 * @param event - The inner stream event record.
 * @returns An SDKPartialAssistantMessage suitable for the encoder.
 */
const makeStreamEvent = (event: Record<string, unknown>): Anthropic.SDKPartialAssistantMessage => ({
  type: 'stream_event',
  event: event as unknown as Anthropic.SDKPartialAssistantMessage['event'],
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: null,
  uuid: 'test-uuid' as UUID,
  session_id: 'test-session',
});

/**
 * Construct a minimal BetaUsage object with all required fields.
 * @returns A Record with the BetaUsage shape.
 */
const makeBetaUsage = (): Record<string, unknown> => ({
  input_tokens: 10,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  cache_creation: null,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  inference_geo: null,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  iterations: null,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  server_tool_use: null,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  service_tier: null,
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  speed: null,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Anthropic AgentCodec integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  /**
   * Scenario 1: Text response roundtrip
   *
   * Encodes message_start -> content_block_start(text) -> content_block_delta(text_delta) x 3
   * -> content_block_stop -> message_delta(stop_reason:'end_turn') -> message_stop,
   * then publishes a result event. Verifies the decoder+accumulator reconstruct
   * an SDKAssistantMessage with the correct text in content[0].
   */
  it('text response roundtrip', async () => {
    const channelName = uniqueChannelName('anth-text-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-text-1';

    const allOutputs: Out[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'result')) {
        resolveFinish();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-1', messageId),
    });

    // message_start
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );

    // content_block_start (text)
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );

    // content_block_delta (text_delta) x 3
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    );
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', ' } }),
    );
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } }),
    );

    // content_block_stop
    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 0 }));

    // message_delta
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }),
    );

    // message_stop
    await encoder.appendEvent(makeStreamEvent({ type: 'message_stop' }));

    // result (terminal)
    // CAST: Minimal SDKResultMessage for the terminal signal.
    await encoder.appendEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);

    await encoder.close();
    await finished;

    // Verify events include expected stream event types
    const streamEvents = eventsOf(allOutputs).filter(
      (e): e is Anthropic.SDKPartialAssistantMessage => e.type === 'stream_event',
    );
    const innerTypes = streamEvents.map((e) => (e.event as unknown as Record<string, unknown>).type);
    expect(innerTypes).toContain('message_start');
    expect(innerTypes).toContain('content_block_start');
    expect(innerTypes).toContain('content_block_delta');
    expect(innerTypes).toContain('content_block_stop');
    expect(innerTypes).toContain('message_delta');
    expect(innerTypes).toContain('message_stop');

    // Verify result event
    expect(eventsOf(allOutputs).some((e) => e.type === 'result')).toBe(true);

    // Verify accumulated message
    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    expect(msg).toBeDefined();
    expect(msg?.type).toBe('assistant');

    // CAST: Narrow to SDKAssistantMessage to access .message.content.
    const assistantMsg = msg as Anthropic.SDKAssistantMessage;
    const textBlock = assistantMsg.message.content[0] as unknown as Record<string, unknown>;
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('Hello, world!');
    expect(accumulator.hasActiveStream).toBe(false);
  });

  /**
   * Scenario 2: Tool call roundtrip
   *
   * Encodes a tool_use content block with streaming input_json_delta, then
   * content_block_stop. Verifies the accumulated message has a tool_use
   * content block with parsed JSON input.
   */
  it('tool call roundtrip', async () => {
    const channelName = uniqueChannelName('anth-tool-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-tool-1';

    const allOutputs: Out[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'result')) {
        resolveFinish();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-tool-1', messageId),
    });

    // message_start
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );

    // content_block_start (tool_use)
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
      }),
    );

    // content_block_delta (input_json_delta) x 2
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"loc' },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' },
      }),
    );

    // content_block_stop
    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 0 }));

    // message_delta
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 10 },
      }),
    );

    // message_stop
    await encoder.appendEvent(makeStreamEvent({ type: 'message_stop' }));

    // result (terminal)
    await encoder.appendEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      stop_reason: 'tool_use',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);

    await encoder.close();
    await finished;

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    expect(msg?.type).toBe('assistant');

    const assistantMsg = msg as Anthropic.SDKAssistantMessage;
    const toolBlock = assistantMsg.message.content[0] as unknown as Record<string, unknown>;
    expect(toolBlock.type).toBe('tool_use');
    expect(toolBlock.name).toBe('get_weather');
    expect(toolBlock.id).toBe('toolu_01');
    expect(toolBlock.input).toEqual({ location: 'SF' });
    expect(accumulator.hasActiveStream).toBe(false);
  });

  /**
   * Scenario 3: Thinking block roundtrip
   *
   * Encodes a thinking content block with thinking_delta events. Verifies
   * accumulated message has thinking content with correct text.
   */
  it('thinking block roundtrip', async () => {
    const channelName = uniqueChannelName('anth-thinking-roundtrip');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-thinking-1';

    const allOutputs: Out[] = [];
    let resolveFinish: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinish = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'result')) {
        resolveFinish();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-thinking-1', messageId),
    });

    // message_start
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );

    // content_block_start (thinking)
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
    );

    // content_block_delta (thinking_delta) x 2
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me ' },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'think...' },
      }),
    );

    // content_block_stop
    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 0 }));

    // Then a text block follows
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 1,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );

    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'The answer is 42.' },
      }),
    );

    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 1 }));

    // message_delta + message_stop + result
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 15 },
      }),
    );
    await encoder.appendEvent(makeStreamEvent({ type: 'message_stop' }));
    await encoder.appendEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);

    await encoder.close();
    await finished;

    expect(accumulator.completedMessages).toHaveLength(1);
    const [msg] = accumulator.completedMessages;
    expect(msg?.type).toBe('assistant');

    const assistantMsg = msg as Anthropic.SDKAssistantMessage;
    const thinkingBlock = assistantMsg.message.content[0] as unknown as Record<string, unknown>;
    expect(thinkingBlock.type).toBe('thinking');
    expect(thinkingBlock.thinking).toBe('Let me think...');

    const textBlock = assistantMsg.message.content[1] as unknown as Record<string, unknown>;
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('The answer is 42.');
    expect(accumulator.hasActiveStream).toBe(false);
  });

  /**
   * Scenario 4: Abort mid-stream
   *
   * Starts a text stream, sends some deltas, then calls encoder.abort().
   * Verifies the decoder surfaces the abort (as a result event) and the
   * accumulator handles it.
   */
  it('abort mid-stream', async () => {
    const channelName = uniqueChannelName('anth-abort');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-abort-1';

    const allOutputs: Out[] = [];
    let resolveAbort: () => void;
    const aborted = new Promise<void>((r) => {
      resolveAbort = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      // The abort is surfaced as a result event with is_error true
      if (eventsOf(outputs).some((e) => e.type === 'result')) {
        resolveAbort();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-abort-1', messageId),
    });

    // message_start
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );

    // content_block_start (text)
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );

    // Some deltas
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    );
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', wo' } }),
    );

    // Abort
    await encoder.abort('user cancelled');
    await encoder.close();

    await aborted;

    // Verify we got stream events and the abort result
    const streamEvents = eventsOf(allOutputs).filter(
      (e): e is Anthropic.SDKPartialAssistantMessage => e.type === 'stream_event',
    );
    const innerTypes = streamEvents.map((e) => (e.event as unknown as Record<string, unknown>).type);
    expect(innerTypes).toContain('content_block_start');
    expect(innerTypes).toContain('content_block_delta');

    // The abort produces a result event with is_error true
    const resultEvent = eventsOf(allOutputs).find(
      (e): e is Anthropic.SDKResultMessage => e.type === 'result',
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.is_error).toBe(true);
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
    const channelName = uniqueChannelName('anth-history');
    const pubClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);

    const messageId = 'msg-hist-1';

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-hist-1', messageId),
    });

    // Publish a complete text stream
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'History ' },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'test.' },
      }),
    );
    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 0 }));
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }),
    );
    await encoder.appendEvent(makeStreamEvent({ type: 'message_stop' }));
    await encoder.appendEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);
    await encoder.close();

    // Wait for Ably's history API to become consistent -- real network propagation
    // cannot be flushed with microtasks.
    await new Promise((r) => setTimeout(r, 1000));

    const histClient = ablyRealtimeClient();
    const histChannel = histClient.channels.get(channelName);

    const historyPage = await histChannel.history({ direction: 'forwards' });
    const historyMessages = historyPage.items;

    expect(historyMessages.length).toBeGreaterThan(0);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    for (const msg of historyMessages) {
      const outputs = decoder.decode(msg);
      accumulator.processOutputs(outputs);
    }

    expect(accumulator.messages.length).toBeGreaterThanOrEqual(1);

    // Find the assistant message with the text content
    const assistantMsgs = accumulator.messages.filter(
      (m): m is Anthropic.SDKAssistantMessage => m.type === 'assistant',
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    const textMsg = assistantMsgs.find((m) =>
      m.message.content.some((block) => {
        const b = block as unknown as Record<string, unknown>;
        return b.type === 'text' && typeof b.text === 'string' && b.text.includes('History test.');
      }),
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
    const channelName = uniqueChannelName('anth-multi-client');
    const pubClient = ablyRealtimeClient();
    const sub1Client = ablyRealtimeClient();
    const sub2Client = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const sub1Channel = sub1Client.channels.get(channelName);
    const sub2Channel = sub2Client.channels.get(channelName);

    const decoder1 = AgentCodec.createDecoder();
    const accumulator1 = AgentCodec.createAccumulator();
    const decoder2 = AgentCodec.createDecoder();
    const accumulator2 = AgentCodec.createAccumulator();

    const messageId = 'msg-multi-1';

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
      if (eventsOf(outputs).some((e) => e.type === 'result')) resolve1();
    });

    await sub2Channel.subscribe((msg) => {
      const outputs = decoder2.decode(msg);
      accumulator2.processOutputs(outputs);
      if (eventsOf(outputs).some((e) => e.type === 'result')) resolve2();
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-multi-1', messageId),
    });

    // Stream a text response
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Sync ' },
      }),
    );
    void encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'test.' },
      }),
    );
    await encoder.appendEvent(makeStreamEvent({ type: 'content_block_stop', index: 0 }));
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }),
    );
    await encoder.appendEvent(makeStreamEvent({ type: 'message_stop' }));
    await encoder.appendEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);
    await encoder.close();

    await Promise.all([finished1, finished2]);

    expect(accumulator1.completedMessages).toHaveLength(1);
    expect(accumulator2.completedMessages).toHaveLength(1);

    const msg1 = accumulator1.completedMessages[0] as Anthropic.SDKAssistantMessage;
    const msg2 = accumulator2.completedMessages[0] as Anthropic.SDKAssistantMessage;

    const text1 = (msg1.message.content[0] as unknown as Record<string, unknown>).text;
    const text2 = (msg2.message.content[0] as unknown as Record<string, unknown>).text;
    expect(text1).toBe('Sync test.');
    expect(text2).toBe('Sync test.');
  });

  /**
   * Scenario 7: Complete assistant message (non-streaming)
   *
   * Publishes a complete SDKAssistantMessage via appendEvent (simulating
   * non-streaming mode). Verifies it's decoded as a kind:'message' output.
   */
  it('complete assistant message (non-streaming)', async () => {
    const channelName = uniqueChannelName('anth-complete-msg');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-complete-1';

    const allOutputs: Out[] = [];
    let resolveMessage: () => void;
    const gotMessage = new Promise<void>((r) => {
      resolveMessage = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (messagesOf(outputs).some((m) => m.type === 'assistant')) {
        resolveMessage();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-complete-1', messageId),
    });

    // Publish a complete assistant message
    const completeMessage: Anthropic.SDKAssistantMessage = {
      type: 'assistant',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [
          // CAST: Text content block for the non-streaming message.
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          { type: 'text', text: 'Complete message.', citations: null } as unknown as Anthropic.SDKAssistantMessage['message']['content'][number],
        ],
        stop_reason: 'end_turn',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_sequence: null,
        usage: makeBetaUsage() as unknown as Anthropic.SDKAssistantMessage['message']['usage'],
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        container: null,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        context_management: null,
      } as Anthropic.SDKAssistantMessage['message'],
      // eslint-disable-next-line unicorn/no-null -- SDK type requires null
      parent_tool_use_id: null,
      uuid: 'uuid-complete' as UUID,
      session_id: 'test-session',
    };

    await encoder.appendEvent(completeMessage);
    await encoder.close();

    await gotMessage;

    const messages = messagesOf(allOutputs);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg?.type).toBe('assistant');

    const assistantMsg = msg as Anthropic.SDKAssistantMessage;
    const textBlock = assistantMsg.message.content[0] as unknown as Record<string, unknown>;
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toBe('Complete message.');
  });

  /**
   * Scenario 8: User message roundtrip via writeMessages
   *
   * Encodes an SDKUserMessage via writeMessages, verifies it's decoded
   * as a kind:'message' with correct fields.
   */
  it('user message roundtrip via writeMessages', async () => {
    const channelName = uniqueChannelName('anth-user-msg');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const allOutputs: Out[] = [];
    let resolveMessage: () => void;
    const gotMessage = new Promise<void>((r) => {
      resolveMessage = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (messagesOf(outputs).some((m) => m.type === 'user')) {
        resolveMessage();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-user-1', 'user-msg-1'),
    });

    const userMessage: Anthropic.SDKUserMessage = {
      type: 'user',
      // CAST: User message payload — a simple string content for the test.
      message: { role: 'user', content: 'Hello from the user' } as Anthropic.SDKUserMessage['message'],
      // eslint-disable-next-line unicorn/no-null -- SDK type requires null
      parent_tool_use_id: null,
      isSynthetic: false,
      uuid: 'uuid-user-1' as UUID,
      session_id: 'test-session',
    };

    await encoder.writeMessages([userMessage]);
    await encoder.close();

    await gotMessage;

    const messages = messagesOf(allOutputs);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg?.type).toBe('user');

    const userMsg = msg as Anthropic.SDKUserMessage;
    // CAST: message.content is a union type; cast to access the string value.
    const content = userMsg.message as unknown as Record<string, unknown>;
    expect(content.content).toBe('Hello from the user');
    expect(userMsg.isSynthetic).toBe(false);
    expect(userMsg.session_id).toBe('test-session');
  });

  /**
   * Scenario 9: Error result mid-stream
   *
   * Starts streaming text, then publishes an SDKResultMessage with
   * is_error: true (simulating a rate limit or other error). Verifies
   * the error result event propagates correctly through the wire and
   * that the accumulator cleans up active streams.
   *
   * Mirrors the Vercel codec's "error propagation mid-stream" test:
   * uses fire-and-forget deltas (matching production behavior) and
   * asserts on the error event delivery, not on partial text content.
   */
  it('error result mid-stream', async () => {
    const channelName = uniqueChannelName('anth-error-result');
    const pubClient = ablyRealtimeClient();
    const subClient = ablyRealtimeClient();

    const pubChannel = pubClient.channels.get(channelName);
    const subChannel = subClient.channels.get(channelName);

    const decoder = AgentCodec.createDecoder();
    const accumulator = AgentCodec.createAccumulator();

    const messageId = 'msg-err-1';

    const allOutputs: Out[] = [];
    let resolveResult: () => void;
    const gotResult = new Promise<void>((r) => {
      resolveResult = r;
    });

    await subChannel.subscribe((msg) => {
      const outputs = decoder.decode(msg);
      allOutputs.push(...outputs);
      accumulator.processOutputs(outputs);

      if (eventsOf(outputs).some((e) => e.type === 'result')) {
        resolveResult();
      }
    });

    const encoder = AgentCodec.createEncoder(pubChannel, {
      onMessage: stampHeaders('turn-err-1', messageId),
    });

    // message_start
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [],
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_reason: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          stop_sequence: null,
          usage: makeBetaUsage(),
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          container: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          context_management: null,
        },
      }),
    );

    // content_block_start (text)
    await encoder.appendEvent(
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        content_block: { type: 'text', text: '', citations: null },
      }),
    );

    // Fire-and-forget delta — matches production behavior where deltas are
    // not awaited for performance. The delta may or may not be delivered
    // before the result event arrives.
    void encoder.appendEvent(
      makeStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial...' } }),
    );

    // Error result — simulates a rate limit or other error mid-execution
    await encoder.appendEvent({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 50,
      duration_api_ms: 40,
      is_error: true,
      num_turns: 1,
      stop_reason: 'error',
      total_cost_usd: 0.005,
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ['rate limit exceeded'],
      uuid: 'test-uuid' as UUID,
      session_id: 'test-session',
    } as unknown as Anthropic.SDKResultMessage);

    await encoder.close();
    await gotResult;

    // Verify the error result event propagated with correct fields
    const resultEvent = eventsOf(allOutputs).find(
      (e): e is Anthropic.SDKResultMessage => e.type === 'result',
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.is_error).toBe(true);
    expect(resultEvent?.subtype).toBe('error_during_execution');

    // Verify hasActiveStream is false (result cleans up active streams)
    expect(accumulator.hasActiveStream).toBe(false);
  });
});
