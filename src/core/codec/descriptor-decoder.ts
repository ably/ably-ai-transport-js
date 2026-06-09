/**
 * Generic decode driver over a descriptor set.
 *
 * Rebuilds events from the wire: discrete messages dispatch on the codec `type`
 * header, streamed families rebuild start/delta/end chunks from the stream
 * tracker. Escape-hatch `decode`/`decodeEnd`/`decodeDiscrete` functions take
 * over where a pure field rebuild can't express the mapping.
 *
 * This driver is pure chunk reconstruction — it carries no decode-time side
 * effects (e.g. a codec's stream-join lifecycle repair). Those belong in the
 * codec's hook layer wrapping this driver.
 */

import { stripUndefined } from '../../utils.js';
import type { DecodeCtx, Descriptor, EventDescriptor, StreamDescriptor } from './descriptors.js';
import type { HeaderField } from './fields.js';
import type { StreamTrackerState } from './types.js';

/** The codec header carrying the dispatch type / stream family id. */
const TYPE_HEADER = 'type';

/** Decodes wire messages of union `U` from a descriptor set. */
export interface DescriptorDecoder<U> {
  /** Rebuild the chunk(s) emitted when a stream starts. */
  buildStart(tracker: StreamTrackerState): U[];
  /** Rebuild the chunk(s) for a stream delta. */
  buildDelta(tracker: StreamTrackerState, delta: string): U[];
  /** Rebuild the chunk(s) emitted when a stream completes. */
  buildEnd(tracker: StreamTrackerState, closingCodecHeaders: Record<string, string>): U[];
  /**
   * Decode a discrete message by its codec `type`.
   * @param codecType - The codec `type` header value.
   * @param codecHeaders - The inbound codec-tier headers.
   * @param transportHeaders - The inbound transport-tier headers.
   * @param data - The inbound message data.
   * @returns The decoded events (empty if no descriptor matches).
   */
  decodeDiscrete(
    codecType: string,
    codecHeaders: Record<string, string>,
    transportHeaders: Record<string, string>,
    data: unknown,
  ): U[];
}

const readFields = (
  fields: readonly HeaderField<unknown>[],
  headers: Record<string, string>,
): Record<string, unknown> => {
  const bag: Record<string, unknown> = {};
  for (const field of fields) bag[field.key] = field.read(headers);
  return bag;
};

/**
 * Build a decode driver for a descriptor set.
 * @template U - The codec's event union.
 * @param descriptors - The descriptor set (events + streamed families).
 * @returns A {@link DescriptorDecoder} that reconstructs events from the wire.
 */
export const createDescriptorDecoder = <U extends { type: string }>(
  descriptors: readonly Descriptor<U>[],
): DescriptorDecoder<U> => {
  const discreteByType = new Map<string, EventDescriptor<U>>();
  const wildcards: EventDescriptor<U>[] = [];
  const streamByFamily = new Map<string, StreamDescriptor<U>>();

  for (const descriptor of descriptors) {
    if (descriptor.kind === 'event') {
      if (descriptor.matchType) wildcards.push(descriptor);
      else discreteByType.set(descriptor.type, descriptor);
    } else {
      streamByFamily.set(descriptor.familyId, descriptor);
    }
  }

  // CAST: the rebuild seam — `bag` is assembled from the descriptor's declared
  // fields and data codec, so it conforms to the matched member by construction.
  const rebuild = (typeValue: string, bag: Record<string, unknown>): U => {
    bag[TYPE_HEADER] = typeValue;
    return stripUndefined(bag) as unknown as U;
  };

  const decodeEvent = (descriptor: EventDescriptor<U>, codecType: string, ctx: DecodeCtx): U[] => {
    if (descriptor.decode) return descriptor.decode(ctx);
    const bag = readFields(descriptor.fields, ctx.codecHeaders);
    if (descriptor.data) Object.assign(bag, descriptor.data.decode(ctx.data));
    return [rebuild(codecType, bag)];
  };

  // Resolve the stream family from the tracker's `type` header. An unrecognized
  // family yields no descriptor, and the build* hooks return no events —
  // unreachable in practice, since a tracker only exists because the encoder
  // started a stream stamping a known family id.
  const familyOf = (tracker: StreamTrackerState): StreamDescriptor<U> | undefined =>
    streamByFamily.get(tracker.codecHeaders[TYPE_HEADER] ?? '');

  return {
    buildStart: (tracker) => {
      const desc = familyOf(tracker);
      if (!desc) return [];
      const bag = readFields(desc.fields, tracker.codecHeaders);
      bag[desc.idField] = tracker.streamId;
      return [rebuild(desc.start, bag)];
    },

    buildDelta: (tracker, delta) => {
      const desc = familyOf(tracker);
      if (!desc) return [];
      const bag: Record<string, unknown> = { [desc.idField]: tracker.streamId, [desc.deltaField]: delta };
      return [rebuild(desc.delta, bag)];
    },

    buildEnd: (tracker, closingCodecHeaders) => {
      const desc = familyOf(tracker);
      if (!desc) return [];
      if (desc.decodeEnd) {
        return desc.decodeEnd({
          streamId: tracker.streamId,
          accumulated: tracker.accumulated,
          codecHeaders: tracker.codecHeaders,
          closingCodecHeaders,
        });
      }
      const bag = readFields(desc.fields, closingCodecHeaders);
      bag[desc.idField] = tracker.streamId;
      return [rebuild(desc.end, bag)];
    },

    decodeDiscrete: (codecType, codecHeaders, transportHeaders, data) => {
      const ctx: DecodeCtx = { codecHeaders, transportHeaders, data };
      const evt = discreteByType.get(codecType);
      if (evt) return decodeEvent(evt, codecType, ctx);
      const streamDesc = streamByFamily.get(codecType);
      if (streamDesc?.decodeDiscrete) return streamDesc.decodeDiscrete(ctx);
      const wildcard = wildcards.find((w) => w.matchType?.(codecType));
      if (wildcard) return decodeEvent(wildcard, codecType, ctx);
      return [];
    },
  };
};
