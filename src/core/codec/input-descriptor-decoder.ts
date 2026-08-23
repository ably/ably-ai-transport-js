/**
 * Generic input decode driver over an input descriptor set — the input-side
 * sibling of {@link import('./output-descriptor-decoder.js')}.
 *
 * Rebuilds inputs from one inbound `ai-input` message, dispatching on the codec
 * `kind` header. A single `event` rebuilds its fields (and `data`) and wraps
 * it into the `{ kind, payload }` envelope; `wireOnly` events decode to `[]`.
 * A `batch` reads the `partType` sub-discriminator, rebuilds the part via its
 * sub-table, `assemble`s it into a one-part input, and the driver stamps the
 * `kind`. Addressing (the codec-message-id, parent, and regenerate headers)
 * never rides the decoded input — the transport surfaces it on `WireMeta`.
 *
 * Returns bare `TInput[]` — the events carry no direction tag; the wire name
 * fixes the direction of everything decoded from one message.
 */

import { stripUndefined } from '../../utils.js';
import { PART_TYPE_HEADER, partFor, readFields } from './header-fields.js';
import type {
  BatchDescriptor,
  InputDecodeContext,
  InputDescriptor,
  InputEventDescriptor,
} from './input-descriptors.js';

/** Decodes inbound `ai-input` messages of union `U` from an input descriptor set. */
export interface InputDescriptorDecoder<U> {
  /**
   * Rebuild zero or more inputs from one inbound `ai-input` message.
   * @param ctx - The inbound message context (codec kind, data, header tiers).
   * @returns The decoded inputs (empty when no descriptor matches or the input is wire-only).
   */
  decode(ctx: InputDecodeContext): U[];
}

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

  const decodeEvent = (descriptor: InputEventDescriptor, ctx: InputDecodeContext): U[] => {
    if (descriptor.wireOnly) return [];

    const bag = readFields(descriptor.fields, ctx.codecHeaders);
    if (descriptor.data) Object.assign(bag, descriptor.data.decode(ctx.data));

    // The payload bag is stripped of undefined-valued props — the same rule
    // every rebuild boundary applies to its innermost bag (absent and undefined
    // are indistinguishable on the wire). The envelope keys are always defined.
    // CAST: the rebuild boundary — `bag` is assembled from the descriptor's declared
    // fields and data codec onto the payload, so the `{ kind, payload }`
    // envelope conforms to the matched member by construction.
    return [{ kind: descriptor.kind, payload: stripUndefined(bag) } as unknown as U];
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
    // they complete the matched member. The per-message identity rides the
    // transport header and is recovered by `assemble` when needed.
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
