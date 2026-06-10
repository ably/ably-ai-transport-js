/**
 * `toCodecEvents` — tag a decoded message's events with their wire direction.
 *
 * A decoded message is already split into inputs and outputs by the decoder
 * (driven by the Ably message name — the authoritative direction signal). This
 * helper folds that split into the ordered {@link CodecEvent} stream the reducer
 * consumes, so the direction is carried explicitly rather than re-inferred from
 * each event's shape. Inputs are tagged before outputs, preserving the wire
 * order within a single message (a message is single-direction, so the relative
 * order of the two groups is immaterial).
 */

import type { CodecEvent, CodecInputEvent, CodecOutputEvent, DecodedMessage } from './types.js';

/**
 * Tag a decoded message's events with their wire direction.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @param decoded - The decoder's input/output split for one inbound message.
 * @returns The events as a direction-tagged {@link CodecEvent} list, inputs first.
 */
export const toCodecEvents = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>(
  decoded: DecodedMessage<TInput, TOutput>,
): CodecEvent<TInput, TOutput>[] => [
  ...decoded.inputs.map((event): CodecEvent<TInput, TOutput> => ({ direction: 'input', event })),
  ...decoded.outputs.map((event): CodecEvent<TInput, TOutput> => ({ direction: 'output', event })),
];
