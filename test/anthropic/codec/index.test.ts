/**
 * Anthropic AgentCodec entry point tests.
 *
 * Verifies the codec object is wired correctly: factory methods return
 * the right types, isTerminal identifies result messages, and getMessageKey
 * returns stable identifiers for both message types.
 */

import type { UUID } from 'node:crypto';

import type * as Anthropic from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { AgentCodec } from '../../../src/anthropic/codec/index.js';
import type { AgentCodecEvent } from '../../../src/anthropic/codec/types.js';

describe('AgentCodec', () => {
  it('creates an encoder', () => {
    const mockWriter = {
      publish: async () => await Promise.resolve({ serial: 's1' }),
      appendMessage: async () => await Promise.resolve({ serial: 's1' }),
      updateMessage: async () => await Promise.resolve({ serial: 's1' }),
    };
     
    const encoder = AgentCodec.createEncoder(mockWriter as never);
    expect(encoder).toBeDefined();
    expect(typeof encoder.appendEvent).toBe('function');
    expect(typeof encoder.writeMessages).toBe('function');
    expect(typeof encoder.abort).toBe('function');
    expect(typeof encoder.close).toBe('function');
  });

  it('creates a decoder', () => {
    const decoder = AgentCodec.createDecoder();
    expect(decoder).toBeDefined();
    expect(typeof decoder.decode).toBe('function');
  });

  it('creates an accumulator', () => {
    const accumulator = AgentCodec.createAccumulator();
    expect(accumulator).toBeDefined();
    expect(accumulator.messages).toEqual([]);
    expect(accumulator.completedMessages).toEqual([]);
    expect(accumulator.hasActiveStream).toBe(false);
  });

  describe('isTerminal', () => {
    it('returns true for result messages', () => {
      const result = {
        type: 'result',
        subtype: 'success',
      } as Anthropic.SDKResultMessage;
      expect(AgentCodec.isTerminal(result as AgentCodecEvent)).toBe(true);
    });

    it('returns false for stream events', () => {
      const streamEvent = {
        type: 'stream_event',
      } as AgentCodecEvent;
      expect(AgentCodec.isTerminal(streamEvent)).toBe(false);
    });

    it('returns false for assistant messages', () => {
      const assistant = {
        type: 'assistant',
      } as AgentCodecEvent;
      expect(AgentCodec.isTerminal(assistant)).toBe(false);
    });

    it('returns false for user messages', () => {
      const user = {
        type: 'user',
      } as AgentCodecEvent;
      expect(AgentCodec.isTerminal(user)).toBe(false);
    });
  });

  describe('getMessageKey', () => {
    it('returns uuid for assistant messages', () => {
      const msg: Anthropic.SDKAssistantMessage = {
        type: 'assistant',
        uuid: 'assistant-uuid-1' as UUID,
        session_id: 'session-1',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        parent_tool_use_id: null,
        // CAST: Empty shell for test — only uuid field matters for this test.
        message: {} as unknown as Anthropic.SDKAssistantMessage['message'],
      };
      expect(AgentCodec.getMessageKey(msg)).toBe('assistant-uuid-1');
    });

    it('returns uuid for user messages with uuid', () => {
      const msg: Anthropic.SDKUserMessage = {
        type: 'user',
        uuid: 'user-uuid-1' as UUID,
        session_id: 'session-1',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      };
      expect(AgentCodec.getMessageKey(msg)).toBe('user-uuid-1');
    });

    it('falls back to session_id for user messages without uuid', () => {
      const msg: Anthropic.SDKUserMessage = {
        type: 'user',
        session_id: 'session-fallback',
        // eslint-disable-next-line unicorn/no-null -- SDK type requires null
        parent_tool_use_id: null,
        message: { role: 'user', content: 'hello' },
      };
      expect(AgentCodec.getMessageKey(msg)).toBe('session-fallback');
    });
  });
});
