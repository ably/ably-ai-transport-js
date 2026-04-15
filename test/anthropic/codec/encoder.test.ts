import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncoder } from '../../../src/anthropic/codec/encoder.js';
import {
  DOMAIN_HEADER_PREFIX as D,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
} from '../../../src/constants.js';
import type { ChannelWriter } from '../../../src/core/codec/types.js';

// ---------------------------------------------------------------------------
// Mock writer
// ---------------------------------------------------------------------------

interface MockWriter extends ChannelWriter {
  publishCalls: (Ably.Message | Ably.Message[])[];
  appendCalls: Ably.Message[];
  updateCalls: Ably.Message[];
  nextPublishResult: Ably.PublishResult;
  nextAppendResult: Ably.UpdateDeleteResult;
}

const createMockWriter = (): MockWriter => {
  const mock: MockWriter = {
    publishCalls: [],
    appendCalls: [],
    updateCalls: [],
    nextPublishResult: { serials: ['serial-1'] } as Ably.PublishResult,
    nextAppendResult: {} as Ably.UpdateDeleteResult,
    publish: vi.fn(async (message: Ably.Message | Ably.Message[]) => {
      mock.publishCalls.push(message);
      return await Promise.resolve(mock.nextPublishResult);
    }),
    appendMessage: vi.fn(async (message: Ably.Message) => {
      mock.appendCalls.push(message);
      return await Promise.resolve(mock.nextAppendResult);
    }),
    updateMessage: vi.fn(async (message: Ably.Message) => {
      mock.updateCalls.push(message);
      return await Promise.resolve(mock.nextAppendResult);
    }),
  };
  return mock;
};

const headersOf = (msg: Ably.Message): Record<string, string> =>
  (msg.extras as { headers: Record<string, string> }).headers;

const firstPublish = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls[0];
  if (!call) throw new Error('no publish calls');
  if (Array.isArray(call)) {
    const first = call[0];
    if (!first) throw new Error('empty batch');
    return first;
  }
  return call;
};

const lastPublish = (writer: MockWriter): Ably.Message => {
  const call = writer.publishCalls.at(-1);
  if (!call) throw new Error('no publish calls');
  if (Array.isArray(call)) {
    const first = call[0];
    if (!first) throw new Error('empty batch');
    return first;
  }
  return call;
};

const lastAppend = (writer: MockWriter): Ably.Message => {
  const msg = writer.appendCalls.at(-1);
  if (!msg) throw new Error('no append calls');
  return msg;
};

// ---------------------------------------------------------------------------
// Test helpers — event builders
// ---------------------------------------------------------------------------

const makeStreamEvent = (
  event: Record<string, unknown>,
  overrides?: Partial<Omit<Anthropic.SDKPartialAssistantMessage, 'type' | 'event'>>,
): Anthropic.SDKPartialAssistantMessage => ({
  type: 'stream_event',
  // CAST: Synthetic test events — cast through unknown because object literals
  // do not fully satisfy the BetaRawMessageStreamEvent union.
  event: event as unknown as Anthropic.SDKPartialAssistantMessage['event'],
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: null,
  uuid: 'test-uuid' as UUID,
  session_id: 'test-session',
  ...overrides,
});

const makeAssistantMessage = (
  overrides?: Partial<Omit<Anthropic.SDKAssistantMessage, 'type'>>,
): Anthropic.SDKAssistantMessage =>
  ({
    type: 'assistant',
    message: { id: 'msg-abc', model: 'claude-opus-4-20250514', content: [], role: 'assistant' },
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    parent_tool_use_id: null,
    uuid: 'test-uuid' as UUID,
    session_id: 'test-session',
    ...overrides,
  }) as Anthropic.SDKAssistantMessage;

const makeUserMessage = (
  overrides?: Partial<Omit<Anthropic.SDKUserMessage, 'type'>>,
): Anthropic.SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: 'hello' },
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    parent_tool_use_id: null,
    session_id: 'test-session',
    ...overrides,
  }) as Anthropic.SDKUserMessage;

const makeResultMessage = (
  overrides?: Partial<Omit<Anthropic.SDKResultMessage, 'type'>>,
): Anthropic.SDKResultMessage =>
  ({
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: 'done',
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-uuid' as UUID,
    session_id: 'test-session',
    ...overrides,
  }) as Anthropic.SDKResultMessage;

const makeToolProgressMessage = (
  overrides?: Partial<Omit<Anthropic.SDKToolProgressMessage, 'type'>>,
): Anthropic.SDKToolProgressMessage =>
  ({
    type: 'tool_progress',
    tool_use_id: 'tu-1',
    tool_name: 'bash',
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    parent_tool_use_id: null,
    elapsed_time_seconds: 5,
    uuid: 'test-uuid' as UUID,
    session_id: 'test-session',
    ...overrides,
  }) as Anthropic.SDKToolProgressMessage;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Anthropic encoder', () => {
  let writer: MockWriter;

  beforeEach(() => {
    writer = createMockWriter();
  });

  // -- text content block streaming -----------------------------------------

  describe('text content block streaming', () => {
    it('encodes content_block_start (text) as a streamed publish', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('text');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('0');
      expect(headersOf(msg)[`${D}blockIndex`]).toBe('0');
      expect(headersOf(msg)[`${D}blockType`]).toBe('text');
    });

    it('encodes content_block_delta (text_delta) as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        }),
      );

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('Hello world');
    });

    it('encodes content_block_stop as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });

    it('encodes full text lifecycle: start -> delta -> delta -> stop', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      // 1 publish (start), 3 appends (2 deltas + 1 close)
      expect(writer.publishCalls).toHaveLength(1);
      expect(writer.appendCalls).toHaveLength(3);
    });
  });

  // -- tool_use content block streaming -------------------------------------

  describe('tool_use content block streaming', () => {
    it('encodes content_block_start (tool_use) with tool metadata headers', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-input');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('1');
      expect(headersOf(msg)[`${D}blockIndex`]).toBe('1');
      expect(headersOf(msg)[`${D}blockType`]).toBe('tool_use');
      expect(headersOf(msg)[`${D}toolUseId`]).toBe('toolu_123');
      expect(headersOf(msg)[`${D}toolName`]).toBe('search');
    });

    it('encodes content_block_delta (input_json_delta) as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        }),
      );

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('{"q":');
    });

    it('encodes content_block_stop for tool_use as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 1 }),
      );

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });
  });

  // -- thinking content block streaming -------------------------------------

  describe('thinking content block streaming', () => {
    it('encodes content_block_start (thinking) as a streamed publish', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('thinking');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('true');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('streaming');
      expect(headersOf(msg)[HEADER_STREAM_ID]).toBe('0');
      expect(headersOf(msg)[`${D}blockIndex`]).toBe('0');
      expect(headersOf(msg)[`${D}blockType`]).toBe('thinking');
    });

    it('encodes content_block_delta (thinking_delta) as an append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        }),
      );

      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('Let me think...');
    });

    it('encodes content_block_stop for thinking as a closing append', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      const msg = lastAppend(writer);
      expect(headersOf(msg)[HEADER_STATUS]).toBe('finished');
    });
  });

  // -- non-streaming content blocks -----------------------------------------

  describe('non-streaming content blocks', () => {
    it('publishes server_tool_use as discrete content-block', async () => {
      const encoder = createEncoder(writer);
      const contentBlock = {
        type: 'server_tool_use',
        id: 'stu_123',
        name: 'web_search',
        input: { query: 'test' },
      };
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 2,
          content_block: contentBlock,
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('content-block');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)[`${D}blockIndex`]).toBe('2');
      expect(headersOf(msg)[`${D}blockType`]).toBe('server_tool_use');
      expect(msg.data).toEqual(contentBlock);
    });

    it('publishes web_search_tool_result as discrete content-block', async () => {
      const encoder = createEncoder(writer);
      const contentBlock = {
        type: 'web_search_tool_result',
        tool_use_id: 'wst_123',
        content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Example' }],
      };
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 3,
          content_block: contentBlock,
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('content-block');
      expect(headersOf(msg)[`${D}blockType`]).toBe('web_search_tool_result');
      expect(msg.data).toEqual(contentBlock);
    });
  });

  // -- message lifecycle events (stream) ------------------------------------

  describe('message lifecycle events', () => {
    it('encodes message_start as a discrete publish with messageId and model headers', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_start',
          message: { id: 'msg_01ABC', model: 'claude-opus-4-20250514', role: 'assistant', content: [] },
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('message-start');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg_01ABC');
      expect(headersOf(msg)[`${D}model`]).toBe('claude-opus-4-20250514');
    });

    it('encodes message_delta as a discrete publish with stopReason header', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 50 },
        }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('message-delta');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)[`${D}stopReason`]).toBe('end_turn');
      expect(msg.data).toEqual({ stop_reason: 'end_turn', usage: { output_tokens: 50 } });
    });

    it('omits stopReason header when stop_reason is absent', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_delta',
          delta: {},
          usage: { output_tokens: 10 },
        }),
      );

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}stopReason`]).toBeUndefined();
    });

    it('encodes message_stop as a discrete publish', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({ type: 'message_stop' }),
      );

      const msg = firstPublish(writer);
      expect(msg.name).toBe('message-stop');
      expect(msg.data).toBe('');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
    });
  });

  // -- complete messages (appendEvent) --------------------------------------

  describe('complete messages via appendEvent', () => {
    it('encodes Anthropic.SDKAssistantMessage as discrete assistant-message', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeAssistantMessage());

      const msg = firstPublish(writer);
      expect(msg.name).toBe('assistant-message');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)[`${D}messageId`]).toBe('msg-abc');
    });

    it('includes parentToolUseId header on assistant-message when present', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeAssistantMessage({ parent_tool_use_id: 'tu-parent' }));

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}parentToolUseId`]).toBe('tu-parent');
    });

    it('omits parentToolUseId header on assistant-message when null', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeAssistantMessage());

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}parentToolUseId`]).toBeUndefined();
    });

    it('encodes Anthropic.SDKResultMessage as discrete result', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeResultMessage());

      const msg = firstPublish(writer);
      expect(msg.name).toBe('result');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(headersOf(msg)[`${D}subtype`]).toBe('success');
      expect(msg.data).toEqual(makeResultMessage());
    });

    it('encodes Anthropic.SDKResultMessage with error subtype', async () => {
      const encoder = createEncoder(writer);
      const result = makeResultMessage({ subtype: 'error_during_execution' } as Partial<Anthropic.SDKResultMessage>);
      await encoder.appendEvent(result);

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}subtype`]).toBe('error_during_execution');
    });

    it('encodes Anthropic.SDKToolProgressMessage as discrete tool-progress', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeToolProgressMessage());

      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-progress');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
      expect(msg.data).toEqual(makeToolProgressMessage());
    });

    it('encodes Anthropic.SDKUserMessage as discrete user-message', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeUserMessage());

      const msg = firstPublish(writer);
      expect(msg.name).toBe('user-message');
      expect(headersOf(msg)[HEADER_STREAM]).toBe('false');
    });

    it('includes parentToolUseId header on user-message when present', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeUserMessage({ parent_tool_use_id: 'tu-parent' }));

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}parentToolUseId`]).toBe('tu-parent');
    });

    it('includes isSynthetic header on user-message when true', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeUserMessage({ isSynthetic: true }));

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}isSynthetic`]).toBe('true');
    });

    it('omits isSynthetic header on user-message when undefined', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(makeUserMessage());

      const msg = firstPublish(writer);
      expect(headersOf(msg)[`${D}isSynthetic`]).toBeUndefined();
    });
  });

  // -- streaming guard: assistant after stream is skipped -------------------

  describe('streaming guard', () => {
    it('skips discrete assistant-message after message was already streamed', async () => {
      const encoder = createEncoder(writer);

      // Stream the message via message_start
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_start',
          message: { id: 'msg-abc', model: 'claude-opus-4-20250514', role: 'assistant', content: [] },
        }),
      );

      const publishCountAfterStream = writer.publishCalls.length;

      // Now the SDK emits the complete assistant message — should be skipped
      await encoder.appendEvent(makeAssistantMessage());

      expect(writer.publishCalls.length).toBe(publishCountAfterStream);
    });

    it('publishes discrete assistant-message when message was not streamed', async () => {
      const encoder = createEncoder(writer);

      // Non-streaming mode: no prior stream_event, just the complete message
      await encoder.appendEvent(makeAssistantMessage());

      const msg = firstPublish(writer);
      expect(msg.name).toBe('assistant-message');
    });

    it('tracks streamed messages independently by message ID', async () => {
      const encoder = createEncoder(writer);

      // Stream message A
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_start',
          message: { id: 'msg-a', model: 'claude-opus-4-20250514', role: 'assistant', content: [] },
        }),
      );

      const publishCountAfterStream = writer.publishCalls.length;

      // Publish complete message B (not streamed) — should publish.
      // CAST: Override message.id via spread; the rest of the BetaMessage shape
      // comes from makeAssistantMessage's default.
      const msgB = makeAssistantMessage();
      (msgB.message as unknown as Record<string, unknown>).id = 'msg-b';
      await encoder.appendEvent(msgB);

      expect(writer.publishCalls.length).toBe(publishCountAfterStream + 1);
      const msg = lastPublish(writer);
      expect(msg.name).toBe('assistant-message');
    });
  });

  // -- signature_delta buffering ------------------------------------------------

  describe('signature_delta buffering', () => {
    it('buffers signature_delta and includes it in close headers', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-abc' },
        }),
      );

      // signature_delta should NOT produce a stream append
      expect(writer.appendCalls).toHaveLength(0);

      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      // Close should include buffered signature in domain headers
      const closeMsg = lastAppend(writer);
      expect(headersOf(closeMsg)[`${D}signature`]).toBe('sig-abc');
    });

    it('concatenates multiple signature_delta events into one header', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'part1' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'part2' },
        }),
      );

      // No stream appends for signature deltas
      expect(writer.appendCalls).toHaveLength(0);

      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      const closeMsg = lastAppend(writer);
      expect(headersOf(closeMsg)[`${D}signature`]).toBe('part1part2');
    });

    it('omits signature header when closing a block with no signature', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      const closeMsg = lastAppend(writer);
      expect(headersOf(closeMsg)[`${D}signature`]).toBeUndefined();
    });

    it('does not mix signature with thinking text appends', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-123' },
        }),
      );

      // Only the thinking_delta should be a stream append
      expect(writer.appendCalls).toHaveLength(1);
      expect(writer.appendCalls[0]?.data).toBe('Let me think...');

      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );

      // Close carries the signature in headers, separate from stream data
      const closeMsg = lastAppend(writer);
      expect(headersOf(closeMsg)[`${D}signature`]).toBe('sig-123');
    });
  });

  // -- unknown event types (no-op) ------------------------------------------

  describe('unknown event types', () => {
    it('ignores unknown top-level event types', async () => {
      const encoder = createEncoder(writer);
      // CAST: simulating an unknown event type the encoder should skip
      await encoder.appendEvent({ type: 'auth_status' } as unknown as Anthropic.SDKPartialAssistantMessage);

      expect(writer.publishCalls).toHaveLength(0);
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('ignores unknown stream event types', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({ type: 'some_future_event', data: {} }),
      );

      expect(writer.publishCalls).toHaveLength(0);
      expect(writer.appendCalls).toHaveLength(0);
    });
  });

  // -- writeMessages --------------------------------------------------------

  describe('writeMessages', () => {
    it('encodes Anthropic.SDKUserMessage as discrete user-message in batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeUserMessage()]);

      expect(writer.publishCalls).toHaveLength(1);
      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(1);
      expect(batch[0]?.name).toBe('user-message');
    });

    it('encodes Anthropic.SDKAssistantMessage as discrete assistant-message in batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeAssistantMessage()]);

      expect(writer.publishCalls).toHaveLength(1);
      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(1);
      expect(batch[0]?.name).toBe('assistant-message');
      if (batch[0]) expect(headersOf(batch[0])[`${D}messageId`]).toBe('msg-abc');
    });

    it('encodes multiple messages as a single batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeUserMessage(), makeAssistantMessage()]);

      expect(writer.publishCalls).toHaveLength(1);
      const batch = writer.publishCalls[0] as Ably.Message[];
      expect(batch).toHaveLength(2);
      expect(batch[0]?.name).toBe('user-message');
      expect(batch[1]?.name).toBe('assistant-message');
    });

    it('includes parentToolUseId on user-message in batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeUserMessage({ parent_tool_use_id: 'tu-parent' })]);

      const batch = writer.publishCalls[0] as Ably.Message[];
      if (batch[0]) expect(headersOf(batch[0])[`${D}parentToolUseId`]).toBe('tu-parent');
    });

    it('includes parentToolUseId on assistant-message in batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeAssistantMessage({ parent_tool_use_id: 'tu-parent' })]);

      const batch = writer.publishCalls[0] as Ably.Message[];
      if (batch[0]) expect(headersOf(batch[0])[`${D}parentToolUseId`]).toBe('tu-parent');
    });

    it('includes isSynthetic on user-message in batch', async () => {
      const encoder = createEncoder(writer);
      await encoder.writeMessages([makeUserMessage({ isSynthetic: true })]);

      const batch = writer.publishCalls[0] as Ably.Message[];
      if (batch[0]) expect(headersOf(batch[0])[`${D}isSynthetic`]).toBe('true');
    });
  });

  // -- writeEvent -----------------------------------------------------------

  describe('writeEvent', () => {
    it('publishes Anthropic.SDKResultMessage as discrete event', async () => {
      const encoder = createEncoder(writer);
      const result = await encoder.writeEvent(makeResultMessage());

      expect(result).toEqual({ serials: ['serial-1'] });
      const msg = firstPublish(writer);
      expect(msg.name).toBe('result');
      expect(headersOf(msg)[`${D}subtype`]).toBe('success');
    });

    it('publishes Anthropic.SDKToolProgressMessage as discrete event', async () => {
      const encoder = createEncoder(writer);
      const result = await encoder.writeEvent(makeToolProgressMessage());

      expect(result).toEqual({ serials: ['serial-1'] });
      const msg = firstPublish(writer);
      expect(msg.name).toBe('tool-progress');
    });

    it('throws for Anthropic.SDKPartialAssistantMessage (streaming event)', async () => {
      const encoder = createEncoder(writer);
      const streamEvent = makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });

      await expect(encoder.writeEvent(streamEvent)).rejects.toThrow('unable to write event');
    });

    it('throws for Anthropic.SDKAssistantMessage', async () => {
      const encoder = createEncoder(writer);
      await expect(encoder.writeEvent(makeAssistantMessage())).rejects.toThrow('unable to write event');
    });

    it('throws for Anthropic.SDKUserMessage', async () => {
      const encoder = createEncoder(writer);
      await expect(encoder.writeEvent(makeUserMessage())).rejects.toThrow('unable to write event');
    });
  });

  // -- abort ----------------------------------------------------------------

  describe('abort', () => {
    it('aborts all open streams and publishes discrete abort event', async () => {
      const encoder = createEncoder(writer);
      // Open a text stream
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );

      await encoder.abort('cancelled');

      const abortMsg = lastPublish(writer);
      expect(abortMsg.name).toBe('abort');
      expect(abortMsg.data).toBe('cancelled');
      expect(headersOf(abortMsg)[HEADER_STATUS]).toBe('aborted');

      // The stream should have been aborted
      const abortAppend = writer.appendCalls.find(
        (m) => headersOf(m)[HEADER_STATUS] === 'aborted',
      );
      expect(abortAppend).toBeDefined();
    });

    it('is idempotent — second call is a no-op', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );

      await encoder.abort('cancelled');
      const publishCountAfterFirst = writer.publishCalls.length;
      const appendCountAfterFirst = writer.appendCalls.length;

      await encoder.abort('cancelled');
      expect(writer.publishCalls.length).toBe(publishCountAfterFirst);
      expect(writer.appendCalls.length).toBe(appendCountAfterFirst);
    });

    it('with no open streams publishes only the abort discrete event', async () => {
      const encoder = createEncoder(writer);
      await encoder.abort('user-stop');

      expect(writer.publishCalls).toHaveLength(1);
      const msg = firstPublish(writer);
      expect(msg.name).toBe('abort');
      expect(msg.data).toBe('user-stop');
      expect(headersOf(msg)[HEADER_STATUS]).toBe('aborted');
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('uses empty string when no reason is provided', async () => {
      const encoder = createEncoder(writer);
      await encoder.abort();

      const msg = firstPublish(writer);
      expect(msg.data).toBe('');
    });

    it('aborts multiple open streams', async () => {
      const encoder = createEncoder(writer);
      // Open text stream at index 0
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      // Open tool stream at index 1
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
        }),
      );

      await encoder.abort('cancelled');

      // Both streams should have been aborted
      const abortAppends = writer.appendCalls.filter(
        (m) => headersOf(m)[HEADER_STATUS] === 'aborted',
      );
      expect(abortAppends).toHaveLength(2);
    });
  });

  // -- close ----------------------------------------------------------------

  describe('close', () => {
    it('delegates to core.close()', async () => {
      const encoder = createEncoder(writer);
      await encoder.close();

      // Should not throw on double close
      await encoder.close();
    });
  });

  // -- edge cases -----------------------------------------------------------

  describe('edge cases', () => {
    it('content_block_delta for unknown block index is a no-op', async () => {
      const encoder = createEncoder(writer);
      // Send a delta without a preceding start
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 99,
          delta: { type: 'text_delta', text: 'orphan' },
        }),
      );

      expect(writer.appendCalls).toHaveLength(0);
    });

    it('content_block_stop for unknown block index is a no-op', async () => {
      const encoder = createEncoder(writer);
      // Send a stop without a preceding start
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 99 }),
      );

      expect(writer.appendCalls).toHaveLength(0);
    });

    it('content_block_delta with unknown delta type is a no-op', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'citations_delta', citation: { url: 'https://example.com' } },
        }),
      );

      // Only the start publish, no appends from the unknown delta type
      expect(writer.appendCalls).toHaveLength(0);
    });

    it('multiple content blocks at different indices are tracked independently', async () => {
      const encoder = createEncoder(writer);
      // Start text at index 0
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      // Start tool at index 1
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
        }),
      );

      // Delta to text (index 0)
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        }),
      );
      // Delta to tool (index 1)
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"q":"test"}' },
        }),
      );

      expect(writer.appendCalls).toHaveLength(2);
      expect(writer.appendCalls[0]?.data).toBe('Hello');
      expect(writer.appendCalls[1]?.data).toBe('{"q":"test"}');

      // Close both
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      );
      await encoder.appendEvent(
        makeStreamEvent({ type: 'content_block_stop', index: 1 }),
      );

      // 2 deltas + 2 closes = 4 appends
      expect(writer.appendCalls).toHaveLength(4);
    });

    it('message_delta with null stop_reason omits stopReason header', async () => {
      const encoder = createEncoder(writer);
      await encoder.appendEvent(
        makeStreamEvent({
          type: 'message_delta',
          // eslint-disable-next-line unicorn/no-null -- SDK type uses null
          delta: { stop_reason: null },
          usage: { output_tokens: 10 },
        }),
      );

      const msg = firstPublish(writer);
      // null is coerced to undefined by `?? undefined` in the encoder
      expect(headersOf(msg)[`${D}stopReason`]).toBeUndefined();
    });
  });
});
