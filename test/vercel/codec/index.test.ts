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

  describe('classifyEvent', () => {
    it('classifies UserMessageEvent as user-message and extracts the message', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-user-message',
        message: { id: 'm1', role: 'user', parts: [] },
      });
      expect(result.kind).toBe('user-message');
      if (result.kind !== 'user-message') return;
      expect(result.message).toEqual({ id: 'm1', role: 'user', parts: [] });
    });

    it('classifies ToolApprovalEvent as amend and extracts the targetMsgId', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-tool-approval',
        toolCallId: 'tc-1',
        approved: true,
        targetMsgId: 'msg-target',
      });
      expect(result).toEqual({ kind: 'amend', targetMsgId: 'msg-target' });
    });

    it('classifies ClientToolOutputEvent as amend and extracts the targetMsgId', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-client-tool-output',
        toolCallId: 'tc-1',
        output: { ok: true },
        targetMsgId: 'msg-target',
      });
      expect(result).toEqual({ kind: 'amend', targetMsgId: 'msg-target' });
    });

    it('classifies ClientToolOutputErrorEvent as amend and extracts the targetMsgId', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-client-tool-output-error',
        toolCallId: 'tc-1',
        errorText: 'boom',
        targetMsgId: 'msg-target',
      });
      expect(result).toEqual({ kind: 'amend', targetMsgId: 'msg-target' });
    });

    it('classifies UIMessageChunk variants (e.g. text-delta) as other', () => {
      const result = UIMessageCodec.classifyEvent({ type: 'text-delta', id: 't', delta: 'hi' });
      expect(result).toEqual({ kind: 'other' });
    });
  });
});
