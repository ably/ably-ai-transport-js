/**
 * Unit tests for the FIFO-bounded eviction helper, over both collections it
 * serves: a `Map` whose values the caller sets, and a `Set` of bare keys.
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

  it('evicts a Set the same way, so a bare key registry needs no value', () => {
    const set = new Set(['a', 'b']);

    expect(evictOldestIfFull(set, 'b', 2)).toBeUndefined();
    expect(evictOldestIfFull(set, 'c', 2)).toBe('a');
    set.add('c');

    expect([...set]).toEqual(['b', 'c']);
  });
});
