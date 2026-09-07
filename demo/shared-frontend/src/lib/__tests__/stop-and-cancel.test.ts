import { describe, expect, it, vi } from 'vitest';
import type { ChatTransport } from '@ably/ai-transport/vercel';

import { stopAndCancel } from '../stop-and-cancel';

describe('stopAndCancel', () => {
  it('publishes the channel cancel before stopping the local stream', async () => {
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push('stop');
    });
    // CAST: the helper touches only cancel().
    const chatTransport = {
      cancel: vi.fn(async () => {
        order.push('cancel');
      }),
    } as unknown as ChatTransport;

    await stopAndCancel(stop, chatTransport);

    // Cancel first: tearing down the stream is what clears the adapter's
    // record of which run it is on, and cancel() reads that record.
    expect(order).toEqual(['cancel', 'stop']);
  });

  it('still stops when no adapter has been built yet', async () => {
    const stop = vi.fn(async () => {});
    await stopAndCancel(stop, undefined);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
