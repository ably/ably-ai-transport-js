/**
 * A hand-written codec that uses the room the codec contract leaves beyond
 * the builder: one event may encode to several messages, and one message may
 * decode to several events. It has no decoder core, so every decode is a pure
 * function of its input.
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
 * Build the split codec. A message named `split` decodes to one `half` per
 * `|`-separated piece of its data; any other message decodes to nothing.
 * @returns The codec.
 */
export const createSplitCodec = (): Codec<SplitEvent> => ({
  encode: (event) => {
    switch (event.type) {
      case 'half': {
        return [{ message: { name: 'split', data: event.text } }];
      }
      case 'both': {
        return [{ message: { name: 'split', data: event.a } }, { message: { name: 'split', data: event.b } }];
      }
      case 'mixed': {
        return [
          { message: { name: 'split', data: event.text } },
          { message: { name: 'split', data: '+' }, append: 'k' },
        ];
      }
    }
  },
  decode: (message) => {
    const data: unknown = message.data;
    if (message.name !== 'split' || typeof data !== 'string') return [];
    return data.split('|').map((text): SplitEvent => ({ type: 'half', text }));
  },
});
