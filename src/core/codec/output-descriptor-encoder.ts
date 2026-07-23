/**
 * Generic output encode driver over a descriptor set.
 *
 * Builds a chunk→descriptor registry once, then routes each event: discrete
 * descriptors publish a single message, streamed groups drive
 * start/append/close, dropped types skip silently (publish nothing), and
 * escape-hatch `encode` functions take over entirely. Headers are always built
 * through the descriptor's declared fields (the `h` builder), so the
 * imperative paths can't drift from the declarative ones.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { EncoderCore } from './encoder.js';
import { partitionOutputEvents, prop, writeFields } from './header-fields.js';
import type { HeaderBuilder, OutputDescriptor, OutputStreamDescriptor } from './output-descriptors.js';
import type { WriteOptions } from './types.js';

/** Per-write output encode context threaded from the encoder. */
export interface OutputEncodeContext {
  /** The encoder's configured fallback message id, if any. */
  messageId: string | undefined;
  /** Per-write overrides. */
  opts: WriteOptions | undefined;
}

/** Encodes events of union `U` to channel operations via a descriptor set. */
export interface OutputDescriptorEncoder<U> {
  /**
   * Encode one event through its descriptor.
   * @param chunk - The event to encode.
   * @param core - The encoder core to publish/stream through.
   * @param ctx - Per-write context (fallback message id, write options).
   * @returns A promise resolving when the publish/stream operation completes.
   */
  encode(chunk: U, core: EncoderCore, ctx: OutputEncodeContext): Promise<void>;
}

/**
 * Build an output encode driver for a descriptor set bound to a wire message name.
 * @template U - The codec's event union.
 * @param descriptors - The descriptor set (events, streamed groups, and dropped types).
 * @param wireName - The Ably message name for this direction (`ai-output` / `ai-input`).
 * @returns An {@link OutputDescriptorEncoder} routing each event through its descriptor.
 */
export const createOutputDescriptorEncoder = <U extends { type: string }>(
  descriptors: readonly OutputDescriptor<U>[],
  wireName: string,
): OutputDescriptorEncoder<U> => {
  const { discreteByType, wildcards } = partitionOutputEvents(descriptors);
  // A start type may be shared across groups (resolved by `start.match`), so it
  // maps to a list of candidates; delta/end types are unique per group (1:1).
  const streamStartsByType = new Map<string, OutputStreamDescriptor<U>[]>();
  const streamDeltasOrEndsByType = new Map<string, { descriptor: OutputStreamDescriptor<U>; phase: 'delta' | 'end' }>();
  // Types the codec deliberately keeps off the wire (see the `drop` construct).
  // The encoder skips these silently, and throws on any other undescribed type.
  const droppedTypes = new Set<string>();

  for (const descriptor of descriptors) {
    if (descriptor.construct === 'stream') {
      const starts = streamStartsByType.get(descriptor.start.type) ?? [];
      starts.push(descriptor);
      streamStartsByType.set(descriptor.start.type, starts);
      streamDeltasOrEndsByType.set(descriptor.delta.type, { descriptor, phase: 'delta' });
      streamDeltasOrEndsByType.set(descriptor.end.type, { descriptor, phase: 'end' });
    } else if (descriptor.construct === 'drop') {
      droppedTypes.add(descriptor.type);
    }
  }

  // Encode one phase of a resolved stream group — shared by the start-dispatch
  // and delta/end-dispatch paths so they can't drift.
  const encodeStreamPhase = async (
    descriptor: OutputStreamDescriptor<U>,
    phase: 'start' | 'delta' | 'end',
    chunk: U,
    core: EncoderCore,
    ctx: OutputEncodeContext,
  ): Promise<void> => {
    const h: HeaderBuilder<U> = (c, keys) => writeFields(descriptor.fields, descriptor.kind, c, keys);
    const streamId = descriptor.streamId(chunk);
    if (phase === 'start') {
      await core.startStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) }, ctx.opts);
    } else if (phase === 'delta') {
      // CAST: delta.field is a string-valued chunk key by construction.
      core.appendStream(streamId, prop(chunk, descriptor.delta.field) as string);
    } else if (descriptor.end.encode) {
      await descriptor.end.encode(chunk, core, { h, name: wireName, messageId: ctx.messageId, opts: ctx.opts });
    } else {
      await core.closeStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) });
    }
  };

  return {
    encode: async (chunk, core, ctx) => {
      const { type } = chunk;

      // Stream dispatch. A start type may be shared across groups, resolved by
      // each group's `start.match` discriminator; a chunk of a start type that
      // matches no group is not a stream event and falls through to discrete
      // dispatch (its `event()` descriptor handles it). Delta/end types are unique.
      const startCandidates = streamStartsByType.get(type);
      if (startCandidates) {
        const descriptor = startCandidates.find((d) => d.start.match?.(chunk) ?? true);
        if (descriptor) {
          await encodeStreamPhase(descriptor, 'start', chunk, core, ctx);
          return;
        }
        // Declined: no group describes this start chunk — fall through to discrete.
      } else {
        const deltaOrEnd = streamDeltasOrEndsByType.get(type);
        if (deltaOrEnd) {
          await encodeStreamPhase(deltaOrEnd.descriptor, deltaOrEnd.phase, chunk, core, ctx);
          return;
        }
      }

      // Discrete dispatch. An exact `event` wins (an exact event+drop overlap
      // is rejected at defineCodec time); otherwise an exact `drop` declaration
      // is honoured before wildcard events, so a specific drop beats an
      // `event('x-*')` wildcard group. The drop check must also stay after the stream
      // dispatch above, so a dropped type can serve as a shared start's decline
      // target. A type nothing dispatches to at all is a surprise, so the driver
      // rejects it loudly instead of silently dropping content.
      const exact = discreteByType.get(type);
      if (!exact && droppedTypes.has(type)) return;
      const descriptor = exact ?? wildcards.find((w) => w.match?.(type));
      if (!descriptor) {
        throw new Ably.ErrorInfo(`unable to publish; unsupported event type '${type}'`, ErrorCode.InvalidArgument, 400);
      }

      const h: HeaderBuilder<U> = (c, keys) => writeFields(descriptor.fields, c.type, c, keys);
      if (descriptor.encode) {
        await descriptor.encode(chunk, core, { h, name: wireName, messageId: ctx.messageId, opts: ctx.opts });
        return;
      }

      const data = descriptor.data ? descriptor.data.encode(chunk) : '';
      await core.publishDiscrete(
        { name: wireName, data, codecHeaders: h(chunk), ephemeral: descriptor.ephemeral?.(chunk) },
        ctx.opts,
      );
    },
  };
};
