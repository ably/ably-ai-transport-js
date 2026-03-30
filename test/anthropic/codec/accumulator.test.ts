import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createAccumulator } from '../../../src/anthropic/codec/accumulator.js';
import type { AgentCodecEvent, AgentMessage } from '../../../src/anthropic/codec/types.js';
import type { DecoderOutput } from '../../../src/core/codec/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Output = DecoderOutput<AgentCodecEvent, AgentMessage>;

// Retrieve an array element, throwing if it is undefined.
const at = <T>(arr: T[], index: number): T => {
  const item = arr[index];
  if (item === undefined) throw new Error(`expected element at index ${String(index)}`);
  return item;
};

const DEFAULT_MSG_ID = 'msg-1';
const DEFAULT_UUID = 'test-uuid' as UUID;
const DEFAULT_SESSION_ID = 'test-session';

// Wrap an inner stream event into an Anthropic.SDKPartialAssistantMessage envelope.
const makeStreamEvent = (
  innerEvent: Record<string, unknown>,
  options?: { parentToolUseId?: string | null; uuid?: UUID; sessionId?: string },
): Anthropic.SDKPartialAssistantMessage => ({
  type: 'stream_event',
  // CAST: Synthetic test events — cast through unknown because object literals
  // do not fully satisfy the BetaRawMessageStreamEvent union.
  event: innerEvent as unknown as Anthropic.SDKPartialAssistantMessage['event'],
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: options?.parentToolUseId ?? null,
  uuid: options?.uuid ?? DEFAULT_UUID,
  session_id: options?.sessionId ?? DEFAULT_SESSION_ID,
});

// Build a message_start stream event with a BetaMessage shell.
const messageStartEvent = (
  messageId: string = DEFAULT_MSG_ID,
  options?: { parentToolUseId?: string | null; uuid?: UUID; sessionId?: string },
): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent(
    {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-20250514',
        content: [],
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_reason: null,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          cache_creation_input_tokens: null,
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          cache_read_input_tokens: null,
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
        },
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        container: null,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        context_management: null,
      },
    },
    options,
  );

// Build a content_block_start stream event for a text block.
const textBlockStart = (index: number): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  });

// Build a content_block_delta stream event for a text_delta.
const textDelta = (index: number, text: string): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  });

// Build a content_block_stop stream event.
const contentBlockStop = (index: number): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_stop',
    index,
  });

// Build a content_block_start stream event for a tool_use block.
const toolUseBlockStart = (index: number, id: string, name: string): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });

// Build a content_block_delta stream event for input_json_delta.
const inputJsonDelta = (index: number, partialJson: string): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  });

// Build a content_block_start stream event for a thinking block.
const thinkingBlockStart = (index: number): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  });

// Build a content_block_delta stream event for a thinking_delta.
const thinkingDelta = (index: number, thinking: string): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  });

// Build a message_delta stream event with stop_reason and usage.
const messageDelta = (
  stopReason: string,
  outputTokens?: number,
): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    ...(outputTokens === undefined ? {} : { usage: { output_tokens: outputTokens } }),
  });

// Build a message_stop stream event.
const messageStop = (): Anthropic.SDKPartialAssistantMessage =>
  makeStreamEvent({
    type: 'message_stop',
  });

// Wrap an AgentCodecEvent in a DecoderOutput event envelope.
const eventOutput = (event: AgentCodecEvent, messageId: string = DEFAULT_MSG_ID): Output => ({
  kind: 'event',
  event,
  messageId,
});

// Wrap an AgentMessage in a DecoderOutput message envelope.
const messageOutput = (msg: AgentMessage): Output => ({
  kind: 'message',
  message: msg,
});

// Build a complete Anthropic.SDKAssistantMessage (non-streaming).
const completeAssistantMessage = (
  messageId: string,
  content: Record<string, unknown>[] = [],
  options?: { uuid?: UUID; sessionId?: string; parentToolUseId?: string | null },
): Anthropic.SDKAssistantMessage => ({
  type: 'assistant',
  // CAST: Synthetic BetaMessage for testing — cast through unknown because the
  // content array is Record<string, unknown>[] rather than the full BetaContentBlock union.
  message: {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-20250514',
    content,
    stop_reason: 'end_turn',
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      // eslint-disable-next-line unicorn/no-null -- SDK type requires null
      cache_creation_input_tokens: null,
      // eslint-disable-next-line unicorn/no-null -- SDK type requires null
      cache_read_input_tokens: null,
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
    },
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    container: null,
    // eslint-disable-next-line unicorn/no-null -- SDK type requires null
    context_management: null,
  } as unknown as Anthropic.SDKAssistantMessage['message'],
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: options?.parentToolUseId ?? null,
  uuid: options?.uuid ?? (messageId as UUID),
  session_id: options?.sessionId ?? DEFAULT_SESSION_ID,
});

// Build a complete Anthropic.SDKUserMessage.
const userMessage = (
  content: string,
  options?: { uuid?: UUID; sessionId?: string; parentToolUseId?: string | null },
): Anthropic.SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content },
  // eslint-disable-next-line unicorn/no-null -- SDK type requires null
  parent_tool_use_id: options?.parentToolUseId ?? null,
  uuid: options?.uuid ?? (DEFAULT_UUID),
  session_id: options?.sessionId ?? DEFAULT_SESSION_ID,
});

// Helper to access the content array from an Anthropic.SDKAssistantMessage.
const getContent = (msg: AgentMessage): Record<string, unknown>[] => {
  if (msg.type !== 'assistant') throw new Error('Expected assistant message');
  // CAST: BetaMessage.content is a union of many SDK block types; cast through
  // unknown to access as generic records for test assertions.
  return msg.message.content as unknown as Record<string, unknown>[];
};

// Helper to access the inner BetaMessage from an Anthropic.SDKAssistantMessage.
const getInnerMessage = (msg: AgentMessage): Record<string, unknown> => {
  if (msg.type !== 'assistant') throw new Error('Expected assistant message');
  return msg.message as unknown as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Anthropic Agent SDK accumulator', () => {
  // -- text streaming lifecycle -----------------------------------------------

  describe('text streaming lifecycle', () => {
    it('accumulates text across multiple deltas in a full lifecycle', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'hello')),
        eventOutput(textDelta(0, ' world')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      expect(acc.messages).toHaveLength(1);
      const msg = at(acc.messages, 0);
      expect(msg.type).toBe('assistant');

      const content = getContent(msg);
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'hello world' }));
    });

    it('includes in-progress message in messages during streaming', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'partial')),
      ]);

      expect(acc.messages).toHaveLength(1);
      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'partial' }));
    });

    it('does not include in-progress message in completedMessages', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'partial')),
      ]);

      expect(acc.completedMessages).toHaveLength(0);
    });

    it('moves message to completedMessages on message_stop', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'done')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.messages).toHaveLength(1);
    });

    it('reports hasActiveStream true during streaming', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
      ]);

      expect(acc.hasActiveStream).toBe(true);
    });

    it('reports hasActiveStream false after content_block_stop', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'text')),
        eventOutput(contentBlockStop(0)),
      ]);

      expect(acc.hasActiveStream).toBe(false);
    });

    it('reports hasActiveStream false after message_stop', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'text')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      expect(acc.hasActiveStream).toBe(false);
    });

    it('handles empty text deltas without error', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, '')),
        eventOutput(textDelta(0, 'hello')),
        eventOutput(textDelta(0, '')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'hello' }));
    });
  });

  // -- tool use streaming lifecycle -------------------------------------------

  describe('tool use streaming lifecycle', () => {
    it('accumulates tool_use input from JSON fragments', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(toolUseBlockStart(0, 'tool-1', 'search')),
        eventOutput(inputJsonDelta(0, '{"q":')),
        eventOutput(inputJsonDelta(0, '"test"}')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual(
        expect.objectContaining({
          type: 'tool_use',
          id: 'tool-1',
          name: 'search',
          input: { q: 'test' },
        }),
      );
    });

    it('parses input on content_block_stop even if intermediate parses fail', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(toolUseBlockStart(0, 'tool-1', 'calc')),
        // Partial JSON that is not parseable on its own
        eventOutput(inputJsonDelta(0, '{"x": 1')),
        eventOutput(inputJsonDelta(0, ', "y": 2}')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(
        expect.objectContaining({
          type: 'tool_use',
          input: { x: 1, y: 2 },
        }),
      );
    });

    it('retains empty input if JSON buffer never parses', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(toolUseBlockStart(0, 'tool-1', 'broken')),
        eventOutput(inputJsonDelta(0, '{invalid json')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      // Input should remain as {} from the initial block start since JSON never parsed
      expect(content[0]).toEqual(
        expect.objectContaining({
          type: 'tool_use',
          id: 'tool-1',
          name: 'broken',
          input: {},
        }),
      );
    });

    it('correctly identifies tool_use block with id and name', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(toolUseBlockStart(0, 'call_abc123', 'get_weather')),
        eventOutput(inputJsonDelta(0, '{"city":"London"}')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(
        expect.objectContaining({
          type: 'tool_use',
          id: 'call_abc123',
          name: 'get_weather',
        }),
      );
    });
  });

  // -- thinking block lifecycle -----------------------------------------------

  describe('thinking block lifecycle', () => {
    it('accumulates thinking text across deltas', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(thinkingBlockStart(0)),
        eventOutput(thinkingDelta(0, 'Let me ')),
        eventOutput(thinkingDelta(0, 'think about this...')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual(
        expect.objectContaining({
          type: 'thinking',
          thinking: 'Let me think about this...',
        }),
      );
    });

    it('reports hasActiveStream during thinking block streaming', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(thinkingBlockStart(0)),
        eventOutput(thinkingDelta(0, 'thinking...')),
      ]);

      expect(acc.hasActiveStream).toBe(true);
    });
  });

  // -- multiple content blocks in one message ---------------------------------

  describe('multiple content blocks in one message', () => {
    it('accumulates text and tool_use in the same message', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'I will search for that.')),
        eventOutput(contentBlockStop(0)),
        eventOutput(toolUseBlockStart(1, 'tool-1', 'search')),
        eventOutput(inputJsonDelta(1, '{"q":"test"}')),
        eventOutput(contentBlockStop(1)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'I will search for that.' }));
      expect(content[1]).toEqual(
        expect.objectContaining({ type: 'tool_use', id: 'tool-1', name: 'search', input: { q: 'test' } }),
      );
    });

    it('accumulates multiple text blocks at correct indices', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'first')),
        eventOutput(contentBlockStop(0)),
        eventOutput(textBlockStart(1)),
        eventOutput(textDelta(1, 'second')),
        eventOutput(contentBlockStop(1)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'first' }));
      expect(content[1]).toEqual(expect.objectContaining({ type: 'text', text: 'second' }));
    });

    it('accumulates thinking + text + tool_use in sequence', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(thinkingBlockStart(0)),
        eventOutput(thinkingDelta(0, 'reasoning')),
        eventOutput(contentBlockStop(0)),
        eventOutput(textBlockStart(1)),
        eventOutput(textDelta(1, 'response')),
        eventOutput(contentBlockStop(1)),
        eventOutput(toolUseBlockStart(2, 'tc-1', 'action')),
        eventOutput(inputJsonDelta(2, '{}')),
        eventOutput(contentBlockStop(2)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'thinking' }));
      expect(content[1]).toEqual(expect.objectContaining({ type: 'text' }));
      expect(content[2]).toEqual(expect.objectContaining({ type: 'tool_use' }));
    });
  });

  // -- complete message handling ----------------------------------------------

  describe('complete message handling', () => {
    it('pushes Anthropic.SDKAssistantMessage directly to completed list', () => {
      const acc = createAccumulator();
      const assistant = completeAssistantMessage('msg-a', [{ type: 'text', text: 'hello' }]);

      acc.processOutputs([messageOutput(assistant)]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.messages[0]).toBe(assistant);
    });

    it('pushes Anthropic.SDKUserMessage directly to completed list', () => {
      const acc = createAccumulator();
      const user = userMessage('hello');

      acc.processOutputs([messageOutput(user)]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.messages[0]).toBe(user);
    });

    it('inserts complete Anthropic.SDKAssistantMessage via event processing', () => {
      const acc = createAccumulator();
      const assistant = completeAssistantMessage('msg-a', [{ type: 'text', text: 'complete' }]);

      acc.processOutputs([eventOutput(assistant, 'msg-a')]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(1);
    });

    it('inserts Anthropic.SDKUserMessage via event processing', () => {
      const acc = createAccumulator();
      const user = userMessage('hello');

      acc.processOutputs([eventOutput(user, 'msg-u')]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(1);
    });

    it('supersedes in-progress streaming message with complete message', () => {
      const acc = createAccumulator();

      // Start streaming
      acc.processOutputs([
        eventOutput(messageStartEvent('msg-a'), 'msg-a'),
        eventOutput(textBlockStart(0), 'msg-a'),
        eventOutput(textDelta(0, 'partial'), 'msg-a'),
      ]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(0);

      // Complete message arrives — should supersede the in-progress one
      const complete = completeAssistantMessage('msg-a', [{ type: 'text', text: 'full response' }]);
      acc.processOutputs([eventOutput(complete, 'msg-a')]);

      expect(acc.messages).toHaveLength(1);
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.hasActiveStream).toBe(false);
    });
  });

  // -- message_delta handling -------------------------------------------------

  describe('message_delta handling', () => {
    it('updates stop_reason on the in-progress message', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'text')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageDelta('end_turn')),
        eventOutput(messageStop()),
      ]);

      const inner = getInnerMessage(at(acc.messages, 0));
      expect(inner.stop_reason).toBe('end_turn');
    });

    it('updates usage statistics', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'text')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageDelta('end_turn', 50)),
        eventOutput(messageStop()),
      ]);

      const inner = getInnerMessage(at(acc.messages, 0));
      const usage = inner.usage as Record<string, unknown>;
      expect(usage.output_tokens).toBe(50);
    });

    it('ignores message_delta when no active message exists', () => {
      const acc = createAccumulator();
      // Should not throw
      acc.processOutputs([eventOutput(messageDelta('end_turn', 10))]);
      expect(acc.messages).toHaveLength(0);
    });
  });

  // -- lazy message creation (mid-stream join) --------------------------------

  describe('lazy message creation (mid-stream join)', () => {
    it('creates shell message on content_block_start without prior message_start', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'mid-stream')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      expect(acc.messages).toHaveLength(1);
      const msg = at(acc.messages, 0);
      expect(msg.type).toBe('assistant');

      // Shell message should have the messageId as its id
      const inner = getInnerMessage(msg);
      expect(inner.id).toBe(DEFAULT_MSG_ID);
      expect(inner.model).toBe('unknown');

      const content = getContent(msg);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'mid-stream' }));
    });

    it('fills in shell correctly with subsequent events', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(textBlockStart(0)),
        eventOutput(textDelta(0, 'hello')),
        eventOutput(contentBlockStop(0)),
        eventOutput(toolUseBlockStart(1, 'tc-1', 'search')),
        eventOutput(inputJsonDelta(1, '{"q":"test"}')),
        eventOutput(contentBlockStop(1)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'hello' }));
      expect(content[1]).toEqual(
        expect.objectContaining({ type: 'tool_use', id: 'tc-1', name: 'search', input: { q: 'test' } }),
      );
    });

    it('handles content_block_delta before content_block_start (mid-stream edge case)', () => {
      const acc = createAccumulator();
      // Delta arrives before block_start — the active message is lazily created
      // but there is no contentBlock state for index 0, so delta is a no-op
      acc.processOutputs([
        eventOutput(
          makeStreamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'orphan' },
          }),
        ),
      ]);

      // The ensureActiveMessage is not called by _handleContentBlockDelta,
      // and since no message_start or content_block_start occurred, there's no active message
      // content_block_delta only processes if an active message already exists
      expect(acc.messages).toHaveLength(0);
    });
  });

  // -- SDKResultMessage handling ----------------------------------------------

  describe('SDKResultMessage handling', () => {
    it('does not add result event to message list', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        // CAST: Synthetic SDKResultMessage — usage does not fully satisfy NonNullableUsage.
        eventOutput({
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
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: DEFAULT_UUID,
          session_id: DEFAULT_SESSION_ID,
        } as unknown as AgentCodecEvent),
      ]);

      expect(acc.messages).toHaveLength(0);
    });

    it('cleans up active streams on result (abort/completion)', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
      ]);

      expect(acc.hasActiveStream).toBe(true);

      acc.processOutputs([
        // CAST: Synthetic SDKResultMessage — usage does not fully satisfy NonNullableUsage.
        eventOutput({
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
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: DEFAULT_UUID,
          session_id: DEFAULT_SESSION_ID,
        } as unknown as AgentCodecEvent),
      ]);

      // Result is a terminal signal — active streams are cleaned up
      expect(acc.hasActiveStream).toBe(false);
    });
  });

  // -- tool_progress handling -------------------------------------------------

  describe('tool_progress handling', () => {
    it('does not add tool_progress event to message list', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput({
          type: 'tool_progress',
          tool_use_id: 'tc-1',
          tool_name: 'search',
          // eslint-disable-next-line unicorn/no-null -- SDK type requires null
          parent_tool_use_id: null,
          elapsed_time_seconds: 5,
          uuid: DEFAULT_UUID,
          session_id: DEFAULT_SESSION_ID,
        } as AgentCodecEvent),
      ]);

      expect(acc.messages).toHaveLength(0);
    });
  });

  // -- updateMessage ----------------------------------------------------------

  describe('updateMessage', () => {
    it('replaces existing message in completed list by uuid', () => {
      const acc = createAccumulator();
      const original = completeAssistantMessage('msg-a', [{ type: 'text', text: 'original' }], {
        uuid: 'uuid-1' as UUID,
      });
      acc.processOutputs([messageOutput(original)]);

      const updated = completeAssistantMessage('msg-a', [{ type: 'text', text: 'updated' }], {
        uuid: 'uuid-1' as UUID,
      });
      acc.updateMessage(updated);

      expect(acc.messages).toHaveLength(1);
      expect(acc.messages[0]).toBe(updated);
      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(expect.objectContaining({ text: 'updated' }));
    });

    it('does nothing for unknown message', () => {
      const acc = createAccumulator();
      const unknown = completeAssistantMessage('unknown', [], { uuid: 'uuid-unknown' as UUID });
      acc.updateMessage(unknown);
      expect(acc.messages).toHaveLength(0);
    });

    it('replaces message matched by session_id when uuid is absent', () => {
      const acc = createAccumulator();
      const user = userMessage('hello', { sessionId: 'session-1' });
      // Anthropic.SDKUserMessage has optional uuid — when absent, fall back to session_id
      delete (user as Record<string, unknown>).uuid;
      acc.processOutputs([messageOutput(user)]);

      const updated: Anthropic.SDKUserMessage = {
        ...user,
        message: { role: 'user', content: 'updated hello' },
      };
      acc.updateMessage(updated);

      expect(acc.messages).toHaveLength(1);
      expect(acc.messages[0]).toBe(updated);
    });
  });

  // -- multiple concurrent messages -------------------------------------------

  describe('multiple concurrent messages', () => {
    it('routes interleaved events to separate messages by messageId', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        eventOutput(messageStartEvent('msg-a', { uuid: 'uuid-a' as UUID }), 'msg-a'),
        eventOutput(messageStartEvent('msg-b', { uuid: 'uuid-b' as UUID }), 'msg-b'),
        eventOutput(textBlockStart(0), 'msg-a'),
        eventOutput(textBlockStart(0), 'msg-b'),
        eventOutput(textDelta(0, 'hello'), 'msg-a'),
        eventOutput(textDelta(0, 'world'), 'msg-b'),
        eventOutput(contentBlockStop(0), 'msg-a'),
        eventOutput(contentBlockStop(0), 'msg-b'),
        eventOutput(messageStop(), 'msg-a'),
        eventOutput(messageStop(), 'msg-b'),
      ]);

      expect(acc.messages).toHaveLength(2);
      expect(acc.completedMessages).toHaveLength(2);

      const contentA = getContent(at(acc.messages, 0));
      const contentB = getContent(at(acc.messages, 1));
      expect(contentA[0]).toEqual(expect.objectContaining({ type: 'text', text: 'hello' }));
      expect(contentB[0]).toEqual(expect.objectContaining({ type: 'text', text: 'world' }));
    });

    it('tracks active streams independently per message', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        eventOutput(messageStartEvent('msg-a', { uuid: 'uuid-a' as UUID }), 'msg-a'),
        eventOutput(messageStartEvent('msg-b', { uuid: 'uuid-b' as UUID }), 'msg-b'),
        eventOutput(textBlockStart(0), 'msg-a'),
        eventOutput(textBlockStart(0), 'msg-b'),
      ]);

      expect(acc.hasActiveStream).toBe(true);
      expect(acc.completedMessages).toHaveLength(0);

      // Finish message A only
      acc.processOutputs([
        eventOutput(contentBlockStop(0), 'msg-a'),
        eventOutput(messageStop(), 'msg-a'),
      ]);

      expect(acc.hasActiveStream).toBe(true); // msg-b still streaming
      expect(acc.completedMessages).toHaveLength(1);

      // Finish message B
      acc.processOutputs([
        eventOutput(contentBlockStop(0), 'msg-b'),
        eventOutput(messageStop(), 'msg-b'),
      ]);

      expect(acc.hasActiveStream).toBe(false);
      expect(acc.completedMessages).toHaveLength(2);
    });

    it('handles message_stop on one without affecting the other', () => {
      const acc = createAccumulator();

      acc.processOutputs([
        eventOutput(messageStartEvent('msg-a', { uuid: 'uuid-a' as UUID }), 'msg-a'),
        eventOutput(messageStartEvent('msg-b', { uuid: 'uuid-b' as UUID }), 'msg-b'),
        eventOutput(textBlockStart(0), 'msg-a'),
        eventOutput(textBlockStart(0), 'msg-b'),
        eventOutput(textDelta(0, 'partial-a'), 'msg-a'),
        eventOutput(contentBlockStop(0), 'msg-a'),
        eventOutput(messageStop(), 'msg-a'),
      ]);

      // msg-a completed; msg-b still active
      expect(acc.completedMessages).toHaveLength(1);
      expect(acc.hasActiveStream).toBe(true);

      acc.processOutputs([
        eventOutput(textDelta(0, 'still going'), 'msg-b'),
        eventOutput(contentBlockStop(0), 'msg-b'),
        eventOutput(messageStop(), 'msg-b'),
      ]);

      expect(acc.messages).toHaveLength(2);
      expect(acc.completedMessages).toHaveLength(2);
      expect(acc.hasActiveStream).toBe(false);

      const contentB = getContent(at(acc.messages, 1));
      expect(contentB[0]).toEqual(expect.objectContaining({ type: 'text', text: 'still going' }));
    });
  });

  // -- edge cases -------------------------------------------------------------

  describe('edge cases', () => {
    it('message_stop without prior message_start is a no-op', () => {
      const acc = createAccumulator();
      acc.processOutputs([eventOutput(messageStop())]);

      expect(acc.messages).toHaveLength(0);
      expect(acc.hasActiveStream).toBe(false);
    });

    it('content_block_stop without prior start is a no-op', () => {
      const acc = createAccumulator();
      acc.processOutputs([eventOutput(contentBlockStop(0))]);

      expect(acc.messages).toHaveLength(0);
    });

    it('content_block_delta without active message is a no-op', () => {
      const acc = createAccumulator();
      acc.processOutputs([eventOutput(textDelta(0, 'orphan'))]);

      expect(acc.messages).toHaveLength(0);
    });

    it('content_block_delta for unknown block index is a no-op', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        // Delta for index 5 which has no block state
        eventOutput(textDelta(5, 'orphan')),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      // Only index 0 should exist with empty text
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: '' }));
    });

    it('handles non-streaming content block types in default branch', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(
          makeStreamEvent({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'unknown_type', data: 'foo' },
          }),
        ),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      const content = getContent(at(acc.messages, 0));
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual(expect.objectContaining({ type: 'unknown_type', data: 'foo' }));
    });

    it('handles unknown stream event types gracefully', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(makeStreamEvent({ type: 'some_future_event' })),
        eventOutput(messageStop()),
      ]);

      // Should not throw, message should still be completed
      expect(acc.completedMessages).toHaveLength(1);
    });

    it('handles unknown delta types gracefully', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(messageStartEvent()),
        eventOutput(textBlockStart(0)),
        eventOutput(
          makeStreamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'citations_delta', citation: {} },
          }),
        ),
        eventOutput(contentBlockStop(0)),
        eventOutput(messageStop()),
      ]);

      // Should not throw, text should remain empty
      const content = getContent(at(acc.messages, 0));
      expect(content[0]).toEqual(expect.objectContaining({ type: 'text', text: '' }));
    });

    it('ignores event outputs without messageId', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        { kind: 'event', event: messageStartEvent(), messageId: undefined },
      ]);

      expect(acc.messages).toHaveLength(0);
    });

    it('hasActiveStream is false when no messages exist', () => {
      const acc = createAccumulator();
      expect(acc.hasActiveStream).toBe(false);
    });

    it('hasActiveStream is false with only completed messages', () => {
      const acc = createAccumulator();
      acc.processOutputs([messageOutput(completeAssistantMessage('msg-a'))]);
      expect(acc.hasActiveStream).toBe(false);
    });

    it('messages property returns completed then in-progress messages', () => {
      const acc = createAccumulator();
      const user = userMessage('hello');
      acc.processOutputs([messageOutput(user)]);

      // Start a streaming message
      acc.processOutputs([
        eventOutput(messageStartEvent('msg-stream'), 'msg-stream'),
        eventOutput(textBlockStart(0), 'msg-stream'),
      ]);

      expect(acc.messages).toHaveLength(2);
      expect(acc.messages[0]).toBe(user); // completed first
      expect(acc.messages[1]?.type).toBe('assistant'); // in-progress second
    });

    it('preserves parent_tool_use_id from outer event in message_start', () => {
      const acc = createAccumulator();
      acc.processOutputs([
        eventOutput(
          messageStartEvent('msg-nested', { parentToolUseId: 'parent-tool-1' }),
          'msg-nested',
        ),
        eventOutput(textBlockStart(0), 'msg-nested'),
        eventOutput(textDelta(0, 'nested'), 'msg-nested'),
        eventOutput(contentBlockStop(0), 'msg-nested'),
        eventOutput(messageStop(), 'msg-nested'),
      ]);

      const msg = at(acc.messages, 0) as Anthropic.SDKAssistantMessage;
      expect(msg.parent_tool_use_id).toBe('parent-tool-1');
    });

    it('preserves uuid and session_id from outer event in message_start', () => {
      const acc = createAccumulator();
      const uuid = 'custom-uuid' as UUID;
      acc.processOutputs([
        eventOutput(
          messageStartEvent('msg-ids', { uuid, sessionId: 'custom-session' }),
          'msg-ids',
        ),
        eventOutput(messageStop(), 'msg-ids'),
      ]);

      const msg = at(acc.messages, 0) as Anthropic.SDKAssistantMessage;
      expect(msg.uuid).toBe(uuid);
      expect(msg.session_id).toBe('custom-session');
    });
  });
});
