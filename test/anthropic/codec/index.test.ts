/**
 * Anthropic AgentCodec entry point tests.
 *
 * Verifies the codec object is wired correctly: factory methods return
 * the right types and isTerminal identifies result messages.
 */

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

});
