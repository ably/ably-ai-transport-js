/**
 * recordWire unit tests.
 *
 * The per-node event log keeps one entry per wire-message serial, ascending by
 * serial, with each entry collecting that serial's decoded events in arrival
 * order. recordWire maintains that invariant under tail appends, same-serial
 * extensions, and out-of-order (lower-serial) arrivals, and guards each entry
 * with a `decodedThrough` version high-water-mark: a version-bearing delivery
 * the entry has already incorporated is a replay, and a newer version of a
 * non-streamed wire is an edited discrete — both drop without recording.
 */

import { describe, expect, it } from 'vitest';

import { recordWire, type WireLogEntry } from '../../../src/core/transport/wire-log.js';

interface TestEvent {
  tag: string;
}

const ev = (tag: string): TestEvent => ({ tag });

const serialsOf = (log: WireLogEntry<TestEvent>[]): string[] => log.map((e) => e.serial);

// recordWire with streamed defaults — ordering tests use increasing versions per serial.
const rec = (
  log: WireLogEntry<TestEvent>[],
  serial: string,
  messageId: string | undefined,
  events: TestEvent[],
  version?: string,
  streamed = true,
): ReturnType<typeof recordWire<TestEvent>> => recordWire(log, serial, messageId, events, version, streamed);

describe('recordWire', () => {
  it('records into an empty log, stamping decodedThrough with the version', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    const index = rec(log, 's1', 'm1', [ev('a')], 's1@1');
    expect(log).toEqual([{ serial: 's1', messageId: 'm1', events: [{ tag: 'a' }], decodedThrough: 's1@1' }]);
    expect(index).toBe(0);
  });

  it('returns the touched index — tail for in-order, earlier for late arrivals', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    // In-order: each lands at (and is reported as) the tail.
    expect(rec(log, 's1', 'm1', [ev('a')], 's1@1')).toBe(0);
    expect(rec(log, 's3', 'm3', [ev('c')], 's3@1')).toBe(1);
    // Same-serial tail extend (a later version of the same wire).
    expect(rec(log, 's3', 'm3', [ev('c2')], 's3@2')).toBe(1);
    // Late, earlier-serial arrivals report a non-tail index (< log.length - 1).
    expect(rec(log, 's2', 'm2', [ev('b')], 's2@1')).toBe(1); // between s1 and s3
    expect(rec(log, 's0', 'm0', [ev('z')], 's0@1')).toBe(0); // head insert
    expect(rec(log, 's1', 'm1', [ev('a2')], 's1@2')).toBe(1); // non-tail extend
  });

  it('appends a new entry at the tail for a higher serial', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    expect(log).toEqual([
      { serial: 's1', messageId: 'm1', events: [{ tag: 'a' }], decodedThrough: 's1@1' },
      { serial: 's2', messageId: 'm2', events: [{ tag: 'b' }], decodedThrough: 's2@1' },
    ]);
  });

  it('extends an existing entry in arrival order, advancing decodedThrough', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('create')], 's1@1');
    rec(log, 's1', 'm1', [ev('append1'), ev('append2')], 's1@2');
    rec(log, 's1', 'm1', [ev('append3')], 's1@3');
    expect(log).toHaveLength(1);
    expect(log[0]?.events).toEqual([{ tag: 'create' }, { tag: 'append1' }, { tag: 'append2' }, { tag: 'append3' }]);
    expect(log[0]?.decodedThrough).toBe('s1@3');
  });

  it('extends a non-tail entry without disturbing the order', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    rec(log, 's1', 'm1', [ev('a2')], 's1@2');
    expect(serialsOf(log)).toEqual(['s1', 's3']);
    expect(log[0]?.events).toEqual([{ tag: 'a' }, { tag: 'a2' }]);
  });

  it('inserts a lower-serial record in ascending position', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    rec(log, 's4', 'm4', [ev('d')], 's4@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    expect(serialsOf(log)).toEqual(['s2', 's3', 's4']);
  });

  it('inserts a serial lower than every logged serial at the head', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    expect(serialsOf(log)).toEqual(['s1', 's2', 's3']);
  });

  it('keeps interleaved serials fully sorted with arrival order inside entries', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    const arrivals: [string, string, TestEvent][] = [
      ['s3', 's3@1', ev('c1')],
      ['s1', 's1@1', ev('a1')],
      ['s5', 's5@1', ev('e1')],
      ['s3', 's3@2', ev('c2')],
      ['s2', 's2@1', ev('b1')],
      ['s4', 's4@1', ev('d1')],
      ['s1', 's1@2', ev('a2')],
    ];
    for (const [serial, version, event] of arrivals) rec(log, serial, undefined, [event], version);

    expect(serialsOf(log)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(log[0]?.events).toEqual([{ tag: 'a1' }, { tag: 'a2' }]);
    expect(log[2]?.events).toEqual([{ tag: 'c1' }, { tag: 'c2' }]);
  });

  it('stores the messageId on the entry, including undefined', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'msg-1', [ev('a')], 's1@1');
    rec(log, 's2', undefined, [ev('b')], 's2@1');
    expect(log[0]?.messageId).toBe('msg-1');
    expect(log[1]?.messageId).toBeUndefined();
  });

  // -- decodedThrough version guard ------------------------------------------

  it('drops a delivery at or below the entry decodedThrough as a replay', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('create')], 's1@1');
    rec(log, 's1', 'm1', [ev('append')], 's1@2');

    // Whole-wire replay (second hydration / agent re-walk): both the original
    // version and an intermediate one are already incorporated, so the guard
    // drops them (undefined) without touching the entry.
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@2')).toBeUndefined();
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@1')).toBeUndefined();
    expect(log[0]?.events).toEqual([{ tag: 'create' }, { tag: 'append' }]);
    expect(log[0]?.decodedThrough).toBe('s1@2');
  });

  it('drops a newer version of a non-streamed wire as an edited discrete', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('original')], 's1@1', false);

    expect(rec(log, 's1', 'm1', [ev('edited')], 's1@2', false)).toBeUndefined();
    expect(log[0]?.events).toEqual([{ tag: 'original' }]);
    expect(log[0]?.decodedThrough).toBe('s1@1');
  });

  it('records a version-less delivery unguarded without advancing decodedThrough', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('a')], 's1@2');

    // No explicit version: the guard is disabled for this delivery (matching
    // the decoder's convention) and the high-water-mark is untouched.
    expect(rec(log, 's1', 'm1', [ev('b')])).toBe(0);
    expect(log[0]?.events).toEqual([{ tag: 'a' }, { tag: 'b' }]);
    expect(log[0]?.decodedThrough).toBe('s1@2');
  });

  it('stamps a version-less new entry decodedThrough with the serial', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    rec(log, 's1', 'm1', [ev('a')]);
    // A never-mutated message's version serial equals its serial — the floor.
    expect(log[0]?.decodedThrough).toBe('s1');
  });
});
