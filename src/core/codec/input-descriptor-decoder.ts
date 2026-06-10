/**
 * Generic input decode driver over an input descriptor set — the input-side
 * sibling of {@link import('./descriptor-decoder.js')}.
 *
 * Rebuilds inputs from one inbound `ai-input` message, dispatching on the codec
 * `kind` header. A single `event` rebuilds its field bag (and `data`) and wraps
 * it into the `{ kind, codecMessageId, payload }` envelope (for `via: 'payload'`)
 * or the flat `{ kind, ...bag }` shape; `wireOnly` events decode to `[]`. A
 * `batch` reads the `partType` sub-discriminator, rebuilds the part via its
 * sub-table, `assemble`s it into a one-part input, and the driver stamps the
 * `kind` plus the codec-message-id reconstructed from the transport header.
 *
 * Returns bare `TInput[]`, never `CodecEvent[]` — direction tagging is
 * core-owned, downstream at the decode→fold seam.
 */

import { HEADER_CODEC_MESSAGE_ID } from '../../constants.js';
import { stripUndefined } from '../../utils.js';
import type { InputDecodeContext } from './define-codec.js';
import { readFields } from './field-bag.js';
import type { BatchDescriptor, InputDescriptor, InputEventDescriptor, PartDescriptor } from './input-descriptors.js';

const PART_TYPE_FIELD = 'partType';

/** Decodes inbound `ai-input` messages of union `U` from an input descriptor set. */
export interface InputDescriptorDecoder<U> {
  /**
   * Rebuild zero or more inputs from one inbound `ai-input` message.
   * @param ctx - The inbound message context (codec kind, data, header tiers).
   * @returns The decoded inputs (empty when no descriptor matches or the input is wire-only).
   */
  decode(ctx: InputDecodeContext): U[];
}

// Resolve the part descriptor for an inbound partType: an exact match, else a wildcard.
const partFor = (parts: readonly PartDescriptor[], partType: string): PartDescriptor | undefined =>
  parts.find((part) => part.partType === partType) ?? parts.find((part) => part.match?.(partType));

/**
 * Build an input decode driver for an input descriptor set.
 * @template U - The codec's input union.
 * @param descriptors - The input descriptor set (events + batches).
 * @returns An {@link InputDescriptorDecoder} that reconstructs inputs from the wire.
 */
export const createInputDescriptorDecoder = <U extends { kind: string }>(
  descriptors: readonly InputDescriptor<U>[],
): InputDescriptorDecoder<U> => {
  const byKind = new Map<string, InputDescriptor<U>>();
  for (const descriptor of descriptors) byKind.set(descriptor.kind, descriptor);

  const decodeEvent = (descriptor: InputEventDescriptor<U>, ctx: InputDecodeContext): U[] => {
    if (descriptor.decode) return descriptor.decode(ctx);
    if (descriptor.wireOnly) return [];

    const bag = readFields(descriptor.fields, ctx.codecHeaders);
    if (descriptor.data) Object.assign(bag, descriptor.data.decode(ctx.data));

    if (descriptor.via === 'payload') {
      const codecMessageId = ctx.transportHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
      // CAST: the rebuild seam — `bag` is assembled from the descriptor's declared
      // fields and data codec onto the payload lens, so the envelope conforms to the
      // matched member by construction.
      return [stripUndefined({ kind: descriptor.kind, codecMessageId, payload: bag }) as unknown as U];
    }
    // CAST: flat rebuild — `bag` carries the member's fields/data; seeded with `kind`.
    return [stripUndefined({ kind: descriptor.kind, ...bag }) as unknown as U];
  };

  const decodeBatch = (descriptor: BatchDescriptor<U>, ctx: InputDecodeContext): U[] => {
    const partType = ctx.codecHeaders[PART_TYPE_FIELD] ?? '';
    const partDesc = partFor(descriptor.parts, partType);
    if (!partDesc) return [];

    const bag = readFields(partDesc.fields, ctx.codecHeaders);
    if (partDesc.data) Object.assign(bag, partDesc.data.decode(ctx.data));
    bag.type = partType;

    // `assemble` takes the erased part (`unknown`); `bag` is the part rebuilt from
    // its declared fields/data plus the `partType` written to the domain `type` field.
    const partial = descriptor.assemble(stripUndefined(bag));
    const codecMessageId = ctx.transportHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
    // CAST: the driver stamps the shared `kind` and the reconstructed codec-message-id
    // onto the assembled one-part input; together they complete the matched member.
    return [{ kind: descriptor.kind, codecMessageId, ...partial } as unknown as U];
  };

  return {
    decode: (ctx) => {
      const descriptor = byKind.get(ctx.codecKind);
      if (!descriptor) return [];
      if (descriptor.construct === 'event') return decodeEvent(descriptor, ctx);
      return decodeBatch(descriptor, ctx);
    },
  };
};
