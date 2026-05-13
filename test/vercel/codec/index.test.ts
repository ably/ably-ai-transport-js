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
});
