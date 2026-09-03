/**
 * A name-aware decoder double, shared by the transport and history suites.
 *
 * The transports carry codec events as opaque values, so a unit test only
 * needs a decoder that distinguishes four cases: a wire it decodes to an
 * output, a wire it decodes to an input, a wire that throws, and a wire it
 * ignores.
 *
 * The output and throw arms are the same everywhere, so they live here. Only
 * the input arm genuinely differs between suites — the history suites want no
 * input arm at all, the agent suite wants a caller-injected fixture, and the
 * client suite derives its input from the wire — so that arm is the injected
 * strategy, and the input type is the parameter.
 *
 * {@link TestInput} and {@link TestOutput} are the opaque bodies themselves, so
 * a suite that needs the same bodies without the decoder (the step writer's,
 * whose codec decodes nothing) imports them on their own.
 */

import type * as Ably from 'ably';

import type { Decoder } from '../../src/core/codec/types.js';
import type { TransportEvent } from '../../src/core/transport/types/transport.js';

/**
 * The minimum an opaque input body carries. A suite that pins more fields on a
 * decoded input extends this and passes its own type.
 */
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
 * the wire data as `text`, `boom` throws, `ai-input` goes to `decodeInputs`,
 * and anything else decodes to nothing.
 * @param decodeInputs - Yields the inputs for an `ai-input` wire. Omit for a
 *   suite that publishes no inputs, and `ai-input` decodes to nothing too.
 * @returns The decoder.
 */
export const createNameAwareDecoder = <TIn extends TestInput = TestInput>(
  decodeInputs?: (msg: Ably.InboundMessage) => TIn[],
): Decoder<TIn, TestOutput> => ({
  decode: (msg: Ably.InboundMessage): { inputs: TIn[]; outputs: TestOutput[] } => {
    if (msg.name === 'boom') throw new Error('malformed payload');
    if (msg.name === 'ai-output') {
      // CAST: the test wires carry string data.
      return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
    }
    if (msg.name === 'ai-input' && decodeInputs) {
      return { inputs: decodeInputs(msg), outputs: [] };
    }
    return { inputs: [], outputs: [] };
  },
});

/**
 * Project a classified batch onto its output texts, in batch order.
 * @param events - The classified batch.
 * @returns One text per event, `undefined` for a non-message event.
 */
export const outputTexts = <TIn extends TestInput>(events: TransportEvent<TIn, TestOutput>[]): (string | undefined)[] =>
  events.map((event) => (event.kind === 'message' ? event.outputs[0]?.text : undefined));
