/**
 * Generic input decode driver over an input descriptor set — the input-side
 * sibling of {@link import('./output-descriptor-decoder.js')}.
 *
 * Rebuilds inputs from one inbound `ai-input` message, dispatching on the codec
 * `kind` header. A single `event` rebuilds its field bag (and `data`) and wraps
 * it into the `{ kind, codecMessageId, payload }` envelope; `wireOnly` events
 * decode to `[]`. A
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
import { PART_TYPE_HEADER, readFields } from './field-bag.js';
import type { BatchDescriptor, InputDescriptor, InputEventDescriptor, PartDescriptor } from './input-descriptors.js';

/** Decodes inbound `ai-input` messages of union `U` from an input descriptor set. */
export interface InputDescriptorDecoder<U> {
  /**
   * Rebuild zero or more inputs from one inbound `ai-input` message.
   * @param ctx - The inbound message context (codec kind, data, header tiers).
   * @returns The decoded inputs (empty when no descriptor matches or the input is wire-only).
   */
  decode(ctx: InputDecodeContext): U[];
}

// Resolve the part descriptor for an inbound partType: an exact non-wildcard
// match, else a wildcard whose predicate accepts it. Wildcards are excluded
// from the exact pass — their '' sentinel must not exact-match an absent or
// empty partType header.
const partFor = (parts: readonly PartDescriptor[], partType: string): PartDescriptor | undefined =>
  parts.find((part) => !part.match && part.partType === partType) ?? parts.find((part) => part.match?.(partType));

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

    const codecMessageId = ctx.transportHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
    // The payload bag is stripped of undefined-valued props — the same rule
    // every rebuild seam applies to its innermost bag (absent and undefined
    // are indistinguishable on the wire). The envelope keys are always defined.
    // CAST: the rebuild seam — `bag` is assembled from the descriptor's declared
    // fields and data codec onto the payload, so the `{ kind, codecMessageId, payload }`
    // envelope conforms to the matched member by construction.
    return [{ kind: descriptor.kind, codecMessageId, payload: stripUndefined(bag) } as unknown as U];
  };

  const decodeBatch = (descriptor: BatchDescriptor<U>, ctx: InputDecodeContext): U[] => {
    const partType = ctx.codecHeaders[PART_TYPE_HEADER] ?? '';
    const partDesc = partFor(descriptor.parts, partType);
    if (!partDesc) return [];

    const bag = readFields(partDesc.fields, ctx.codecHeaders);
    if (partDesc.data) Object.assign(bag, partDesc.data.decode(ctx.data));
    bag.type = partType;

    // `assemble` takes the erased part (`unknown`); `bag` is the part rebuilt from
    // its declared fields/data plus the `partType` written to the domain `type`
    // field. The header tiers carry the per-message metadata (id, role, …) the
    // batch stamped on every part, so `assemble` can rebuild the message envelope.
    const partial = descriptor.assemble(stripUndefined(bag), {
      codecHeaders: ctx.codecHeaders,
      transportHeaders: ctx.transportHeaders,
    });
    // CAST: the driver stamps the shared `kind` onto the assembled one-part input; together
    // they complete the matched member. A batch creates a new message (not addressed by a
    // codec-message-id, unlike single `event`s), so none is stamped — the per-message
    // identity rides the transport header and is recovered by `assemble` when needed.
    return [{ kind: descriptor.kind, ...partial } as unknown as U];
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
