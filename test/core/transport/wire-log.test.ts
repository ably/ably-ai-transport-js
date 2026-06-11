/**
 * recordWire unit tests.
 *
 * The per-node event log keeps one entry per wire-message serial, ascending by
 * serial, with each entry collecting that serial's decoded events in arrival
 * order. recordWire maintains that invariant under tail appends, same-serial
 * extensions, and out-of-order (lower-serial) arrivals.
 */

import { describe, expect, it } from 'vitest';

import { recordWire, type WireLogEntry } from '../../../src/core/transport/wire-log.js';

interface TestEvent {
  tag: string;
}

const ev = (tag: string): TestEvent => ({ tag });

const serialsOf = (log: WireLogEntry<TestEvent>[]): string[] => log.map((e) => e.serial);

describe('recordWire', () => {
  it('records into an empty log', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's1', 'm1', [ev('a')]);
    expect(log).toEqual([{ serial: 's1', messageId: 'm1', events: [{ tag: 'a' }] }]);
  });

  it('appends a new entry at the tail for a higher serial', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's1', 'm1', [ev('a')]);
    recordWire(log, 's2', 'm2', [ev('b')]);
    expect(log).toEqual([
      { serial: 's1', messageId: 'm1', events: [{ tag: 'a' }] },
      { serial: 's2', messageId: 'm2', events: [{ tag: 'b' }] },
    ]);
  });

  it('extends an existing entry with same-serial events in arrival order', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's1', 'm1', [ev('create')]);
    recordWire(log, 's1', 'm1', [ev('append1'), ev('append2')]);
    recordWire(log, 's1', 'm1', [ev('append3')]);
    expect(log).toHaveLength(1);
    expect(log[0]?.events).toEqual([{ tag: 'create' }, { tag: 'append1' }, { tag: 'append2' }, { tag: 'append3' }]);
  });

  it('extends a non-tail entry without disturbing the order', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's1', 'm1', [ev('a')]);
    recordWire(log, 's3', 'm3', [ev('c')]);
    recordWire(log, 's1', 'm1', [ev('a2')]);
    expect(serialsOf(log)).toEqual(['s1', 's3']);
    expect(log[0]?.events).toEqual([{ tag: 'a' }, { tag: 'a2' }]);
  });

  it('inserts a lower-serial record in ascending position', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's2', 'm2', [ev('b')]);
    recordWire(log, 's4', 'm4', [ev('d')]);
    recordWire(log, 's3', 'm3', [ev('c')]);
    expect(serialsOf(log)).toEqual(['s2', 's3', 's4']);
  });

  it('inserts a serial lower than every logged serial at the head', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's2', 'm2', [ev('b')]);
    recordWire(log, 's3', 'm3', [ev('c')]);
    recordWire(log, 's1', 'm1', [ev('a')]);
    expect(serialsOf(log)).toEqual(['s1', 's2', 's3']);
  });

  it('keeps interleaved serials fully sorted with arrival order inside entries', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    const arrivals: [string, TestEvent][] = [
      ['s3', ev('c1')],
      ['s1', ev('a1')],
      ['s5', ev('e1')],
      ['s3', ev('c2')],
      ['s2', ev('b1')],
      ['s4', ev('d1')],
      ['s1', ev('a2')],
    ];
    for (const [serial, event] of arrivals) recordWire(log, serial, undefined, [event]);

    expect(serialsOf(log)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(log[0]?.events).toEqual([{ tag: 'a1' }, { tag: 'a2' }]);
    expect(log[2]?.events).toEqual([{ tag: 'c1' }, { tag: 'c2' }]);
  });

  it('stores the messageId on the entry, including undefined', () => {
    const log: WireLogEntry<TestEvent>[] = [];
    recordWire(log, 's1', 'msg-1', [ev('a')]);
    recordWire(log, 's2', undefined, [ev('b')]);
    expect(log[0]?.messageId).toBe('msg-1');
    expect(log[1]?.messageId).toBeUndefined();
  });
});
