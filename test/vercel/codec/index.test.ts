import { describe, expect, it } from 'vitest';

import { UIMessageCodec } from '../../../src/vercel/codec/index.js';

describe('UIMessageCodec', () => {
  it('identifies terminal events', () => {
    expect(UIMessageCodec.isTerminal({ type: 'finish', finishReason: 'stop' })).toBe(true);
    expect(UIMessageCodec.isTerminal({ type: 'error', errorText: 'err' })).toBe(true);
    expect(UIMessageCodec.isTerminal({ type: 'abort', reason: 'cancelled' })).toBe(true);
    expect(UIMessageCodec.isTerminal({ type: 'start' })).toBe(false);
    expect(UIMessageCodec.isTerminal({ type: 'text-delta', id: 'x', delta: 'hi' })).toBe(false);
  });
});
