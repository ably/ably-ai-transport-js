/**
 * A hand-written codec that uses the room the codec contract leaves beyond
 * the builder: one event may encode to several messages, and one message may
 * decode to several events. It has no decoder core, so every decode is a pure
 * function of its input. It names no message: the transport names every one
 * `ai` and writes the codec's id beside it.
 */

import type { Codec } from '../../src/core/codec/index.js';

export type SplitEvent =
  /** One message, one event. */
  | { type: 'half'; text: string }
  /** Encodes to two plain publishes, `a` then `b`. */
  | { type: 'both'; a: string; b: string }
  /** Encodes to a publish and then an append, which `send` refuses. */
  | { type: 'mixed'; text: string };

/**
 * Build the split codec. A message decodes to one `half` per `|`-separated
 * piece of its data. The decoder hands it only the messages the transport
 * wrote for it.
 * @returns The codec.
 */
export const createSplitCodec = (): Codec<SplitEvent> => ({
  id: 'split',
  encode: (event) => {
    switch (event.type) {
      case 'half': {
        return [{ message: { data: event.text } }];
      }
      case 'both': {
        return [{ message: { data: event.a } }, { message: { data: event.b } }];
      }
      case 'mixed': {
        return [{ message: { data: event.text } }, { message: { data: '+' }, append: 'k' }];
      }
    }
  },
  decode: (message) => {
    const data: unknown = message.data;
    if (typeof data !== 'string') return [];
    return data.split('|').map((text): SplitEvent => ({ type: 'half', text }));
  },
});
