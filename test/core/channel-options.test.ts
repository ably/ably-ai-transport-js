/**
 * Unit tests for the channel-mode constants.
 *
 * A transport is handed a channel the caller already resolved, so these
 * constants are the whole contract: `AIT_BASE_MODES` must stay byte-for-byte
 * the server's default mode set, because a caller adding `OBJECT_MODES` relies
 * on the union granting everything the default would have. Setting `modes` on
 * an ATTACH replaces the server default rather than adding to it, so a drift
 * here silently revokes access the caller never asked to lose.
 */

import { describe, expect, it } from 'vitest';

import { AIT_BASE_MODES, OBJECT_MODES } from '../../src/core/channel-options.js';

describe('AIT_BASE_MODES', () => {
  it('is exactly the server default mode set', () => {
    expect(AIT_BASE_MODES).toEqual(['PUBLISH', 'SUBSCRIBE', 'PRESENCE', 'PRESENCE_SUBSCRIBE', 'ANNOTATION_PUBLISH']);
  });
});

describe('OBJECT_MODES', () => {
  it('is the pair of modes LiveObjects needs', () => {
    expect(OBJECT_MODES).toEqual(['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']);
  });

  it('adds to the base set without overlapping it', () => {
    // An overlap would make the union order- and duplicate-sensitive against
    // ably-js's own mode comparison, which is what causes reattach churn.
    const union = [...AIT_BASE_MODES, ...OBJECT_MODES];
    expect(new Set(union).size).toBe(union.length);
  });
});
