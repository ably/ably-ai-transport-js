import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { createDecoder } from '../../../src/anthropic/codec/decoder.js';
import type { AgentCodecEvent, AgentMessage } from '../../../src/anthropic/codec/types.js';
import {
  DOMAIN_HEADER_PREFIX as D,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_STATUS,
  HEADER_STREAM,
  HEADER_STREAM_ID,
  HEADER_TURN_ID,
} from '../../../src/constants.js';
import type { DecoderOutput } from '../../../src/core/codec/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Out = DecoderOutput<AgentCodecEvent, AgentMessage>;

// Retrieve an array element, throwing if it is undefined.
const at = <T>(arr: T[], index: number): T => {
  const item = arr[index];
  if (item === undefined) throw new Error(`expected element at index ${String(index)}`);
  return item;
};

const withHeaders = (
  msg: Partial<Ably.InboundMessage>,
  headers: Record<string, string>,
): Ably.InboundMessage =>
  ({
    serial: 'serial-1',
    action: 'message.create',
    name: 'text',
    data: '',
    ...msg,
    extras: { headers },
  }) as unknown as Ably.InboundMessage;

const eventsOf = (outputs: Out[]): AgentCodecEvent[] =>
  outputs
    .filter((o): o is Out & { kind: 'event'; event: AgentCodecEvent } => o.kind === 'event' && 'event' in o)
    .map((o) => o.event);

const messagesOf = (outputs: Out[]): AgentMessage[] =>
  outputs
    .filter((o): o is Out & { kind: 'message'; message: AgentMessage } => o.kind === 'message' && 'message' in o)
    .map((o) => o.message);

// Extract the inner stream event from an Anthropic.SDKPartialAssistantMessage.
// Returns undefined if the event is not an Anthropic.SDKPartialAssistantMessage.
const streamEventOf = (event: AgentCodecEvent): Anthropic.SDKPartialAssistantMessage['event'] | undefined => {
  if (event.type !== 'stream_event') return undefined;
   
  return (event).event;
};

// Extract all inner stream events from decoder outputs.
const streamEventsOf = (outputs: Out[]): Anthropic.SDKPartialAssistantMessage['event'][] =>
  eventsOf(outputs)

    .map((e) => streamEventOf(e))
    .filter((e): e is Anthropic.SDKPartialAssistantMessage['event'] => e !== undefined);

// Extract the `type` fields of inner stream events.
const streamEventTypesOf = (outputs: Out[]): string[] =>

  streamEventsOf(outputs).map((e) => e.type);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Anthropic decoder', () => {
  // -- streamed text --------------------------------------------------------

  describe('streamed text', () => {
    it('emits content_block_start with text type on stream create', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
            [`${D}model`]: 'claude-sonnet-4-20250514',
          },
        ),
      );

      const types = streamEventTypesOf(outputs);
      // Should have message_start (synthesized) + content_block_start
      expect(types).toContain('message_start');
      expect(types).toContain('content_block_start');


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(
        expect.objectContaining({
          type: 'content_block_start',
          index: 0,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          content_block: expect.objectContaining({ type: 'text', text: '' }),
        }),
      );
    });

    it('emits content_block_delta with text_delta on append', () => {
      const decoder = createDecoder();
      // Create
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      // Append
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'text', data: 'hello' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const events = streamEventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          type: 'content_block_delta',
          index: 0,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          delta: expect.objectContaining({ type: 'text_delta', text: 'hello' }),
        }),
      );
    });

    it('emits content_block_stop on finished append', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'text', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1', [`${D}blockIndex`]: '0' },
        ),
      );

      expect(streamEventTypesOf(outputs)).toContain('content_block_stop');

      const stop = streamEventsOf(outputs).find((e) => e.type === 'content_block_stop');
      expect(stop).toEqual(expect.objectContaining({ type: 'content_block_stop', index: 0 }));
    });
  });

  // -- streamed tool-input --------------------------------------------------

  describe('streamed tool-input', () => {
    it('emits content_block_start with tool_use type on create', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '1',
            [`${D}toolUseId`]: 'tc-1',
            [`${D}toolName`]: 'search',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(
        expect.objectContaining({
          type: 'content_block_start',
          index: 1,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          content_block: expect.objectContaining({
            type: 'tool_use',
            id: 'tc-1',
            name: 'search',
            input: {},
          }),
        }),
      );
    });

    it('emits content_block_delta with input_json_delta on append', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '1',
            [`${D}toolUseId`]: 'tc-1',
            [`${D}toolName`]: 'search',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'tool-input', data: '{"q":"test"}' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );


      const delta = streamEventsOf(outputs).find((e) => e.type === 'content_block_delta');
      expect(delta).toEqual(
        expect.objectContaining({
          type: 'content_block_delta',
          index: 1,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          delta: expect.objectContaining({ type: 'input_json_delta', partial_json: '{"q":"test"}' }),
        }),
      );
    });

    it('emits content_block_stop on finished', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '1',
            [`${D}toolUseId`]: 'tc-1',
            [`${D}toolName`]: 'search',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'tool-input', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1', [`${D}blockIndex`]: '1' },
        ),
      );

      expect(streamEventTypesOf(outputs)).toContain('content_block_stop');
    });
  });

  // -- streamed thinking ----------------------------------------------------

  describe('streamed thinking', () => {
    it('emits content_block_start with thinking type on create', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'thinking', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'th-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(
        expect.objectContaining({
          type: 'content_block_start',
          index: 0,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          content_block: expect.objectContaining({ type: 'thinking', thinking: '', signature: '' }),
        }),
      );
    });

    it('emits content_block_delta with thinking_delta on append', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'thinking', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'th-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'thinking', data: 'hmm let me think' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );


      const delta = streamEventsOf(outputs).find((e) => e.type === 'content_block_delta');
      expect(delta).toEqual(
        expect.objectContaining({
          type: 'content_block_delta',
          index: 0,

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          delta: expect.objectContaining({ type: 'thinking_delta', thinking: 'hmm let me think' }),
        }),
      );
    });

    it('emits content_block_stop on finished', () => {
      const decoder = createDecoder();
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'thinking', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'th-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'thinking', data: '' },
          { [HEADER_STATUS]: 'finished', [HEADER_TURN_ID]: 'turn-1', [`${D}blockIndex`]: '0' },
        ),
      );

      expect(streamEventTypesOf(outputs)).toContain('content_block_stop');
    });
  });

  // -- discrete: message-start ----------------------------------------------

  describe('discrete message-start', () => {
    it('produces Anthropic.SDKPartialAssistantMessage wrapping message_start', () => {
      const decoder = createDecoder();
      const messageData = {
        id: 'msg-abc',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [],
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_reason: null,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-start', data: messageData },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}messageId`]: 'msg-abc',
            [`${D}model`]: 'claude-sonnet-4-20250514',
          },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('stream_event');

      const inner = streamEventOf(at(events, 0));

      expect(inner?.type).toBe('message_start');
    });

    it('marks the phase as emitted so lifecycle tracker does not re-synthesize', () => {
      const decoder = createDecoder();

      // Explicit message-start arrives first
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-start', data: { id: 'msg-1', type: 'message', role: 'assistant', model: 'test', content: [] } },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );

      // Next streamed content block — should NOT synthesize another message_start
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );


      const messageStartCount = streamEventsOf(outputs).filter((e) => e.type === 'message_start').length;
      expect(messageStartCount).toBe(0);
    });
  });

  // -- discrete: message-delta ----------------------------------------------

  describe('discrete message-delta', () => {
    it('produces Anthropic.SDKPartialAssistantMessage wrapping message_delta', () => {
      const decoder = createDecoder();
      const deltaData = { stop_reason: 'end_turn' };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-delta', data: deltaData },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('stream_event');

      const inner = streamEventOf(at(events, 0));

      expect(inner?.type).toBe('message_delta');
    });
  });

  // -- discrete: message-stop -----------------------------------------------

  describe('discrete message-stop', () => {
    it('produces Anthropic.SDKPartialAssistantMessage wrapping message_stop', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-stop', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('stream_event');

      const inner = streamEventOf(at(events, 0));

      expect(inner?.type).toBe('message_stop');
    });
  });

  // -- discrete: assistant-message ------------------------------------------

  describe('discrete assistant-message', () => {
    it('produces kind:message with Anthropic.SDKAssistantMessage', () => {
      const decoder = createDecoder();
      const betaMessage = {
        id: 'msg-abc',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello!' }],
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_reason: null,
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 10 },
      };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'assistant-message', data: betaMessage },
          {
            [HEADER_STREAM]: 'false',
            [`${D}parentToolUseId`]: 'tool-1',
            [`${D}messageId`]: 'uuid-1',
          },
        ),
      );

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Anthropic.SDKAssistantMessage;
      expect(msg.type).toBe('assistant');
      expect(msg.parent_tool_use_id).toBe('tool-1');
      expect(msg.uuid).toBe('uuid-1');
      expect(msg.message).toBe(betaMessage);
    });

    it('defaults parent_tool_use_id to null when header is absent', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'assistant-message', data: { id: 'msg-1' } },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      const msg = messagesOf(outputs)[0] as Anthropic.SDKAssistantMessage;
       
      expect(msg.parent_tool_use_id).toBeNull();
    });
  });

  // -- discrete: user-message -----------------------------------------------

  describe('discrete user-message', () => {
    it('produces kind:message with Anthropic.SDKUserMessage', () => {
      const decoder = createDecoder();
      const messageParam = { role: 'user', content: 'Hello from user' };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'user-message', data: messageParam },
          {
            [HEADER_STREAM]: 'false',
            [`${D}parentToolUseId`]: 'tool-2',
            [`${D}uuid`]: 'uuid-2',
            [`${D}isSynthetic`]: 'true',
          },
        ),
      );

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Anthropic.SDKUserMessage;
      expect(msg.type).toBe('user');
      expect(msg.parent_tool_use_id).toBe('tool-2');
      expect(msg.uuid).toBe('uuid-2');
      expect(msg.isSynthetic).toBe(true);
      expect(msg.message).toBe(messageParam);
    });

    it('decodes user-message with x-ably-role header via role dispatch', () => {
      const decoder = createDecoder();
      const messageParam = { role: 'user', content: 'Hi' };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'user-message', data: messageParam },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_ROLE]: 'user',
            [`${D}messageId`]: 'uuid-3',
          },
        ),
      );

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(1);
      expect((messages[0] as Anthropic.SDKUserMessage).type).toBe('user');
    });

    it('decodes assistant role via x-ably-role header as Anthropic.SDKAssistantMessage', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'assistant-message', data: { id: 'msg-1' } },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_ROLE]: 'assistant',
            [`${D}messageId`]: 'uuid-4',
          },
        ),
      );

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(1);
      expect((messages[0] as Anthropic.SDKAssistantMessage).type).toBe('assistant');
    });
  });

  // -- discrete: result -----------------------------------------------------

  describe('discrete result', () => {
    it('produces kind:event with Anthropic.SDKResultMessage', () => {
      const decoder = createDecoder();
      // CAST: Synthetic SDKResultMessage — usage does not fully satisfy NonNullableUsage.
      const resultData = {
        type: 'result' as const,
        subtype: 'success' as const,
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: false,
        num_turns: 1,
        result: 'done',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'result-uuid' as UUID,
        session_id: 'session-1',
      } as unknown as Anthropic.SDKResultMessage;

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'result', data: resultData },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(resultData);
    });

    it('dispatches by name even when x-ably-role header is present', () => {
      // Regression: the transport stamps x-ably-role: assistant on all messages
      // in a turn, including result events. The decoder must dispatch result
      // events by name ('result'), not by role (which would misroute them as
      // assistant-message kind:'message' outputs).
      const decoder = createDecoder();
      const resultData = {
        type: 'result' as const,
        subtype: 'success' as const,
        is_error: false,
      } as unknown as Anthropic.SDKResultMessage;

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'result', data: resultData },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [HEADER_ROLE]: 'assistant',
          },
        ),
      );

      // Must produce kind:'event' (terminal signal), NOT kind:'message'
      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(resultData);

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(0);
    });
  });

  // -- discrete: tool-progress ----------------------------------------------

  describe('discrete tool-progress', () => {
    it('produces kind:event with Anthropic.SDKToolProgressMessage', () => {
      const decoder = createDecoder();
      const progressData: Anthropic.SDKToolProgressMessage = {
        type: 'tool_progress',
        tool_use_id: 'tu-1',
        tool_name: 'bash',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        uuid: 'progress-uuid' as UUID,
        session_id: 'session-1',
      };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'tool-progress', data: progressData },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(progressData);
    });
  });

  // -- discrete: abort ------------------------------------------------------

  describe('discrete abort', () => {
    it('produces kind:event with Anthropic.SDKResultMessage (terminal)', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'abort', data: 'user cancelled' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      const result = events[0] as Anthropic.SDKResultMessage;
      expect(result.type).toBe('result');
      expect(result.subtype).toBe('error_during_execution');
      expect(result.is_error).toBe(true);
    });

    it('uses "cancelled" as default reason when data is empty', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'abort', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const result = eventsOf(outputs)[0] as Anthropic.SDKResultMessage;
      expect(result.stop_reason).toBe('cancelled');
    });

    it('uses provided reason string', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'abort', data: 'timeout' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      const result = eventsOf(outputs)[0] as Anthropic.SDKResultMessage;
      expect(result.stop_reason).toBe('timeout');
    });

    it('clears lifecycle scope so subsequent turns start fresh', () => {
      const decoder = createDecoder();

      // Start a turn — lifecycle tracker creates a scope
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );

      // Abort the turn
      decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'abort', data: 'cancelled' },
          { [HEADER_STREAM]: 'false', [HEADER_TURN_ID]: 'turn-1' },
        ),
      );

      // New stream on same turn-1 after abort — lifecycle tracker should re-synthesize message_start
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-2',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-2',
          },
        ),
      );

      expect(streamEventTypesOf(outputs)).toContain('message_start');
    });
  });

  // -- discrete: content-block ----------------------------------------------

  describe('discrete content-block', () => {
    it('produces kind:event with Anthropic.SDKPartialAssistantMessage wrapping content_block_start', () => {
      const decoder = createDecoder();
      const contentBlock = { type: 'text', text: 'Final text.' };

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'content-block', data: contentBlock },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '2',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );

      const events = eventsOf(outputs);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('stream_event');

      const inner = streamEventOf(at(events, 0));
      expect(inner).toEqual(
        expect.objectContaining({
          type: 'content_block_start',
          index: 2,
          content_block: contentBlock,
        }),
      );
    });
  });

  // -- lifecycle tracker: synthetic message_start ---------------------------

  describe('lifecycle tracker', () => {
    it('synthesizes message_start before first content_block_start in a turn', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
            [`${D}model`]: 'claude-sonnet-4-20250514',
          },
        ),
      );

      const types = streamEventTypesOf(outputs);
      const msgStartIdx = types.indexOf('message_start');
      const blockStartIdx = types.indexOf('content_block_start');
      expect(msgStartIdx).toBeGreaterThanOrEqual(0);
      expect(blockStartIdx).toBeGreaterThan(msgStartIdx);
    });

    it('synthetic message_start uses messageId and model from domain headers', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'synth-msg-1',
            [`${D}model`]: 'claude-opus-4-20250514',
          },
        ),
      );


      const msgStart = streamEventsOf(outputs).find((e) => e.type === 'message_start');
      expect(msgStart).toBeDefined();
      // The synthetic message_start should carry the model and id from headers
      const message = (msgStart as { type: 'message_start'; message: { id: string; model: string } }).message;
      expect(message.id).toBe('synth-msg-1');
      expect(message.model).toBe('claude-opus-4-20250514');
    });

    it('emits message_start only once per turn', () => {
      const decoder = createDecoder();

      // First stream in turn
      const first = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );
      expect(streamEventTypesOf(first)).toContain('message_start');

      // Second stream in same turn
      const second = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's2', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '1',
            [`${D}toolUseId`]: 'tc-1',
            [`${D}toolName`]: 'search',
          },
        ),
      );
      expect(streamEventTypesOf(second)).not.toContain('message_start');
    });

    it('mid-stream join: append without preceding create synthesizes message_start', () => {
      const decoder = createDecoder();

      // Simulate mid-stream join: first message is an append (treated as first-contact update by decoder core)
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'text', data: 'partial' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
            [`${D}model`]: 'claude-sonnet-4-20250514',
          },
        ),
      );

      // The decoder core falls through to first-contact (update) path
      // which calls buildStartEvents → ensurePhases synthesizes message_start
      const types = streamEventTypesOf(outputs);
      expect(types).toContain('message_start');
      expect(types).toContain('content_block_start');
      expect(types).toContain('content_block_delta');
    });
  });

  // -- domain headers -------------------------------------------------------

  describe('domain headers', () => {
    it('blockIndex is extracted correctly for content blocks', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '3',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(expect.objectContaining({ index: 3 }));
    });

    it('defaults blockIndex to 0 when header is missing', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(expect.objectContaining({ index: 0 }));
    });

    it('toolUseId and toolName are read for tool-input blocks', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'tool-input', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'tc-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '1',
            [`${D}toolUseId`]: 'tool-use-abc',
            [`${D}toolName`]: 'file_editor',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(
        expect.objectContaining({

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          content_block: expect.objectContaining({
            type: 'tool_use',
            id: 'tool-use-abc',
            name: 'file_editor',
          }),
        }),
      );
    });

    it('parentToolUseId is read for Anthropic.SDKPartialAssistantMessage wrapping', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}parentToolUseId`]: 'parent-tool-1',
          },
        ),
      );

      const events = eventsOf(outputs);
      // Find the content_block_start event (not the synthesized message_start from lifecycle tracker)
      const partial = events.find(
  
        (e) => e.type === 'stream_event' && (e).event.type === 'content_block_start',
      ) as Anthropic.SDKPartialAssistantMessage | undefined;
      expect(partial?.parent_tool_use_id).toBe('parent-tool-1');
    });

    it('parentToolUseId defaults to null when absent', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const partial = eventsOf(outputs).find((e) => e.type === 'stream_event');
       
      expect(partial?.parent_tool_use_id).toBeNull();
    });

    it('messageId is read for message-start events', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-start', data: { id: 'msg-x', type: 'message' } },
          {
            [HEADER_STREAM]: 'false',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}messageId`]: 'msg-uuid-123',
          },
        ),
      );

      const partial = eventsOf(outputs).find((e) => e.type === 'stream_event');
      expect(partial?.uuid).toBe('msg-uuid-123');
    });

    it('model is read for synthetic message_start events', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
            [`${D}model`]: 'claude-haiku-3',
          },
        ),
      );


      const msgStart = streamEventsOf(outputs).find((e) => e.type === 'message_start');
      const message = (msgStart as { type: 'message_start'; message: { model: string } }).message;
      expect(message.model).toBe('claude-haiku-3');
    });
  });

  // -- first-contact path (message.update for unknown serial) ---------------

  describe('first-contact update (history hydration)', () => {
    it('emits full lifecycle for finished streamed message', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'hello world' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'finished',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
            [`${D}messageId`]: 'msg-1',
          },
        ),
      );

      const types = streamEventTypesOf(outputs);
      expect(types).toContain('message_start');
      expect(types).toContain('content_block_start');
      expect(types).toContain('content_block_delta');
      expect(types).toContain('content_block_stop');


      const delta = streamEventsOf(outputs).find((e) => e.type === 'content_block_delta');
      expect(delta).toEqual(
        expect.objectContaining({
          type: 'content_block_delta',

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          delta: expect.objectContaining({ type: 'text_delta', text: 'hello world' }),
        }),
      );
    });

    it('emits start + delta but no stop for a still-streaming first contact', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: 'partial' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const types = streamEventTypesOf(outputs);
      expect(types).toContain('content_block_start');
      expect(types).toContain('content_block_delta');
      expect(types).not.toContain('content_block_stop');
    });

    it('does not emit delta when first-contact data is empty', () => {
      const decoder = createDecoder();
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.update', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const types = streamEventTypesOf(outputs);
      expect(types).toContain('content_block_start');
      expect(types).not.toContain('content_block_delta');
    });
  });

  // -- default stream name handling -----------------------------------------

  describe('default stream name handling', () => {
    it('treats unknown stream name as text type for start events', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'unknown-type', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'unk-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );


      const blockStart = streamEventsOf(outputs).find((e) => e.type === 'content_block_start');
      expect(blockStart).toEqual(
        expect.objectContaining({

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          content_block: expect.objectContaining({ type: 'text' }),
        }),
      );
    });

    it('treats unknown stream name as text_delta for delta events', () => {
      const decoder = createDecoder();

      // Create with unknown name
      decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'unknown-type', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'unk-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      // Append
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.append', serial: 's1', name: 'unknown-type', data: 'fallback text' },
          { [HEADER_TURN_ID]: 'turn-1' },
        ),
      );


      const delta = streamEventsOf(outputs).find((e) => e.type === 'content_block_delta');
      expect(delta).toEqual(
        expect.objectContaining({

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
          delta: expect.objectContaining({ type: 'text_delta', text: 'fallback text' }),
        }),
      );
    });
  });

  // -- edge cases -----------------------------------------------------------

  describe('edge cases', () => {
    it('unknown message name in decodeDiscrete returns empty output', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'completely-unknown', data: 'something' },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      expect(outputs).toHaveLength(0);
    });

    it('missing domain headers produce graceful defaults', () => {
      const decoder = createDecoder();

      // assistant-message with no domain headers at all
      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'assistant-message', data: { id: 'msg-1' } },
          { [HEADER_STREAM]: 'false' },
        ),
      );

      const messages = messagesOf(outputs);
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Anthropic.SDKAssistantMessage;
       
      expect(msg.parent_tool_use_id).toBeNull();
      expect(msg.uuid).toBe('');
    });

    it('unknown action returns empty output', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.summary' as Ably.InboundMessage['action'] },
          {},
        ),
      );

      expect(outputs).toHaveLength(0);
    });

    it('message.create without serial for streamed message returns empty output', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: undefined, name: 'text', data: '' },
          { [HEADER_STREAM]: 'true', [HEADER_STATUS]: 'streaming' },
        ),
      );

      expect(outputs).toHaveLength(0);
    });

    it('tags event outputs with messageId from x-ably-msg-id', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', name: 'message-stop', data: '' },
          { [HEADER_STREAM]: 'false', [HEADER_MSG_ID]: 'ably-msg-42' },
        ),
      );

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.kind).toBe('event');
      if (outputs[0]?.kind === 'event') {
        expect(outputs[0].messageId).toBe('ably-msg-42');
      }
    });
  });

  // -- wrapStreamEvent envelope fields --------------------------------------

  describe('wrapStreamEvent envelope', () => {
    it('sets session_id to empty string', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      const partial = eventsOf(outputs).find((e) => e.type === 'stream_event');
      expect(partial?.session_id).toBe('');
    });

    it('uses "synthetic" as uuid when messageId header is absent', () => {
      const decoder = createDecoder();

      const outputs = decoder.decode(
        withHeaders(
          { action: 'message.create', serial: 's1', name: 'text', data: '' },
          {
            [HEADER_STREAM]: 'true',
            [HEADER_STATUS]: 'streaming',
            [HEADER_STREAM_ID]: 'txt-1',
            [HEADER_TURN_ID]: 'turn-1',
            [`${D}blockIndex`]: '0',
          },
        ),
      );

      // The content_block_start event (not the synthetic message_start) should
      // have uuid derived from the stream headers
      const partials = eventsOf(outputs).filter((e) => e.type === 'stream_event');
      const blockStartPartial = partials.find(
  
        (p) => p.event.type === 'content_block_start',
      );
      expect(blockStartPartial?.uuid).toBe('synthetic');
    });
  });
});
