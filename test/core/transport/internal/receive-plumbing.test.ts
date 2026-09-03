/**
 * createReceivePlumbing unit tests.
 *
 * The factory exists to hold two invariants both transports depend on: the
 * history pager reads through the same decoder as the live merge, and the
 * pager's decode failures surface on the receive stream's `error`. Neither
 * transport suite asserts them, because both are properties of how the parts
 * are wired rather than of either transport's own behaviour.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { Decoder, Encoder, WireCodec } from '../../../../src/core/codec/types.js';
import { createReceivePlumbing } from '../../../../src/core/transport/internal/receive-plumbing.js';
import { ErrorCode } from '../../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../../src/logger.js';
import { createMockChannel } from '../../../helper/mock-channel.js';
import { createMockEncoder } from '../../../helper/mock-encoder.js';
import { boomMsg, outputMsg } from '../../../helper/wire-messages.js';

interface TestInput {
  kind: string;
}
interface TestOutput {
  type: string;
  text?: string;
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/**
 * A codec double counting the decoders it hands out, so a test can prove the
 * pager was given the live merge's decoder rather than a second one.
 * @returns The codec, plus the count of decoders created.
 */
const countingCodec = (): { codec: WireCodec<TestInput, TestOutput>; decoderCount: () => number } => {
  let created = 0;
  return {
    decoderCount: () => created,
    codec: {
      createEncoder: (): Encoder<TestInput, TestOutput> => createMockEncoder<TestInput, TestOutput>(),
      createDecoder: (): Decoder<TestInput, TestOutput> => {
        created++;
        return {
          decode: (msg: Ably.InboundMessage): { inputs: TestInput[]; outputs: TestOutput[] } => {
            if (msg.name === 'boom') throw new Error('malformed payload');
            // CAST: the test wires carry string data.
            return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
          },
        };
      },
    },
  };
};

describe('createReceivePlumbing', () => {
  it('creates one decoder and hands the same one to the live receiver and the pager', async () => {
    const { codec, decoderCount } = countingCodec();
    const channel = createMockChannel([[outputMsg('m1', 'from history')]]);

    const receive = createReceivePlumbing<TestInput, TestOutput>({
      channel,
      codec,
      pageSize: 10,
      logger: silentLogger,
    });

    expect(decoderCount()).toBe(1);

    // Both paths decode: the pager's page and a live delivery, with no second
    // decoder minted for either.
    const page = await receive.historyPager.next();
    expect(page.events).toHaveLength(1);
    expect(receive.receiver.deliverEvent(outputMsg('m2', 'live')).outcome).toBe('classified');
    expect(decoderCount()).toBe(1);
  });

  it('routes a history decode failure onto the receive stream error', async () => {
    const { codec } = countingCodec();
    const channel = createMockChannel([[boomMsg('h1')]]);
    const receive = createReceivePlumbing<TestInput, TestOutput>({
      channel,
      codec,
      pageSize: 10,
      logger: silentLogger,
    });
    const errors: Ably.ErrorInfo[] = [];
    receive.on('error', (err) => errors.push(err));

    const page = await receive.historyPager.next();

    // The bad wire is dropped from the batch, and the reason reaches the same
    // stream a live decode failure would.
    expect(page.events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
  });
});
