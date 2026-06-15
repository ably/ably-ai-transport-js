/**
 * WireLog unit tests.
 *
 * The per-node event log keeps one entry per wire-message serial, ascending by
 * serial, with each entry collecting that serial's decoded events in arrival
 * order. `record()` reports how to fold (incremental tail extension, refold on
 * a late earlier-serial arrival, or dropped by the version guard); `replay()`
 * yields the recorded events in canonical order; `sweep()` drops the payloads
 * while keeping each entry's replay key.
 */

import { describe, expect, it } from 'vitest';

import { WireLog } from '../../../src/core/transport/wire-log.js';

interface TestEvent {
  tag: string;
}

const ev = (tag: string): TestEvent => ({ tag });

// Replay the log into a flat event list, in canonical order.
const events = (log: WireLog<TestEvent>): TestEvent[] => {
  const out: TestEvent[] = [];
  log.replay((event) => out.push(event));
  return out;
};

// Replay the log into the serial of each event, in canonical order.
const serials = (log: WireLog<TestEvent>): string[] => {
  const out: string[] = [];
  log.replay((_event, serial) => out.push(serial));
  return out;
};

// record with streamed default — ordering tests use increasing versions per serial.
const rec = (
  log: WireLog<TestEvent>,
  serial: string,
  messageId: string | undefined,
  evts: TestEvent[],
  version?: string,
  streamed = true,
): ReturnType<WireLog<TestEvent>['record']> => log.record(serial, messageId, evts, version, streamed);

describe('WireLog', () => {
  it('records into an empty log, folding incrementally', () => {
    const log = new WireLog<TestEvent>();
    expect(rec(log, 's1', 'm1', [ev('a')], 's1@1')).toBe('incremental');
    expect(events(log)).toEqual([{ tag: 'a' }]);
  });

  it('folds incrementally for in-order tails and refolds for late earlier-serial arrivals', () => {
    const log = new WireLog<TestEvent>();
    // In-order: each lands at the tail.
    expect(rec(log, 's1', 'm1', [ev('a')], 's1@1')).toBe('incremental');
    expect(rec(log, 's3', 'm3', [ev('c')], 's3@1')).toBe('incremental');
    // Same-serial tail extend (a later version of the same wire).
    expect(rec(log, 's3', 'm3', [ev('c2')], 's3@2')).toBe('incremental');
    // Late, earlier-serial arrivals force a refold.
    expect(rec(log, 's2', 'm2', [ev('b')], 's2@1')).toBe('refold'); // between s1 and s3
    expect(rec(log, 's0', 'm0', [ev('z')], 's0@1')).toBe('refold'); // head insert
    expect(rec(log, 's1', 'm1', [ev('a2')], 's1@2')).toBe('refold'); // non-tail extend
  });

  it('orders events by serial across wires, arrival order within a wire', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    expect(serials(log)).toEqual(['s1', 's2']);
    expect(events(log)).toEqual([{ tag: 'a' }, { tag: 'b' }]);
  });

  it('extends an existing entry in arrival order, advancing the version high-water-mark', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('create')], 's1@1');
    rec(log, 's1', 'm1', [ev('append1'), ev('append2')], 's1@2');
    rec(log, 's1', 'm1', [ev('append3')], 's1@3');
    expect(events(log)).toEqual([{ tag: 'create' }, { tag: 'append1' }, { tag: 'append2' }, { tag: 'append3' }]);
    // The high-water-mark advanced to s1@3: a replay at s1@2 is now dropped.
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@2')).toBe('dropped');
  });

  it('extends a non-tail entry without disturbing the order', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    rec(log, 's1', 'm1', [ev('a2')], 's1@2');
    expect(serials(log)).toEqual(['s1', 's1', 's3']);
    expect(events(log)).toEqual([{ tag: 'a' }, { tag: 'a2' }, { tag: 'c' }]);
  });

  it('inserts a lower-serial wire in ascending position', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    rec(log, 's4', 'm4', [ev('d')], 's4@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    expect(serials(log)).toEqual(['s2', 's3', 's4']);
  });

  it('inserts a serial lower than every logged serial at the head', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    rec(log, 's3', 'm3', [ev('c')], 's3@1');
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    expect(serials(log)).toEqual(['s1', 's2', 's3']);
  });

  it('keeps interleaved serials fully sorted with arrival order inside entries', () => {
    const log = new WireLog<TestEvent>();
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

    expect(serials(log)).toEqual(['s1', 's1', 's2', 's3', 's3', 's4', 's5']);
    expect(events(log)).toEqual([
      { tag: 'a1' },
      { tag: 'a2' },
      { tag: 'b1' },
      { tag: 'c1' },
      { tag: 'c2' },
      { tag: 'd1' },
      { tag: 'e1' },
    ]);
  });

  it('replays each event with its wire codec-message-id, including undefined', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'msg-1', [ev('a')], 's1@1');
    rec(log, 's2', undefined, [ev('b')], 's2@1');
    const ids: (string | undefined)[] = [];
    log.replay((_event, _serial, messageId) => ids.push(messageId));
    expect(ids).toEqual(['msg-1', undefined]);
  });

  // -- version guard ---------------------------------------------------------

  it('drops a delivery at or below the entry high-water-mark as a replay', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('create')], 's1@1');
    rec(log, 's1', 'm1', [ev('append')], 's1@2');

    // Whole-wire replay (second hydration / agent re-walk): both the original
    // version and an intermediate one are already incorporated.
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@2')).toBe('dropped');
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@1')).toBe('dropped');
    expect(events(log)).toEqual([{ tag: 'create' }, { tag: 'append' }]);
  });

  it('drops a newer version of a non-streamed wire as an edited discrete', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('original')], 's1@1', false);

    expect(rec(log, 's1', 'm1', [ev('edited')], 's1@2', false)).toBe('dropped');
    expect(events(log)).toEqual([{ tag: 'original' }]);
  });

  it('records a version-less delivery unguarded without advancing the high-water-mark', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('a')], 's1@2');

    // No explicit version: the guard is disabled for this delivery (matching
    // the decoder's convention) and the high-water-mark is untouched.
    expect(rec(log, 's1', 'm1', [ev('b')])).toBe('incremental');
    expect(events(log)).toEqual([{ tag: 'a' }, { tag: 'b' }]);
  });

  it('uses the serial as the high-water-mark floor for a version-less new entry', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('a')]);
    // A never-mutated message's version serial equals its serial — the floor.
    // A same-serial delivery at that version is therefore a replay.
    expect(rec(log, 's1', 'm1', [ev('b')], 's1')).toBe('dropped');
  });

  // -- sweep -----------------------------------------------------------------

  it('drops payloads on sweep but keeps replay keys', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's1', 'm1', [ev('a')], 's1@1');
    rec(log, 's2', 'm2', [ev('b')], 's2@1');

    expect(log.swept).toBe(false);
    log.sweep();
    expect(log.swept).toBe(true);

    // Payloads are gone (a refold can no longer rebuild them).
    expect(events(log)).toEqual([]);
    // But the replay keys remain: a whole-wire replay is still dropped.
    expect(rec(log, 's1', 'm1', [ev('replayed')], 's1@1')).toBe('dropped');
    expect(rec(log, 's2', 'm2', [ev('replayed')], 's2@1')).toBe('dropped');
  });

  it('folds a genuinely-new wire incrementally on a swept log, never refolding', () => {
    const log = new WireLog<TestEvent>();
    rec(log, 's2', 'm2', [ev('b')], 's2@1');
    log.sweep();

    // A lower-serial wire would normally refold; on a swept log it folds
    // incrementally (arrival order) since the payloads are gone.
    expect(rec(log, 's1', 'm1', [ev('a')], 's1@1')).toBe('incremental');
    // Its replay key is retained, so re-delivering it is dropped.
    expect(rec(log, 's1', 'm1', [ev('a')], 's1@1')).toBe('dropped');
    // Payloads still not retained on a swept log.
    expect(events(log)).toEqual([]);
  });
});
