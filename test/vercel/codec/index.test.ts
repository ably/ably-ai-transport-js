import { describe, expect, it } from 'vitest';

import { UIMessageCodec } from '../../../src/vercel/codec/index.js';

describe('UIMessageCodec', () => {
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
});
