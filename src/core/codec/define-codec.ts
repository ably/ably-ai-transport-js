/**
 * `defineCodec` — composition packaging for a codec.
 *
 * A codec author supplies only its **parts** — a per-direction descriptor
 * table (the `output` and `input` builder functions), an optional decode
 * lifecycle policy, and an optional agent identifier — and `defineCodec`
 * assembles a fully-formed {@link WireCodec}: the generic encoder/decoder
 * skeletons, built here, codec-agnostic.
 *
 * Both directions are declarative descriptor tables driven by the generic
 * encode/decode drivers. `defineCodec` hands each table a direction-scoped
 * builder typed to that direction's union — `{ event, stream, drop }` for
 * outputs, `{ event, batch }` for inputs — so each construct's spec stays
 * type-correct per direction under shared construct names, with no per-entry
 * casts. Both sides build/read wire headers through the same shared field
 * bindings, so encode and decode cannot drift.
 */

import * as Ably from 'ably';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_RUN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { DecoderCore, DecoderCoreHooks } from './decoder.js';
import { createDecoderCore } from './decoder.js';
import type { EncoderCore, EncoderCoreOptions } from './encoder.js';
import { createEncoderCore } from './encoder.js';
import type { HeaderField } from './fields.js';
import { KIND_HEADER, PART_TYPE_HEADER } from './header-fields.js';
import { createInputDescriptorDecoder, type InputDescriptorDecoder } from './input-descriptor-decoder.js';
import { createInputDescriptorEncoder, type InputDescriptorEncoder } from './input-descriptor-encoder.js';
import { type InputBuilder, inputBuilder, type InputDescriptor } from './input-descriptors.js';
import { createOutputDescriptorDecoder } from './output-descriptor-decoder.js';
import { createOutputDescriptorEncoder, type OutputDescriptorEncoder } from './output-descriptor-encoder.js';
import { type OutputBuilder, outputBuilder, type OutputDescriptor } from './output-descriptors.js';
import type {
  ChannelWriter,
  DecodedMessage,
  Decoder,
  Encoder,
  MessagePayload,
  StreamSequenceState,
  WireCodec,
  WriteOptions,
} from './types.js';

// Re-exported so codec descriptor tables (e.g. the Vercel `inputs.ts` / `outputs.ts`)
// can type their builder parameter without reaching into the descriptor modules directly.
export type { InputBuilder } from './input-descriptors.js';
export type { OutputBuilder } from './output-descriptors.js';

// ---------------------------------------------------------------------------
// Decode lifecycle policy
// ---------------------------------------------------------------------------

/** Context passed to a {@link LifecyclePolicy} `onDiscrete` repair function. */
export interface LifecycleDiscreteContext {
  /** The inbound codec-tier headers (e.g. to recover a stream's message id). */
  codecHeaders: Record<string, string>;
}

/**
 * Declarative decode-time lifecycle repair, applied when joining a stream
 * mid-flight (history compaction, rewind miss, partial page). Each function
 * performs its side effect on the codec's lifecycle tracker (captured by the
 * factory that builds the policy) and RETURNS lead-in events to PREPEND; the
 * generic decoder ALWAYS runs the descriptor driver after and appends its
 * output, so the policy never replaces a decode. A codec with no repair
 * supplies no policy.
 * @template TOutput - The codec's output union.
 */
export interface LifecyclePolicy<TOutput> {
  /**
   * Keyed on the discrete codec `kind`. Returns lead-in events to prepend
   * (empty array = none) after applying any tracker side effect.
   */
  onDiscrete?: Record<string, (runId: string, ctx: LifecycleDiscreteContext) => TOutput[]>;
  /** Lead-in prepended to a stream's start events (mid-stream-join pre-roll). */
  onStreamStart?: (runId: string, tracker: StreamSequenceState) => TOutput[];
}

// ---------------------------------------------------------------------------
// defineCodec config + result
// ---------------------------------------------------------------------------

/**
 * The parts a codec supplies to {@link defineCodec}.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 */
export interface DefineCodecConfig<TInput extends { kind: string }, TOutput extends { type: string }> {
  /**
   * The declarative output (`ai-output`) descriptor table, returned from the
   * injected `{ event, stream, drop }` builder (curried on `TOutput`).
   */
  output: (b: OutputBuilder<TOutput>) => readonly OutputDescriptor<TOutput>[];
  /**
   * The declarative input (`ai-input`) descriptor table, returned from the
   * injected `{ event, batch }` builder (both curried on `TInput`).
   */
  input: (b: InputBuilder<TInput>) => readonly InputDescriptor<TInput>[];
  /**
   * Factory for a fresh decoder synthesise-lifecycle policy per decoder instance
   * (the policy's closures capture a fresh, per-decoder lifecycle tracker). Omit
   * for a codec with no mid-stream-join repair.
   */
  decoderSynthesiseLifecycle?: () => LifecyclePolicy<TOutput>;
}

// ---------------------------------------------------------------------------
// Generic encoder
// ---------------------------------------------------------------------------

class DefaultCodecEncoder<TInput extends { kind: string }, TOutput extends { type: string }> implements Encoder<
  TInput,
  TOutput
> {
  private readonly _core: EncoderCore;
  private readonly _messageId: string | undefined;
  private readonly _outputEncoder: OutputDescriptorEncoder<TOutput>;
  private readonly _inputEncoder: InputDescriptorEncoder<TInput>;

  constructor(
    writer: ChannelWriter,
    options: EncoderCoreOptions,
    outputEncoder: OutputDescriptorEncoder<TOutput>,
    inputEncoder: InputDescriptorEncoder<TInput>,
  ) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
    this._outputEncoder = outputEncoder;
    this._inputEncoder = inputEncoder;
  }

  async publishInput(input: TInput, options?: WriteOptions): Promise<void> {
    // No `messageId` threads into inputs — user-message parts carry no
    // transport transport-message-id today; inputs rely on opts.messageId stamped
    // by the transport.
    await this._inputEncoder.encode(input, this._core, { opts: options });
  }

  async publishOutput(output: TOutput, options?: WriteOptions): Promise<void> {
    await this._outputEncoder.encode(output, this._core, { messageId: this._messageId, opts: options });
  }

  async cancelStreams(): Promise<void> {
    await this._core.cancelAllStreams();
  }

  async close(): Promise<void> {
    await this._core.close();
  }
}

// ---------------------------------------------------------------------------
// Generic decoder
// ---------------------------------------------------------------------------

const decodeDiscretePayload = <TInput extends { kind: string }, TOutput>(
  payload: MessagePayload,
  outputDecoder: ReturnType<typeof createOutputDescriptorDecoder<TOutput & { type: string }>>,
  inputDecoder: InputDescriptorDecoder<TInput>,
  lifecycle: LifecyclePolicy<TOutput> | undefined,
): (TInput | TOutput)[] => {
  const codecHeaders = payload.codecHeaders ?? {};
  const transportHeaders = payload.transportHeaders ?? {};
  const codecKind = codecHeaders[KIND_HEADER] ?? '';

  if (payload.name === EVENT_AI_INPUT) {
    return inputDecoder.decode({ codecKind, data: payload.data, codecHeaders, transportHeaders });
  }

  if (payload.name === EVENT_AI_OUTPUT) {
    const runId = transportHeaders[HEADER_RUN_ID] ?? '';
    // Lifecycle repair runs its side effect and returns lead-in events; the
    // descriptor driver always decodes after and its output is appended.
    // The `kind` comes off the wire, so the policy lookup must be own-property
    // only — a crafted kind such as 'valueOf' or 'toString' would otherwise
    // resolve through Object.prototype and corrupt the decode.
    const onDiscrete = lifecycle?.onDiscrete;
    const repair = onDiscrete !== undefined && Object.hasOwn(onDiscrete, codecKind) ? onDiscrete[codecKind] : undefined;
    const pre = repair?.(runId, { codecHeaders }) ?? [];
    return [...pre, ...outputDecoder.decodeDiscrete(codecKind, codecHeaders, transportHeaders, payload.data)];
  }

  return [];
};

// Only outputs stream: a streamed message under any other wire name (a
// foreign or crafted ai-input stream) must not rebuild through the output
// stream path — its events would be mislabelled as inputs by the
// direction-routing decode. Enforces the invariant the decode cast relies on.
const isOutputStream = (tracker: StreamSequenceState): boolean => tracker.name === EVENT_AI_OUTPUT;

const buildHooks = <TInput extends { kind: string }, TOutput extends { type: string }>(
  outputDecoder: ReturnType<typeof createOutputDescriptorDecoder<TOutput>>,
  inputDecoder: InputDescriptorDecoder<TInput>,
  lifecycle: LifecyclePolicy<TOutput> | undefined,
): DecoderCoreHooks<TInput | TOutput> => ({
  buildStartEvents: (tracker) => {
    if (!isOutputStream(tracker)) return [];
    const runId = tracker.transportHeaders[HEADER_RUN_ID] ?? '';
    const pre = lifecycle?.onStreamStart?.(runId, tracker) ?? [];
    return [...pre, ...outputDecoder.buildStart(tracker)];
  },
  buildDeltaEvents: (tracker, delta) => (isOutputStream(tracker) ? outputDecoder.buildDelta(tracker, delta) : []),
  buildEndEvents: (tracker, closingCodecHeaders) =>
    isOutputStream(tracker) ? outputDecoder.buildEnd(tracker, closingCodecHeaders) : [],
  decodeDiscrete: (payload) => decodeDiscretePayload(payload, outputDecoder, inputDecoder, lifecycle),
});

class DefaultCodecDecoder<TInput extends { kind: string }, TOutput extends { type: string }> implements Decoder<
  TInput,
  TOutput
> {
  private readonly _core: DecoderCore<TInput | TOutput>;

  constructor(core: DecoderCore<TInput | TOutput>) {
    this._core = core;
  }

  decode(message: Ably.InboundMessage): DecodedMessage<TInput, TOutput> {
    const events = this._core.decode(message);
    // A single inbound message carries one wire name (ai-input XOR ai-output), so the
    // name fixes the direction of every event decoded from it. The wire name is the
    // authoritative direction signal — never the event's in-memory shape.
    if (message.name === EVENT_AI_INPUT) {
      // CAST: an ai-input message decodes only to inputs.
      return { inputs: events as TInput[], outputs: [] };
    }
    // CAST: every other message is ai-output — the only other wire name the core decodes
    // (unrecognised names yield no events) — so its events are all outputs.
    return { inputs: [], outputs: events as TOutput[] };
  }
}

// ---------------------------------------------------------------------------
// Table validation
// ---------------------------------------------------------------------------

/**
 * Reserve `literal` in `seen` under a human-readable owner description,
 * throwing if another descriptor already holds it. Dispatch literals must be
 * unique within their namespace — a duplicate would silently route through
 * whichever descriptor registered last.
 * @param seen - The namespace's literal → owner registry, mutated in place.
 * @param literal - The dispatch literal to reserve.
 * @param owner - Human-readable description of the declaring descriptor (used in the error).
 */
const reserve = (seen: Map<string, string>, literal: string, owner: string): void => {
  const holder = seen.get(literal);
  if (holder !== undefined) {
    throw new Ably.ErrorInfo(
      `unable to define codec; dispatch literal '${literal}' is declared by both ${holder} and ${owner}`,
      ErrorCode.InvalidArgument,
      400,
    );
  }
  seen.set(literal, owner);
};

/**
 * Throw when a declared field binds one of the driver-reserved header keys.
 * @param fields - The descriptor's declared header fields.
 * @param owner - Human-readable description of the declaring descriptor (used in the error).
 */
const rejectReservedFieldKeys = (fields: readonly HeaderField<unknown>[], owner: string): void => {
  for (const field of fields) {
    if (field.key === KIND_HEADER || field.key === PART_TYPE_HEADER) {
      throw new Ably.ErrorInfo(
        `unable to define codec; ${owner} binds the driver-reserved header key '${field.key}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }
};

/**
 * Fail-fast validation of the assembled descriptor tables, run once per
 * `defineCodec` call. Catches author mistakes the drivers would otherwise
 * surface as silent last-wins routing or encode/decode asymmetry:
 *
 * - duplicate wire `kind`s (discrete event types + stream group kinds, which
 *   drive decode dispatch);
 * - duplicate encode-dispatch chunk types — a stream delta/end phase, a discrete
 *   event, or a dropped type must each be described by exactly one descriptor. A
 *   stream `start` chunk type is exempt: it may be shared across groups
 *   (resolved by `start.match`) and may double as a discrete event/drop (its
 *   decline target); its only forbidden overlap is being another group's
 *   delta/end phase;
 * - duplicate input `kind`s and duplicate `partType`s within a batch;
 * - field bindings on the driver-reserved `kind` / `partType` header keys.
 * @param outputs - The assembled output descriptor table.
 * @param inputs - The assembled input descriptor table.
 */
const validateTables = <TInput, TOutput>(
  outputs: readonly OutputDescriptor<TOutput>[],
  inputs: readonly InputDescriptor<TInput>[],
): void => {
  const wireKinds = new Map<string, string>();
  // Encode dispatch. A chunk `type` is described by exactly one descriptor, with
  // one deliberate exception: a stream `start` chunk type may be **shared**
  // across groups (the encoder resolves it at encode time by each group's
  // `start.match`) and may also back a discrete `event`/`drop` — a start whose
  // discriminators all decline falls through to discrete dispatch. So starts
  // are collected apart from the singly-described chunk types — a stream delta/end
  // phase, a discrete event, a dropped type — which must each be described by
  // exactly one descriptor. The one overlap a start must NOT have (being
  // another group's delta/end, which the start-first dispatch would shadow)
  // is checked after the loop.
  const soleChunkTypes = new Map<string, { owner: string; isDeltaOrEnd: boolean }>();
  const startChunkTypes = new Map<string, string>();
  const reserveSoleChunkType = (literal: string, owner: string, { isDeltaOrEnd }: { isDeltaOrEnd: boolean }): void => {
    const holder = soleChunkTypes.get(literal);
    if (holder !== undefined) {
      throw new Ably.ErrorInfo(
        `unable to define codec; dispatch literal '${literal}' is declared by both ${holder.owner} and ${owner}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    soleChunkTypes.set(literal, { owner, isDeltaOrEnd });
  };

  for (const descriptor of outputs) {
    if (descriptor.construct === 'event') {
      const owner = `output event '${descriptor.type}'`;
      reserveSoleChunkType(descriptor.type, owner, { isDeltaOrEnd: false });
      reserve(wireKinds, descriptor.type, owner);
      rejectReservedFieldKeys(descriptor.fields, owner);
    } else if (descriptor.construct === 'stream') {
      const owner = `output stream '${descriptor.kind}'`;
      reserve(wireKinds, descriptor.kind, owner);

      // A start is not reserved for exclusive ownership (shared / decline-target
      // overlaps are legal); its one illegal overlap is checked below.
      startChunkTypes.set(descriptor.start.type, owner);

      reserveSoleChunkType(descriptor.delta.type, owner, { isDeltaOrEnd: true });
      reserveSoleChunkType(descriptor.end.type, owner, { isDeltaOrEnd: true });
      rejectReservedFieldKeys(descriptor.fields, owner);
    } else {
      // A dropped type produces no wire output; reserving it as singly-described
      // catches an author both handling and dropping the same type.
      reserveSoleChunkType(descriptor.type, `dropped output '${descriptor.type}'`, { isDeltaOrEnd: false });
    }
  }

  // A stream start that is also some group's delta/end phase would never route
  // to that delta/end (the encoder tries the start path first), so forbid it.
  // Overlap with a discrete event/drop (a decline target) is legal and skipped.
  for (const [start, startOwner] of startChunkTypes) {
    const holder = soleChunkTypes.get(start);
    if (holder?.isDeltaOrEnd === true) {
      throw new Ably.ErrorInfo(
        `unable to define codec; stream start '${start}' (${startOwner}) collides with the delta/end phase of ${holder.owner}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }

  const inputKinds = new Map<string, string>();
  for (const descriptor of inputs) {
    const owner = `input ${descriptor.construct} '${descriptor.kind}'`;
    reserve(inputKinds, descriptor.kind, owner);
    if (descriptor.construct === 'event') {
      rejectReservedFieldKeys(descriptor.fields, owner);
    } else {
      const partTypes = new Map<string, string>();
      for (const part of descriptor.parts) {
        const partOwner = `${owner} part '${part.partType}'`;
        reserve(partTypes, part.partType, partOwner);
        rejectReservedFieldKeys(part.fields, partOwner);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Assemble a fully-formed {@link WireCodec} from a codec's parts. Curried on
 * the input/output unions — a caller writes `defineCodec<TInput, TOutput>()({
 * ... })`.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @returns A function taking the codec's parts and returning the assembled codec.
 */
export const defineCodec =
  <TInput extends { kind: string }, TOutput extends { type: string }>() =>
  (config: DefineCodecConfig<TInput, TOutput>): WireCodec<TInput, TOutput> => {
    const { decoderSynthesiseLifecycle } = config;
    // Build the direction-scoped builders, hand them to the codec's table
    // functions, and collect the descriptor arrays the drivers consume.
    const outputs = config.output(outputBuilder<TOutput>());
    const inputs = config.input(inputBuilder<TInput>());
    validateTables(outputs, inputs);
    // The descriptor drivers are pure functions of the (fixed) tables — build
    // them once here and share them across every encoder/decoder instance.
    const outputEncoder = createOutputDescriptorEncoder(outputs, EVENT_AI_OUTPUT);
    const inputEncoder = createInputDescriptorEncoder(inputs, EVENT_AI_INPUT);
    const outputDecoder = createOutputDescriptorDecoder(outputs);
    const inputDecoder = createInputDescriptorDecoder(inputs);
    return {
      createEncoder: (writer, options = {}) => new DefaultCodecEncoder(writer, options, outputEncoder, inputEncoder),
      createDecoder: () =>
        new DefaultCodecDecoder<TInput, TOutput>(
          // The lifecycle policy (and its tracker) stays per-decoder: each
          // decoder instance gets independent per-run phase state.
          createDecoderCore(buildHooks(outputDecoder, inputDecoder, decoderSynthesiseLifecycle?.())),
        ),
    };
  };
