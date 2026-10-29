/**
 * A hand-written codec that uses the room the codec contract leaves beyond
 * the builder: one event may encode to several messages, and one message may
 * decode to several events. It has no decoder core, so every decode is a pure
 * function of its input. It names its own messages `split` and writes its id,
 * as every codec must.
 */

import type * as Ably from 'ably';

import type { Codec } from '../../src/core/codec/index.js';

/**
 * A message as the split codec writes it: its own name, and its id under
 * `extras.ai.codec`, as the contract asks of every codec.
 * @param data - The message body.
 * @returns The message.
 */
const splitMessage = (data: string): Ably.Message => ({ name: 'split', data, extras: { ai: { codec: 'split' } } });

export type SplitEvent =
  /** One message, one event. */
  | { type: 'half'; text: string }
  /** Encodes to two plain publishes, `a` then `b`. */
  | { type: 'both'; a: string; b: string }
  /** Encodes to a publish and then an append, which `send` refuses. */
  | { type: 'mixed'; text: string };

/**
 * Build the split codec. A message decodes to one `half` per `|`-separated
 * piece of its data. The decoder hands it only messages named `split` that
 * carry its id.
 * @returns The codec.
 */
export const createSplitCodec = (): Codec<SplitEvent> => ({
  id: 'split',
  name: 'split',
  encode: (event) => {
    switch (event.type) {
      case 'half': {
        return [{ message: splitMessage(event.text) }];
      }
      case 'both': {
        return [{ message: splitMessage(event.a) }, { message: splitMessage(event.b) }];
      }
      case 'mixed': {
        return [{ message: splitMessage(event.text) }, { message: splitMessage('+'), append: 'k' }];
      }
    }
  },
  decode: (message) => {
    const data: unknown = message.data;
    if (typeof data !== 'string') return [];
    return data.split('|').map((text): SplitEvent => ({ type: 'half', text }));
  },
});
