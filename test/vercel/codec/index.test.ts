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
    it('classifies UserMessageEvent as user-message', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-user-message',
        message: { id: 'm1', role: 'user', parts: [] },
      });
      expect(result).toEqual({ kind: 'user-message' });
    });

    it('classifies tool-output-available as user-message', () => {
      // Continuation tool resolutions ride as `role: 'user'` channel
      // messages on the wire; the reducer redirects the fold onto the
      // prior assistant by toolCallId. The codec does not synthesise a
      // TMessage — the session folds the event itself.
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-output-available',
        toolCallId: 'tc-1',
        output: { ok: true },
      });
      expect(result).toEqual({ kind: 'user-message' });
    });

    it('classifies tool-output-error as user-message', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-output-error',
        toolCallId: 'tc-1',
        errorText: 'boom',
      });
      expect(result).toEqual({ kind: 'user-message' });
    });

    it('classifies tool-approval-response as user-message', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'tool-approval-response',
        toolCallId: 'tc-1',
        approved: true,
        reason: 'looks good',
      });
      expect(result).toEqual({ kind: 'user-message' });
    });

    it('classifies UIMessageChunk variants (e.g. text-delta) as other', () => {
      const result = UIMessageCodec.classifyEvent({ type: 'text-delta', id: 't', delta: 'hi' });
      expect(result).toEqual({ kind: 'other' });
    });

    it('classifies ait-regenerate as regenerate with parent + regenerates surfaced', () => {
      const result = UIMessageCodec.classifyEvent({
        type: 'ait-regenerate',
        regeneratesCodecMessageId: 'asst-A1',
        parentCodecMessageId: 'user-U1',
      });
      expect(result).toEqual({ kind: 'regenerate', parent: 'user-U1', regenerates: 'asst-A1' });
    });
  });

  describe('createRegenerateEvent', () => {
    it('builds an ait-regenerate event carrying the supplied ids', () => {
      const event = UIMessageCodec.createRegenerateEvent('asst-A1', 'user-U1');
      expect(event).toEqual({
        type: 'ait-regenerate',
        regeneratesCodecMessageId: 'asst-A1',
        parentCodecMessageId: 'user-U1',
      });
    });
  });
});
