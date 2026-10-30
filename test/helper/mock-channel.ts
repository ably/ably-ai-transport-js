/** A mock of the channel operations the agent adaptor writes through. */

import type * as Ably from 'ably';
import { type Mock, vi } from 'vitest';

import type { ChannelWriter } from '../../src/core/adaptor/index.js';

/** The mock channel a test drives and asserts on. It satisfies {@link ChannelWriter}. */
export interface MockChannel extends ChannelWriter {
  /** Records the message and resolves with a deterministic per-publish serial (`serial-<n>`). */
  publish: Mock<(message: Ably.Message) => Promise<Ably.PublishResult>>;
  /** Records the append into {@link MockChannel.appendCalls} and resolves. */
  appendMessage: Mock<(message: Ably.Message) => Promise<Ably.UpdateDeleteResult>>;
  /** Records the update into {@link MockChannel.updateCalls} and resolves. */
  updateMessage: Mock<(message: Ably.Message) => Promise<Ably.UpdateDeleteResult>>;
  /** Every message `publish` received, in order. */
  publishCalls: Ably.Message[];
  /** Every message `appendMessage` received, in order. */
  appendCalls: Ably.Message[];
  /** Every message `updateMessage` received, in order. */
  updateCalls: Ably.Message[];
}

/**
 * Build a mock channel that records every publish, append and update.
 * @returns The mock.
 */
export const createMockChannel = (): MockChannel => {
  const mock: MockChannel = {
    publishCalls: [],
    appendCalls: [],
    updateCalls: [],
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    publish: vi.fn(async (msg: Ably.Message): Promise<Ably.PublishResult> => {
      mock.publishCalls.push(msg);
      return { serials: [`serial-${String(mock.publishCalls.length)}`] };
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    appendMessage: vi.fn(async (msg: Ably.Message): Promise<Ably.UpdateDeleteResult> => {
      mock.appendCalls.push(msg);
      // CAST: the writer reads nothing off the result.
      return {} as Ably.UpdateDeleteResult;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns a resolved promise
    updateMessage: vi.fn(async (msg: Ably.Message): Promise<Ably.UpdateDeleteResult> => {
      mock.updateCalls.push(msg);
      // CAST: the writer reads nothing off the result.
      return {} as Ably.UpdateDeleteResult;
    }),
  };
  return mock;
};
