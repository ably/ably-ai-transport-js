import { describe, expect, it } from 'vitest';

import type { Replay } from '../../../src/core/transport/replay.js';
import { untilEvent } from '../../../src/core/transport/until-event.js';
import { ErrorCode } from '../../../src/errors.js';
import { deliveryAt, eventsOf, pagesOf } from '../../helper/history-pages.js';

/**
 * Run a replay function and narrow its return to the shape the builders use.
 * @param returned - What the function resolved with.
 * @returns The replay.
 */
const asReplay = (returned: Awaited<ReturnType<ReturnType<typeof untilEvent<string>>>>): Replay<string> => {
  if (Array.isArray(returned)) throw new Error('builders return a Replay');
  return returned;
};

const isMark = (serial: string) => (d: { event: string | undefined }) => d.event === serial;

describe('untilEvent', () => {
  it('returns the newest match and the deliveries after it, and stops on the page that holds it', async () => {
    const reads = { pages: 0 };
    const first = pagesOf(
      [
        [deliveryAt('s5'), deliveryAt('s6')],
        [deliveryAt('s3'), deliveryAt('s4')],
        [deliveryAt('s1'), deliveryAt('s2')],
      ],
      reads,
    );
    const replay = asReplay(await untilEvent<string>(isMark('s4'))(first));
    expect(eventsOf(replay)).toEqual(['s4', 's5', 's6']);
    expect(replay.found).toBe(true);
    expect(reads.pages).toBe(2);
  });

  it('picks the newest of several matches on one page', async () => {
    const first = pagesOf([[deliveryAt('m'), deliveryAt('s2'), deliveryAt('m'), deliveryAt('s4')]]);
    const replay = asReplay(await untilEvent<string>(isMark('m'))(first));
    expect(eventsOf(replay)).toEqual(['m', 's4']);
  });

  it('leaves the match itself out when inclusive is false', async () => {
    const first = pagesOf([[deliveryAt('s1'), deliveryAt('s2'), deliveryAt('s3')]]);
    const replay = asReplay(await untilEvent<string>(isMark('s2'), { inclusive: false })(first));
    expect(eventsOf(replay)).toEqual(['s3']);
    expect(replay.found).toBe(true);
  });

  it('returns everything with found false when nothing matches', async () => {
    const first = pagesOf([[deliveryAt('s2')], [deliveryAt('s1')]]);
    const replay = asReplay(await untilEvent<string>(isMark('none'))(first));
    expect(eventsOf(replay)).toEqual(['s1', 's2']);
    expect(replay.found).toBe(false);
  });

  it('throws SessionHistoryFetchFailed when nothing matches and onExhausted is error', async () => {
    const first = pagesOf([[deliveryAt('s1')]]);
    await expect(untilEvent<string>(isMark('none'), { onExhausted: 'error' })(first)).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionHistoryFetchFailed,
    );
  });

  it('stops at maxPages with what it has and found false', async () => {
    const reads = { pages: 0 };
    const first = pagesOf([[deliveryAt('s3')], [deliveryAt('s2')], [deliveryAt('s1')]], reads);
    const replay = asReplay(await untilEvent<string>(isMark('s1'), { maxPages: 2 })(first));
    expect(eventsOf(replay)).toEqual(['s2', 's3']);
    expect(replay.found).toBe(false);
    expect(reads.pages).toBe(2);
  });

  it('throws InvalidArgument for a page cap below one', () => {
    expect(() => untilEvent(isMark('s1'), { maxPages: 0 })).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});
