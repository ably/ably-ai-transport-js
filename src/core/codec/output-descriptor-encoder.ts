/**
 * Generic output encode driver over a descriptor set.
 *
 * Builds a chunk→descriptor registry once, then routes each event: discrete
 * descriptors publish a single message, streamed families drive
 * start/append/close, and escape-hatch `encode` functions take over entirely.
 * Headers are always built through the descriptor's declared fields (the `h`
 * builder), so the imperative paths can't drift from the declarative ones.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { EncoderCore } from './encoder.js';
import { partitionOutputEvents, prop, writeFields } from './field-bag.js';
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
 * @param descriptors - The descriptor set (events + streamed families).
 * @param wireName - The Ably message name for this direction (`ai-output` / `ai-input`).
 * @returns An {@link OutputDescriptorEncoder} routing each event through its descriptor.
 */
export const createOutputDescriptorEncoder = <U extends { type: string }>(
  descriptors: readonly OutputDescriptor<U>[],
  wireName: string,
): OutputDescriptorEncoder<U> => {
  const { discreteByType, wildcards } = partitionOutputEvents(descriptors);
  const streamByPhase = new Map<string, { descriptor: OutputStreamDescriptor<U>; phase: 'start' | 'delta' | 'end' }>();

  for (const descriptor of descriptors) {
    if (descriptor.construct === 'stream') {
      streamByPhase.set(descriptor.start, { descriptor, phase: 'start' });
      streamByPhase.set(descriptor.delta, { descriptor, phase: 'delta' });
      streamByPhase.set(descriptor.end, { descriptor, phase: 'end' });
    }
  }

  return {
    encode: async (chunk, core, ctx) => {
      const { type } = chunk;

      const streamEntry = streamByPhase.get(type);
      if (streamEntry) {
        const { descriptor, phase } = streamEntry;
        const h: HeaderBuilder<U> = (c, keys) => writeFields(descriptor.fields, descriptor.kind, c, keys);
        const streamId = descriptor.streamId(chunk);
        if (phase === 'start') {
          await core.startStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) }, ctx.opts);
        } else if (phase === 'delta') {
          // CAST: deltaField is a string-valued chunk key by construction.
          core.appendStream(streamId, prop(chunk, descriptor.deltaField) as string);
        } else if (descriptor.onEnd) {
          await descriptor.onEnd(chunk, core, { h, name: wireName, messageId: ctx.messageId, opts: ctx.opts });
        } else {
          await core.closeStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) });
        }
        return;
      }

      const descriptor = discreteByType.get(type) ?? wildcards.find((w) => w.match?.(type));
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
