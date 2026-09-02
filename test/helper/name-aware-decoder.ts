/**
 * A name-aware decoder double, shared by the transport and history suites.
 *
 * The transports carry codec events as opaque values, so a unit test only
 * needs a decoder that distinguishes three cases: a wire it understands, a
 * wire that throws, and a wire it ignores. Four suites wanted exactly that
 * shape, so it lives here rather than in each of them.
 */

import type * as Ably from 'ably';

import type { Decoder } from '../../src/core/codec/types.js';
import type { TransportEvent } from '../../src/core/transport/types/transport.js';

/** An opaque input body, as the transports treat it. */
export interface TestInput {
  kind: string;
}

/** An opaque output body carrying the wire data as `text`. */
export interface TestOutput {
  type: string;
  text?: string;
}

/**
 * A decoder that keys on the wire name: `ai-output` yields one output carrying
 * the wire data as `text`, `boom` throws, and anything else decodes to
 * nothing.
 * @returns The decoder.
 */
export const createNameAwareDecoder = (): Decoder<TestInput, TestOutput> => ({
  decode: (msg: Ably.InboundMessage): { inputs: TestInput[]; outputs: TestOutput[] } => {
    if (msg.name === 'boom') throw new Error('malformed payload');
    if (msg.name === 'ai-output') {
      // CAST: the test wires carry string data.
      return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
    }
    return { inputs: [], outputs: [] };
  },
});

/**
 * Project a classified batch onto its output texts, in batch order.
 * @param events - The classified batch.
 * @returns One text per event, `undefined` for a non-message event.
 */
export const outputTexts = (events: TransportEvent<TestInput, TestOutput>[]): (string | undefined)[] =>
  events.map((event) => (event.kind === 'message' ? event.outputs[0]?.text : undefined));
