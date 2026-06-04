import { describe, expect, it } from 'vitest';

import { UIMessageCodec } from '../../../src/vercel/codec/index.js';

describe('UIMessageCodec', () => {
  it('carries adapterTag: "vercel" for Ably-Agent header registration', () => {
    // CAST: adapterTag is internal (not on the public Codec interface); verify the runtime value directly.
    expect((UIMessageCodec as unknown as { adapterTag: string }).adapterTag).toBe('vercel-ai-sdk-ui-message');
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

  describe('createEdit', () => {
    it('builds an edit input carrying target, parent, and the replacement message', () => {
      const message = { id: 'm2', role: 'user' as const, parts: [{ type: 'text' as const, text: 'edited' }] };
      const input = UIMessageCodec.createEdit('user-U1', 'asst-A0', message);
      expect(input).toEqual({ kind: 'edit', target: 'user-U1', parent: 'asst-A0', message });
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
