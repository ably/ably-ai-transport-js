import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { Delivery } from '../../../src/core/codec/index.js';
import { openHistoryWalk } from '../../../src/core/transport/history-pager.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockChannel } from '../../helper/mock-channel.js';

const wire = (serial: string): Ably.InboundMessage =>
  // CAST: a minimal stub with the fields the walk and the fixture decode read.
  ({
    action: 'message.create',
    serial,
    data: serial,
    extras: { ai: { type: 'note' } },
    version: {},
  }) as Ably.InboundMessage;

/**
 * A delivery fixture that decodes every message to its serial, the one named
 * `skip` to no event, and the one named `twin` to two events.
 * @param message - The history message.
 * @returns The deliveries.
 */
const toDeliveries = (message: Ably.InboundMessage): Delivery<string>[] => {
  if (message.serial === 'skip') return [{ event: undefined, message }];
  if (message.serial === 'twin')
    return [
      { event: 'twin-a', message },
      { event: 'twin-b', message },
    ];
  return [{ event: message.serial, message }];
};

const events = (page: { items: Delivery<string>[] }): (string | undefined)[] => page.items.map((d) => d.event);

describe('openHistoryWalk', () => {
  it('reads the newest page, oldest first within it, and leads to the older pages through next()', async () => {
    const channel = createMockChannel([
      [wire('s6'), wire('s5')],
      [wire('s4'), wire('s3')],
      [wire('s2'), wire('s1')],
    ]);

    const first = await openHistoryWalk({ channel, limit: 2, toDeliveries });
    expect(events(first)).toEqual(['s5', 's6']);
    expect(first.hasNext).toBe(true);

    const second = await first.next();
    expect(events(second)).toEqual(['s3', 's4']);
    expect(second.hasNext).toBe(true);

    const third = await second.next();
    expect(events(third)).toEqual(['s1', 's2']);
    expect(third.hasNext).toBe(false);
  });

  it('reads until the attach point with the given page size', async () => {
    const channel = createMockChannel([[wire('s1')]]);
    await openHistoryWalk({ channel, limit: 25, toDeliveries });
    expect(channel.history).toHaveBeenCalledWith({ limit: 25, untilAttach: true });
  });

  it('carries a message the codec has nothing for, with no event', async () => {
    const channel = createMockChannel([[wire('s2'), wire('skip'), wire('s1')]]);
    const page = await openHistoryWalk({ channel, limit: 3, toDeliveries });
    expect(events(page)).toEqual(['s1', undefined, 's2']);
  });

  it('lists one delivery per event when a message decodes to several', async () => {
    const channel = createMockChannel([[wire('s2'), wire('twin'), wire('s1')]]);
    const page = await openHistoryWalk({ channel, limit: 3, toDeliveries });
    expect(events(page)).toEqual(['s1', 'twin-a', 'twin-b', 's2']);
  });

  it('resolves an empty page with no next once past the end', async () => {
    const channel = createMockChannel([[wire('s1')]]);
    const first = await openHistoryWalk({ channel, limit: 1, toDeliveries });
    expect(first.hasNext).toBe(false);
    const past = await first.next();
    expect(past.items).toEqual([]);
    expect(past.hasNext).toBe(false);
  });

  it('opens a new walk at the channel’s attach point on each call', async () => {
    const channel = createMockChannel([[wire('s2')], [wire('s1')]]);
    const a = await openHistoryWalk({ channel, limit: 1, toDeliveries });
    const b = await openHistoryWalk({ channel, limit: 1, toDeliveries });
    expect(events(a)).toEqual(['s2']);
    expect(events(b)).toEqual(['s2']);
    expect(channel.history).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent next() calls on one page so pages come back in order', async () => {
    const channel = createMockChannel([[wire('s3')], [wire('s2')], [wire('s1')]]);
    const first = await openHistoryWalk({ channel, limit: 1, toDeliveries });
    const [a, b] = await Promise.all([first.next(), first.next()]);
    expect(events(a)).toEqual(['s2']);
    expect(events(b)).toEqual(['s1']);
  });

  it('rejects with SessionHistoryFetchFailed when the first page cannot be read', async () => {
    const channel = createMockChannel([[wire('s1')]]);
    channel.history.mockRejectedValue(new Error('history down'));
    await expect(openHistoryWalk({ channel, limit: 1, toDeliveries })).rejects.toBeErrorInfoWithCode(
      ErrorCode.SessionHistoryFetchFailed,
    );
    expect(vi.mocked(channel.history).mock.calls.length).toBeGreaterThan(1);
  }, 20_000);
});
