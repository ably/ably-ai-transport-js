import { describe, expect, it } from 'vitest';

import { shortId } from '../short-id';

describe('shortId', () => {
  it('keeps the entropy-bearing tail, not the shared prefix', () => {
    // A run derived from a workflow and a step minted in the same turn share
    // their prefix; the tails are what tell them apart.
    expect(shortId('run:wrun_01KWVGB5BTQHDV7H9RRQRRESGZ')).toBe('…RRESGZ');
    expect(shortId('step_01KWVGB5C2WMZBV2GVR48YA4TM')).toBe('…8YA4TM');
  });

  it('keeps a workflow and its derived run visually correlated (same tail)', () => {
    expect(shortId('wrun_01KWVGB5BTQHDV7H9RRQRRESGZ')).toBe(shortId('run:wrun_01KWVGB5BTQHDV7H9RRQRRESGZ'));
  });

  it('returns a short id unchanged, and honours a custom tail length', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('0123456789', 4)).toBe('…6789');
  });
});
