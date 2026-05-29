import { describe, expect, it } from 'vitest';

import { UIMessageCodec } from '../../../src/vercel/codec/index.js';

describe('UIMessageCodec', () => {
  it('identifies terminal events', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'finish', finishReason: 'stop' })).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'error', errorText: 'err' })).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'abort', reason: 'cancelled' })).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'start' })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'text-delta', id: 'x', delta: 'hi' })).toBe(false);
  });

  it('treats finish chunk with tool-calls finishReason as terminal (stream closes)', () => {
    // Stream-terminal so useChat's `sendAutomaticallyWhen` can fire on the
    // stream close. Run-level state (observer projection, tree run-tracking)
    // is preserved separately on `run-end suspended` so the continuation can
    // reuse the runId.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the bridge under test
    expect(UIMessageCodec.isTerminal({ type: 'finish', finishReason: 'tool-calls' })).toBe(true);
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
});
