/**
 * Generic output decode driver over a descriptor set.
 *
 * Rebuilds events from the wire: discrete messages dispatch on the codec `kind`
 * header, streamed groups rebuild start/delta/end chunks from the stream
 * tracker. Escape-hatch `delta.decode`/`end.decode`/`decodeDiscrete` functions
 * take over where a pure field rebuild can't express the mapping.
 *
 * This driver is pure chunk reconstruction — it carries no decode-time side
 * effects (e.g. a codec's stream-join lifecycle repair). Those belong in the
 * codec's hook layer wrapping this driver.
 */

import { stripUndefined } from '../../utils.js';
import type { FieldFor } from './fields.js';
import { KIND_HEADER, partitionOutputEvents, readFields } from './header-fields.js';
import type {
  OutputDecodeContext,
  OutputDescriptor,
  OutputEventDescriptor,
  OutputStreamDescriptor,
} from './output-descriptors.js';
import type { StreamSequenceState } from './types.js';

/**
 * The reconstructed chunk's domain discriminator field — the codec model's own
 * `type` discriminator, per `CodecOutputEvent.type`. Distinct
 * from {@link KIND_HEADER}: this is the rebuilt object's property, never the
 * wire dispatch key.
 */
const TYPE_FIELD = 'type';

/** Decodes wire messages of union `U` from a descriptor set. */
export interface OutputDescriptorDecoder<U> {
  /** Rebuild the chunk(s) emitted when a stream starts. */
  buildStart(tracker: StreamSequenceState): U[];
  /** Rebuild the chunk(s) for a stream delta. */
  buildDelta(tracker: StreamSequenceState, delta: string): U[];
  /** Rebuild the chunk(s) emitted when a stream completes. */
  buildEnd(tracker: StreamSequenceState, closingCodecHeaders: Record<string, string>): U[];
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
 * @param descriptors - The descriptor set (events, streamed groups, and
 * dropped types — the latter never reach the wire, so nothing decodes for them).
 * @returns An {@link OutputDescriptorDecoder} that reconstructs events from the wire.
 */
export const createOutputDescriptorDecoder = <U extends { type: string }>(
  descriptors: readonly OutputDescriptor<U>[],
): OutputDescriptorDecoder<U> => {
  const { discreteByType, wildcards } = partitionOutputEvents(descriptors);
  const streamByKind = new Map<string, OutputStreamDescriptor<U>>();

  for (const descriptor of descriptors) {
    if (descriptor.construct === 'stream') {
      streamByKind.set(descriptor.kind, descriptor);
    }
  }

  // CAST: the rebuild boundary — `bag` is assembled from the descriptor's declared
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

  // Resolve the stream group from the tracker's `kind` header. An unrecognized
  // group yields no descriptor, and the build* hooks return no events —
  // unreachable in practice, since a tracker only exists because the encoder
  // started a stream stamping a known group id.
  const streamSpecOf = (tracker: StreamSequenceState): OutputStreamDescriptor<U> | undefined =>
    streamByKind.get(tracker.codecHeaders[KIND_HEADER] ?? '');

  return {
    buildStart: (tracker) => {
      const desc = streamSpecOf(tracker);
      if (!desc) return [];
      return [rebuild(desc.start.type, readFields(desc.fields, tracker.codecHeaders))];
    },

    buildDelta: (tracker, delta) => {
      const desc = streamSpecOf(tracker);
      if (!desc) return [];
      // The delta rebuilds from named fields read off the re-stamped start
      // headers, plus the fragment. `rebuildDelta` copies the named fields; a
      // group customises which via `delta.decode`, or omits it for a
      // fragment-only delta.
      const rebuildDelta = (fields: readonly FieldFor<U>[]): U[] => {
        const bag = readFields(fields, tracker.codecHeaders);
        bag[desc.delta.field] = delta;
        return [rebuild(desc.delta.type, bag)];
      };
      if (desc.delta.decode) {
        return desc.delta.decode({
          streamId: tracker.streamId,
          delta,
          codecHeaders: tracker.codecHeaders,
          rebuild: rebuildDelta,
        });
      }
      return rebuildDelta([]);
    },

    buildEnd: (tracker, closingCodecHeaders) => {
      const desc = streamSpecOf(tracker);
      if (!desc) return [];
      if (desc.end.decode) {
        return desc.end.decode({
          streamId: tracker.streamId,
          accumulated: tracker.accumulated,
          codecHeaders: tracker.codecHeaders,
          closingCodecHeaders,
        });
      }
      return [rebuild(desc.end.type, readFields(desc.fields, closingCodecHeaders))];
    },

    decodeDiscrete: (codecKind, codecHeaders, transportHeaders, data) => {
      const ctx: OutputDecodeContext = { codecKind, codecHeaders, transportHeaders, data };
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
