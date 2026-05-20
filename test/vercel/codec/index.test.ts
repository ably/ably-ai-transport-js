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

    it('classifies tool-output-available as user-message with a synthetic role:user dynamic-tool message', () => {
      // Continuation tool resolutions ride as `role: 'user'` channel
      // messages whose payload encodes the tool output. The session's
      // optimistic-fold heuristic duck-types the resulting TMessage; the
      // reducer redirects the fold onto the prior assistant by toolCallId.
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { ok: true },
      });
      expect(result.kind).toBe('user-message');
      if (result.kind !== 'user-message') return;
      expect(result.message.role).toBe('user');
      expect(result.message.parts).toHaveLength(1);
      const part = result.message.parts[0];
      expect(part?.type).toBe('dynamic-tool');
      if (part?.type !== 'dynamic-tool') return;
      expect(part.toolCallId).toBe('tc-1');
      expect(part.state).toBe('output-available');
      if (part.state !== 'output-available') return;
      expect(part.output).toEqual({ ok: true });
    });

    it('classifies tool-output-error as user-message with a synthetic role:user dynamic-tool message', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-output-error',
        toolCallId: 'tc-1',
        errorText: 'boom',
      });
      expect(result.kind).toBe('user-message');
      if (result.kind !== 'user-message') return;
      expect(result.message.role).toBe('user');
      const part = result.message.parts[0];
      expect(part?.type).toBe('dynamic-tool');
      if (part?.type !== 'dynamic-tool') return;
      expect(part.toolCallId).toBe('tc-1');
      expect(part.state).toBe('output-error');
      if (part.state !== 'output-error') return;
      expect(part.errorText).toBe('boom');
    });

    it('classifies tool-approval-response as user-message with a synthetic dynamic-tool approval part', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-approval-response',
        toolCallId: 'tc-1',
        approved: true,
        reason: 'looks good',
      });
      expect(result.kind).toBe('user-message');
      if (result.kind !== 'user-message') return;
      expect(result.message.role).toBe('user');
      const part = result.message.parts[0];
      expect(part?.type).toBe('dynamic-tool');
      if (part?.type !== 'dynamic-tool') return;
      expect(part.toolCallId).toBe('tc-1');
      expect(part.state).toBe('approval-responded');
      if (part.state !== 'approval-responded') return;
      expect(part.approval.approved).toBe(true);
      expect(part.approval.reason).toBe('looks good');
    });

    it('classifies tool-approval-response with approved=false as user-message with output-denied state', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-approval-response',
        toolCallId: 'tc-1',
        approved: false,
        reason: 'nope',
      });
      expect(result.kind).toBe('user-message');
      if (result.kind !== 'user-message') return;
      const part = result.message.parts[0];
      if (part?.type !== 'dynamic-tool') throw new Error('expected dynamic-tool');
      expect(part.state).toBe('output-denied');
    });

    it('classifies UIMessageChunk variants (e.g. text-delta) as other', () => {
      const result = UIMessageCodec.classifyEvent({ type: 'text-delta', id: 't', delta: 'hi' });
      expect(result).toEqual({ kind: 'other' });
    });

    it('classifies ait-regenerate as regenerate with parent + forkOf surfaced', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-regenerate',
        forkOfMsgId: 'asst-A1',
        parentMsgId: 'user-U1',
      });
      expect(result).toEqual({ kind: 'regenerate', parent: 'user-U1', forkOf: 'asst-A1' });
    });
  });

  describe('createRegenerateEvent', () => {
    it('builds an ait-regenerate event carrying the supplied ids', () => {
      const event = UIMessageCodec.createRegenerateEvent('asst-A1', 'user-U1');
      expect(event).toEqual({
        type: 'ait-regenerate',
        forkOfMsgId: 'asst-A1',
        parentMsgId: 'user-U1',
      });
    });
  });
});
