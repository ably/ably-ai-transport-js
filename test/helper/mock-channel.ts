/** A mock of the channel operations the agent adaptor writes through. */

import type * as Ably from '@ably/pubsub-core';
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
  /**
   * Reads a message back as the channel would hold it: the publish that opened
   * `serial-<n>` with the data of every append to it joined on, under the last
   * write's name and extras. Updates are not replayed.
   */
  getMessage: Mock<(serial: string) => Promise<Ably.Message>>;
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
    getMessage: vi.fn(async (serial: string): Promise<Ably.Message> => {
      const opened = mock.publishCalls[Number(serial.replace('serial-', '')) - 1];
      if (opened === undefined) throw new Error(`no message ${serial}`);
      const appends = mock.appendCalls.filter((m) => m.serial === serial);
      const last = appends.at(-1) ?? opened;
      const data = [opened, ...appends].map((m) => (typeof m.data === 'string' ? m.data : '')).join('');
      // CAST: Ably types extras as any; the mock hands back what the writer stamped.
      const extras = last.extras as unknown;
      return { serial, name: last.name, extras, data };
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
