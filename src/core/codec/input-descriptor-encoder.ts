/**
 * Generic input encode driver over an input descriptor set — the input-side
 * sibling of {@link import('./descriptor-encoder.js')}.
 *
 * Builds a `kind`→descriptor registry once, then routes each input: a single
 * `event` publishes one discrete message (lensed onto `payload` when
 * `via: 'payload'`, kind-only when `wireOnly`); a `batch` explodes the domain
 * message into one wire event per part and publishes them atomically, with a
 * built-in ≥1-event guarantee so the codec-message-id and role survive an empty
 * decomposition. Headers are always built through the descriptor's declared
 * fields ({@link writeFields}), so the imperative paths can't drift.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { InputAdapterCore, InputEncodeContext } from './define-codec.js';
import { prop, writeFields } from './field-bag.js';
import type {
  BatchDescriptor,
  BatchMessageHeaders,
  InputDescriptor,
  InputEventDescriptor,
  PartDescriptor,
} from './input-descriptors.js';
import type { MessagePayload } from './types.js';

/** Encodes inputs of union `U` to channel operations via an input descriptor set. */
export interface InputDescriptorEncoder<U> {
  /**
   * Encode one input through its descriptor.
   * @param input - The input to encode.
   * @param core - The input adapter core to publish through.
   * @param ctx - Per-write context (write options, carrying the codec-message-id).
   * @returns A promise resolving when the publish operation completes.
   */
  encode(input: U, core: InputAdapterCore, ctx: InputEncodeContext): Promise<void>;
}

// Resolve the part descriptor for a given partType: an exact match, else a wildcard.
const partFor = (parts: readonly PartDescriptor[], partType: string): PartDescriptor | undefined =>
  parts.find((part) => part.partType === partType) ?? parts.find((part) => part.match?.(partType));

// Layer the batch's per-message transport headers onto a part payload, if any.
const withMessageTransport = (payload: MessagePayload, message: BatchMessageHeaders | undefined): MessagePayload =>
  message?.transportHeaders === undefined
    ? payload
    : { ...payload, transportHeaders: { ...payload.transportHeaders, ...message.transportHeaders } };

/**
 * Build an input encode driver for an input descriptor set bound to a wire name.
 * @template U - The codec's input union.
 * @param descriptors - The input descriptor set (events + batches).
 * @param wireName - The Ably message name for the input direction (`ai-input`).
 * @returns An {@link InputDescriptorEncoder} routing each input through its descriptor.
 */
export const createInputDescriptorEncoder = <U extends { kind: string }>(
  descriptors: readonly InputDescriptor<U>[],
  wireName: string,
): InputDescriptorEncoder<U> => {
  const byKind = new Map<string, InputDescriptor<U>>();
  for (const descriptor of descriptors) byKind.set(descriptor.kind, descriptor);

  const encodeEvent = async (
    descriptor: InputEventDescriptor<U>,
    input: U,
    core: InputAdapterCore,
    ctx: InputEncodeContext,
  ): Promise<void> => {
    if (descriptor.encode) {
      await descriptor.encode(input, core, ctx);
      return;
    }
    if (descriptor.wireOnly) {
      // Kind only: no fields, no data — the parent/target ride transport headers.
      await core.publishDiscrete({ name: wireName, data: '', codecHeaders: { kind: descriptor.kind } }, ctx.opts);
      return;
    }
    // CAST: `via: 'payload'` reads the member's `payload` lens; the member carries
    // it by construction (only payload-bearing inputs declare `via`). Without `via`
    // the source is the member itself.
    const source = descriptor.via === 'payload' ? (prop(input, 'payload') as object) : input;
    const codecHeaders = writeFields(descriptor.fields, descriptor.kind, source);
    const data = descriptor.data ? descriptor.data.encode(source) : '';
    await core.publishDiscrete({ name: wireName, data, codecHeaders }, ctx.opts);
  };

  const encodeBatch = async (
    descriptor: BatchDescriptor<U>,
    input: U,
    core: InputAdapterCore,
    ctx: InputEncodeContext,
  ): Promise<void> => {
    // Per-message headers (e.g. message id, role) are stamped on every part so
    // the decode side can reconstruct the shared message envelope from any one.
    const message = descriptor.messageHeaders?.(input);
    const payloads: MessagePayload[] = [];
    for (const part of descriptor.explode(input)) {
      const partType = descriptor.partTypeOf(part);
      const partDesc = partFor(descriptor.parts, partType);
      if (!partDesc) continue;
      // CAST: a part is indexed by its declared fields; the part descriptor only
      // runs against the part its predicate/literal matched, so the source has the
      // field's type at runtime. The wire `partType` is the resolved part type.
      const source = part as object;
      const codecHeaders = {
        ...writeFields(partDesc.fields, descriptor.kind, source),
        ...message?.codecHeaders,
        partType,
      };
      const data = partDesc.data ? partDesc.data.encode(part) : '';
      payloads.push(withMessageTransport({ name: wireName, data, codecHeaders }, message));
    }

    if (payloads.length === 0) {
      // ≥1-event guarantee: emit one bare part so the per-message headers (e.g. the
      // message id and role) survive an empty explode.
      payloads.push(
        withMessageTransport(
          { name: wireName, data: '', codecHeaders: { kind: descriptor.kind, ...message?.codecHeaders } },
          message,
        ),
      );
    }

    await core.publishDiscreteBatch(payloads, ctx.opts);
  };

  return {
    encode: async (input, core, ctx) => {
      const descriptor = byKind.get(input.kind);
      if (!descriptor) {
        throw new Ably.ErrorInfo(
          `unable to publish; unsupported input kind '${input.kind}'`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      await (descriptor.construct === 'event'
        ? encodeEvent(descriptor, input, core, ctx)
        : encodeBatch(descriptor, input, core, ctx));
    },
  };
};
