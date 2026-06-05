/**
 * Unit tests for the FIFO-bounded-map eviction helper.
 */

import { describe, expect, it } from 'vitest';

import { evictOldestIfFull } from '../../../src/core/transport/internal/bounded-map.js';

describe('evictOldestIfFull', () => {
  it('evicts and returns the oldest key when at the limit and the key is new', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const evicted = evictOldestIfFull(map, 'c', 2);
    expect(evicted).toBe('a');
    expect([...map.keys()]).toEqual(['b']);
  });

  it('does not evict when the map is below the limit', () => {
    const map = new Map([['a', 1]]);
    const evicted = evictOldestIfFull(map, 'b', 2);
    expect(evicted).toBeUndefined();
    expect([...map.keys()]).toEqual(['a']);
  });

  it('does not evict when the key already exists, even at the limit', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const evicted = evictOldestIfFull(map, 'a', 2);
    expect(evicted).toBeUndefined();
    expect([...map.keys()]).toEqual(['a', 'b']);
  });

  it('returns undefined for an empty map', () => {
    const map = new Map<string, number>();
    expect(evictOldestIfFull(map, 'a', 0)).toBeUndefined();
  });

  it('evicts strictly the insertion-order oldest across repeated adds', () => {
    const map = new Map<string, number>();
    const limit = 2;
    for (const key of ['a', 'b', 'c', 'd']) {
      evictOldestIfFull(map, key, limit);
      map.set(key, 0);
    }
    // a and b evicted as c and d were added; newest two remain in order.
    expect([...map.keys()]).toEqual(['c', 'd']);
  });
});
