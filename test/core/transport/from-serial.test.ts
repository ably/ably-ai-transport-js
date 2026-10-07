import { describe, expect, it } from 'vitest';

import { fromSerial } from '../../../src/core/transport/from-serial.js';
import type { Replay } from '../../../src/core/transport/replay.js';
import { ErrorCode } from '../../../src/errors.js';
import { deliveryAt, eventsOf, pagesOf } from '../../helper/history-pages.js';

/**
 * Run a replay function and narrow its return to the shape the builders use.
 * @param returned - What the function resolved with.
 * @returns The replay.
 */
const asReplay = (returned: Awaited<ReturnType<ReturnType<typeof fromSerial<string>>>>): Replay<string> => {
  if (Array.isArray(returned)) throw new Error('builders return a Replay');
  return returned;
};

describe('fromSerial', () => {
  it('returns the messages after the serial, and stops on the page that holds it', async () => {
    const reads = { pages: 0 };
    const first = pagesOf(
      [
        [deliveryAt('s5'), deliveryAt('s6')],
        [deliveryAt('s3'), deliveryAt('s4')],
        [deliveryAt('s1'), deliveryAt('s2')],
      ],
      reads,
    );
    const replay = asReplay(await fromSerial<string>('s3')(first));
    expect(eventsOf(replay)).toEqual(['s4', 's5', 's6']);
    expect(replay.found).toBe(true);
    // The page before s3's was never read.
    expect(reads.pages).toBe(2);
  });

  it('returns the message at the serial as well when inclusive is true', async () => {
    const first = pagesOf([[deliveryAt('s1'), deliveryAt('s2'), deliveryAt('s3')]]);
    const replay = asReplay(await fromSerial<string>('s2', { inclusive: true })(first));
    expect(eventsOf(replay)).toEqual(['s2', 's3']);
    expect(replay.found).toBe(true);
  });

  it('compares on the creation serial and ignores the version', async () => {
    // s1 and s2 were created at or before the point and grew to versions s4
    // and s5 after it: neither is returned, s2 ends the walk on the first
    // page, and the message created after the point is returned.
    const reads = { pages: 0 };
    const first = pagesOf(
      [[deliveryAt('s1', 's4'), deliveryAt('s2', 's5'), deliveryAt('s3')], [deliveryAt('s0')]],
      reads,
    );
    const replay = asReplay(await fromSerial<string>('s2')(first));
    expect(eventsOf(replay)).toEqual(['s3']);
    expect(replay.found).toBe(true);
    expect(reads.pages).toBe(1);
  });

  it('treats a page with nothing at or before the serial as not yet reached, and reads on', async () => {
    const reads = { pages: 0 };
    const first = pagesOf([[deliveryAt('s4')], [deliveryAt('s3')], [deliveryAt('s1'), deliveryAt('s2')]], reads);
    const replay = asReplay(await fromSerial<string>('s2')(first));
    expect(eventsOf(replay)).toEqual(['s3', 's4']);
    expect(reads.pages).toBe(3);
  });

  it('returns everything with found false when history runs out before the serial', async () => {
    const first = pagesOf([[deliveryAt('s3')], [deliveryAt('s2')]]);
    const replay = asReplay(await fromSerial<string>('s1')(first));
    expect(eventsOf(replay)).toEqual(['s2', 's3']);
    expect(replay.found).toBe(false);
  });

  it('throws SessionHistoryFetchFailed when history runs out and onExhausted is error', async () => {
    const first = pagesOf([[deliveryAt('s2')]]);
    await expect(fromSerial<string>('s1', { onExhausted: 'error' })(first)).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionHistoryFetchFailed,
    );
  });

  it('stops at maxPages with what it has and found false', async () => {
    const reads = { pages: 0 };
    const first = pagesOf([[deliveryAt('s3')], [deliveryAt('s2')], [deliveryAt('s1')]], reads);
    const replay = asReplay(await fromSerial<string>('s1', { maxPages: 2 })(first));
    expect(eventsOf(replay)).toEqual(['s2', 's3']);
    expect(replay.found).toBe(false);
    expect(reads.pages).toBe(2);
  });

  it('returns nothing with found true when the serial is the newest message', async () => {
    const first = pagesOf([[deliveryAt('s1'), deliveryAt('s2')]]);
    const replay = asReplay(await fromSerial<string>('s2')(first));
    expect(eventsOf(replay)).toEqual([]);
    expect(replay.found).toBe(true);
  });

  it('throws InvalidArgument for an empty serial or a page cap below one', () => {
    expect(() => fromSerial('')).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    expect(() => fromSerial('s1', { maxPages: 0 })).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});
