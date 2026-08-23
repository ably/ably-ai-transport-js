import { describe, expect, it } from 'vitest';

import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { createUIMessageSessionCodec } from '../../../src/vercel/codec/session-codec.js';

const WireUIMessageCodec = createUIMessageCodec();
const UIMessageCodec = createUIMessageSessionCodec();

describe('createUIMessageCodec', () => {
  it('carries adapterTag: "vercel" for Ably-Agent header registration', () => {
    expect(WireUIMessageCodec.adapterTag).toBe('vercel-ai-sdk-ui-message');
    expect(UIMessageCodec.adapterTag).toBe('vercel-ai-sdk-ui-message');
  });

  describe('createUserMessage', () => {
    it('wraps a UIMessage as a UserMessage with kind: "user-message"', () => {
      const message = { id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] };
      const input = UIMessageCodec.createUserMessage(message);
      expect(input).toEqual({ kind: 'user-message', message });
    });
  });

  describe('createRegenerate', () => {
    it('builds a regenerate input carrying target + parent ids', () => {
      const input = UIMessageCodec.createRegenerate('asst-A1', 'user-U1');
      expect(input).toEqual({
        kind: 'regenerate',
        target: 'asst-A1',
        parent: 'user-U1',
      });
    });
  });

  describe('createToolResult', () => {
    it('builds a tool-result input carrying codecMessageId and the domain payload', () => {
      const input = UIMessageCodec.createToolResult('asst-A1', { toolCallId: 'tc-1', output: { temp: 22 } });
      expect(input).toEqual({
        kind: 'tool-result',
        codecMessageId: 'asst-A1',
        payload: { toolCallId: 'tc-1', output: { temp: 22 } },
      });
    });
  });

  describe('createToolResultError', () => {
    it('builds a tool-result-error input carrying codecMessageId and the domain payload', () => {
      const input = UIMessageCodec.createToolResultError('asst-A1', { toolCallId: 'tc-1', message: 'boom' });
      expect(input).toEqual({
        kind: 'tool-result-error',
        codecMessageId: 'asst-A1',
        payload: { toolCallId: 'tc-1', message: 'boom' },
      });
    });
  });

  describe('createToolApprovalResponse', () => {
    it('builds a tool-approval-response input carrying codecMessageId and the domain payload', () => {
      const input = UIMessageCodec.createToolApprovalResponse('asst-A1', {
        toolCallId: 'tc-1',
        approved: false,
        reason: 'no',
      });
      expect(input).toEqual({
        kind: 'tool-approval-response',
        codecMessageId: 'asst-A1',
        payload: { toolCallId: 'tc-1', approved: false, reason: 'no' },
      });
    });
  });
});
