/**
 * AIT-742 Phase 0 spike — offline wire bridge.
 *
 * A `ChannelWriter` mock that records the encoder's publish/append/update
 * operations and reconstructs the `Ably.InboundMessage` sequence a subscriber
 * on the same channel would receive, so an encode -> decode -> fold round-trip
 * runs with no network (mirrors what the Vercel codec proves over real Ably in
 * `codec.integration.test.ts`).
 *
 * Faithful enough for the spike: streamed `message.create` keeps its minted
 * serial; appends/updates reuse the create's serial with a strictly-increasing
 * `version.serial` (the `v…` prefix sorts after any `serial-N` create version,
 * so the decoder's version guard never drops a real delta).
 */

import type * as Ably from 'ably';

import { HEADER_CODEC_MESSAGE_ID, HEADER_RUN_ID } from '../../src/constants.js';
import type { ChannelWriter } from '../../src/core/codec/index.js';

interface Recorded {
  action: 'message.create' | 'message.append' | 'message.update';
  serial: string;
  versionSerial: string;
  name?: string;
  data: unknown;
  extras: unknown;
}

export interface MockWriter extends ChannelWriter {
  inbound(): Ably.InboundMessage[];
}

export const createMockWriter = (): MockWriter => {
  const recorded: Recorded[] = [];
  let serialCounter = 0;
  let versionCounter = 0;
  const nextVersion = (): string => `v${String((versionCounter += 1)).padStart(7, '0')}`;

  const writer: MockWriter = {
    publish: (message) => {
      const msg = Array.isArray(message) ? message[0] : message;
      const serial = `serial-${(serialCounter += 1)}`;
      recorded.push({
        action: 'message.create',
        serial,
        versionSerial: serial,
        name: msg?.name,
        data: msg?.data,
        extras: msg?.extras,
      });
      return Promise.resolve({ serials: [serial] });
    },
    appendMessage: (message) => {
      recorded.push({
        action: 'message.append',
        serial: message.serial ?? '',
        versionSerial: nextVersion(),
        name: message.name,
        data: message.data,
        extras: message.extras,
      });
      return Promise.resolve({} as Ably.UpdateDeleteResult);
    },
    updateMessage: (message) => {
      recorded.push({
        action: 'message.update',
        serial: message.serial ?? '',
        versionSerial: nextVersion(),
        name: message.name,
        data: message.data,
        extras: message.extras,
      });
      return Promise.resolve({} as Ably.UpdateDeleteResult);
    },
    inbound: () =>
      recorded.map(
        (r) =>
          ({
            action: r.action,
            serial: r.serial,
            version: { serial: r.versionSerial },
            name: r.name ?? '',
            data: r.data,
            extras: r.extras,
          }) as unknown as Ably.InboundMessage,
      ),
  };
  return writer;
};

/** An onMessage hook that stamps run-id + codec-message-id on every message. */
export const stampHeaders =
  (runId: string, messageId: string) =>
  (msg: Ably.Message): void => {
    const transport = (msg.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
    if (transport) {
      transport[HEADER_RUN_ID] = runId;
      transport[HEADER_CODEC_MESSAGE_ID] = messageId;
    }
  };
