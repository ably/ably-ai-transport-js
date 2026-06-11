/**
 * Generic output decode driver over a descriptor set.
 *
 * Rebuilds events from the wire: discrete messages dispatch on the codec `kind`
 * header, streamed families rebuild start/delta/end chunks from the stream
 * tracker. Escape-hatch `decode`/`decodeEnd`/`decodeDiscrete` functions take
 * over where a pure field rebuild can't express the mapping.
 *
 * This driver is pure chunk reconstruction — it carries no decode-time side
 * effects (e.g. a codec's stream-join lifecycle repair). Those belong in the
 * codec's hook layer wrapping this driver.
 */

import { stripUndefined } from '../../utils.js';
import { KIND_HEADER, readFields } from './field-bag.js';
import type {
  OutputDecodeContext,
  OutputDescriptor,
  OutputEventDescriptor,
  OutputStreamDescriptor,
} from './output-descriptors.js';
import type { StreamTrackerState } from './types.js';

/**
 * The reconstructed chunk's domain discriminator field — the codec model's own
 * `type` (e.g. `AI.UIMessageChunk.type`), per `CodecOutputEvent.type`. Distinct
 * from {@link KIND_HEADER}: this is the rebuilt object's property, never the
 * wire dispatch key.
 */
const TYPE_FIELD = 'type';

/** Decodes wire messages of union `U` from a descriptor set. */
export interface OutputDescriptorDecoder<U> {
  /** Rebuild the chunk(s) emitted when a stream starts. */
  buildStart(tracker: StreamTrackerState): U[];
  /** Rebuild the chunk(s) for a stream delta. */
  buildDelta(tracker: StreamTrackerState, delta: string): U[];
  /** Rebuild the chunk(s) emitted when a stream completes. */
  buildEnd(tracker: StreamTrackerState, closingCodecHeaders: Record<string, string>): U[];
  /**
   * Decode a discrete message by its codec `kind`.
   * @param codecKind - The codec `kind` header value (the dispatch key).
   * @param codecHeaders - The inbound codec-tier headers.
   * @param transportHeaders - The inbound transport-tier headers.
   * @param data - The inbound message data.
   * @returns The decoded events (empty if no descriptor matches).
   */
  decodeDiscrete(
    codecKind: string,
    codecHeaders: Record<string, string>,
    transportHeaders: Record<string, string>,
    data: unknown,
  ): U[];
}

/**
 * Build an output decode driver for a descriptor set.
 * @template U - The codec's event union.
 * @param descriptors - The descriptor set (events + streamed families).
 * @returns An {@link OutputDescriptorDecoder} that reconstructs events from the wire.
 */
export const createOutputDescriptorDecoder = <U extends { type: string }>(
  descriptors: readonly OutputDescriptor<U>[],
): OutputDescriptorDecoder<U> => {
  const discreteByType = new Map<string, OutputEventDescriptor<U>>();
  const wildcards: OutputEventDescriptor<U>[] = [];
  const streamByKind = new Map<string, OutputStreamDescriptor<U>>();

  for (const descriptor of descriptors) {
    if (descriptor.construct === 'event') {
      if (descriptor.match) wildcards.push(descriptor);
      else discreteByType.set(descriptor.type, descriptor);
    } else {
      streamByKind.set(descriptor.kind, descriptor);
    }
  }

  // CAST: the rebuild seam — `bag` is assembled from the descriptor's declared
  // fields and data codec, so it conforms to the matched member by construction.
  // `typeValue` is the descriptor identity, written to the chunk's domain `type`
  // field (not the wire `kind` header).
  const rebuild = (typeValue: string, bag: Record<string, unknown>): U => {
    bag[TYPE_FIELD] = typeValue;
    return stripUndefined(bag) as unknown as U;
  };

  const decodeEvent = (descriptor: OutputEventDescriptor<U>, codecKind: string, ctx: OutputDecodeContext): U[] => {
    const bag = readFields(descriptor.fields, ctx.codecHeaders);
    if (descriptor.data) Object.assign(bag, descriptor.data.decode(ctx.data));
    return [rebuild(codecKind, bag)];
  };

  // Resolve the stream family from the tracker's `kind` header. An unrecognized
  // family yields no descriptor, and the build* hooks return no events —
  // unreachable in practice, since a tracker only exists because the encoder
  // started a stream stamping a known family id.
  const familyOf = (tracker: StreamTrackerState): OutputStreamDescriptor<U> | undefined =>
    streamByKind.get(tracker.codecHeaders[KIND_HEADER] ?? '');

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

    decodeDiscrete: (codecKind, codecHeaders, transportHeaders, data) => {
      const ctx: OutputDecodeContext = { codecHeaders, transportHeaders, data };
      const evt = discreteByType.get(codecKind);
      if (evt) return decodeEvent(evt, codecKind, ctx);
      const streamDesc = streamByKind.get(codecKind);
      if (streamDesc?.decodeDiscrete) return streamDesc.decodeDiscrete(ctx);
      const wildcard = wildcards.find((w) => w.match?.(codecKind));
      if (wildcard) return decodeEvent(wildcard, codecKind, ctx);
      return [];
    },
  };
};
