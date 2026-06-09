/**
 * Generic encode driver over a descriptor set.
 *
 * Builds a chunk→descriptor registry once, then routes each event: discrete
 * descriptors publish a single message, streamed families drive
 * start/append/close, and escape-hatch `encode` functions take over entirely.
 * Headers are always built through the descriptor's declared fields (the `h`
 * builder), so the imperative paths can't drift from the declarative ones.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Descriptor, EventDescriptor, HeaderBuilder, StreamDescriptor } from './descriptors.js';
import type { EncoderCore } from './encoder.js';
import type { HeaderField } from './fields.js';
import type { WriteOptions } from './types.js';

/** The codec header carrying the dispatch type / stream family id. */
const TYPE_HEADER = 'type';

// CAST: a descriptor indexes chunk props by a declared key. The union member's
// indexed type isn't statically known here, but a descriptor only ever runs
// against the member it matches, so the value has the field's type at runtime.
const prop = (chunk: object, key: string): unknown => (chunk as Record<string, unknown>)[key];

/** Per-write encode context threaded from the encoder. */
export interface EncodeContext {
  /** The encoder's configured fallback message id, if any. */
  messageId: string | undefined;
  /** Per-write overrides. */
  opts: WriteOptions | undefined;
}

/** Encodes events of union `U` to channel operations via a descriptor set. */
export interface DescriptorEncoder<U> {
  /**
   * Encode one event through its descriptor.
   * @param chunk - The event to encode.
   * @param core - The encoder core to publish/stream through.
   * @param ctx - Per-write context (fallback message id, write options).
   * @returns A promise resolving when the publish/stream operation completes.
   */
  encode(chunk: U, core: EncoderCore, ctx: EncodeContext): Promise<void>;
}

/**
 * Build an encode driver for a descriptor set bound to a wire message name.
 * @template U - The codec's event union.
 * @param descriptors - The descriptor set (events + streamed families).
 * @param wireName - The Ably message name for this direction (`ai-output` / `ai-input`).
 * @returns A {@link DescriptorEncoder} routing each event through its descriptor.
 */
export const createDescriptorEncoder = <U extends { type: string }>(
  descriptors: readonly Descriptor<U>[],
  wireName: string,
): DescriptorEncoder<U> => {
  const discreteByType = new Map<string, EventDescriptor<U>>();
  const wildcards: EventDescriptor<U>[] = [];
  const streamByPhase = new Map<string, { descriptor: StreamDescriptor<U>; phase: 'start' | 'delta' | 'end' }>();

  for (const descriptor of descriptors) {
    if (descriptor.kind === 'event') {
      if (descriptor.matchType) wildcards.push(descriptor);
      else discreteByType.set(descriptor.type, descriptor);
    } else {
      streamByPhase.set(descriptor.start, { descriptor, phase: 'start' });
      streamByPhase.set(descriptor.delta, { descriptor, phase: 'delta' });
      streamByPhase.set(descriptor.end, { descriptor, phase: 'end' });
    }
  }

  const buildHeaders = (
    fields: readonly HeaderField<unknown>[],
    typeValue: string,
    chunk: U,
    keys?: readonly string[],
  ): Record<string, string> => {
    const rec: Record<string, string> = { [TYPE_HEADER]: typeValue };
    for (const field of fields) {
      if (keys && !keys.includes(field.key)) continue;
      field.write(rec, prop(chunk, field.key));
    }
    return rec;
  };

  return {
    encode: async (chunk, core, ctx) => {
      const { type } = chunk;

      const streamEntry = streamByPhase.get(type);
      if (streamEntry) {
        const { descriptor, phase } = streamEntry;
        const h: HeaderBuilder<U> = (c, keys) => buildHeaders(descriptor.fields, descriptor.familyId, c, keys);
        // CAST: idField/deltaField are string-valued chunk keys by construction.
        const streamId = prop(chunk, descriptor.idField) as string;
        if (phase === 'start') {
          await core.startStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) }, ctx.opts);
        } else if (phase === 'delta') {
          core.appendStream(streamId, prop(chunk, descriptor.deltaField) as string);
        } else if (descriptor.onEnd) {
          await descriptor.onEnd(chunk, core, { h, name: wireName, messageId: ctx.messageId, opts: ctx.opts });
        } else {
          await core.closeStream(streamId, { name: wireName, data: '', codecHeaders: h(chunk) });
        }
        return;
      }

      const descriptor = discreteByType.get(type) ?? wildcards.find((w) => w.matchType?.(type));
      if (!descriptor) {
        throw new Ably.ErrorInfo(`unable to publish; unsupported event type '${type}'`, ErrorCode.InvalidArgument, 400);
      }

      const h: HeaderBuilder<U> = (c, keys) => buildHeaders(descriptor.fields, c.type, c, keys);
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
