/**
 * `defineCodec` — composition packaging for a codec.
 *
 * A codec author supplies only its **parts** — a reducer, a per-direction
 * descriptor table (the `output` and `input` builder functions), an optional
 * decode lifecycle policy, and an optional agent identifier — and `defineCodec`
 * assembles a fully-formed {@link Codec}: the generic encoder/decoder skeletons
 * (built here, codec-agnostic), the reducer methods, and the well-known input
 * factories (merged internally).
 *
 * Both directions are declarative descriptor tables driven by the generic
 * encode/decode drivers. `defineCodec` hands each table a direction-scoped
 * builder typed to that direction's union — `{ event, stream }` for outputs,
 * `{ event, batch }` for inputs — so each construct's spec stays type-correct
 * per direction under shared construct names, with no per-entry casts. Both
 * sides build/read wire headers through the same shared field bindings, so
 * encode and decode cannot drift.
 */

import * as Ably from 'ably';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_RUN_ID } from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from './decoder.js';
import { createDecoderCore } from './decoder.js';
import type { EncoderCore, EncoderCoreOptions } from './encoder.js';
import { createEncoderCore } from './encoder.js';
import { KIND_HEADER, PART_TYPE_HEADER } from './field-bag.js';
import type { HeaderField } from './fields.js';
import { createInputDescriptorDecoder, type InputDescriptorDecoder } from './input-descriptor-decoder.js';
import { createInputDescriptorEncoder, type InputDescriptorEncoder } from './input-descriptor-encoder.js';
import { type InputBuilder, inputBuilder, type InputDescriptor } from './input-descriptors.js';
import { createOutputDescriptorDecoder } from './output-descriptor-decoder.js';
import { createOutputDescriptorEncoder, type OutputDescriptorEncoder } from './output-descriptor-encoder.js';
import {
  type EscapeHatchCore,
  type OutputBuilder,
  outputBuilder,
  type OutputDescriptor,
} from './output-descriptors.js';
import type {
  ChannelWriter,
  Codec,
  CodecEvent,
  CodecInputEvent,
  CodecMessage,
  CodecOutputEvent,
  DecodedMessage,
  Decoder,
  Encoder,
  MessagePayload,
  ReducerMeta,
  StreamTrackerState,
  WriteOptions,
} from './types.js';
import { type WellKnownInputFactories, wellKnownInputs } from './well-known-inputs.js';

// Re-exported so codec descriptor tables (e.g. the Vercel `inputs.ts` / `outputs.ts`)
// can type their builder parameter without reaching into the descriptor modules directly.
export type { InputBuilder } from './input-descriptors.js';
export type { OutputBuilder } from './output-descriptors.js';

// ---------------------------------------------------------------------------
// Input driver core surface
// ---------------------------------------------------------------------------

/**
 * The encoder-core view the input encode driver (and an input event's escape-hatch
 * `encode`) receives: the escape-hatch publish/stream operations plus
 * `publishDiscreteBatch` for the multi-part batch fan-out (not on the output
 * {@link EscapeHatchCore}). The concrete {@link EncoderCore} satisfies this structurally.
 */
export type InputEncoderCore = EscapeHatchCore & {
  /** Publish multiple discrete messages atomically (the batch fan-out). */
  publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult>;
};

/** Per-write context passed to the input encode driver. */
export interface InputEncodeContext {
  /** Per-write overrides (the wire codec-message-id is stamped here by the client session). */
  opts: WriteOptions | undefined;
}

/** Context passed to an input descriptor's escape-hatch `decode` for one inbound `ai-input` message. */
export interface InputDecodeContext {
  /** The codec `kind` header value (the input descriptor's dispatch key). */
  codecKind: string;
  /** The inbound message data. */
  data: unknown;
  /** The inbound codec-tier headers. */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers (role, codec-message-id, discrete marker). */
  transportHeaders: Record<string, string>;
}

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
  onStreamStart?: (runId: string, tracker: StreamTrackerState) => TOutput[];
}

// ---------------------------------------------------------------------------
// defineCodec config + result
// ---------------------------------------------------------------------------

/**
 * The reducer parts a codec supplies. `TProjection` and `TMessage` infer from
 * these, so `defineCodec` callers need not spell them out.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TProjection - The per-node projection the reducer folds into.
 * @template TMessage - The per-message domain type.
 */
export interface CodecReducer<TInput, TOutput, TProjection, TMessage> {
  /** Build an empty projection for a node. */
  init: () => TProjection;
  /** Fold one direction-tagged input or output event into the projection. */
  fold: (state: TProjection, event: CodecEvent<TInput, TOutput>, meta: ReducerMeta) => TProjection;
  /** Extract the per-message list (each paired with its codec-message-id). */
  getMessages: (projection: TProjection) => CodecMessage<TMessage>[];
}

/**
 * The parts a codec supplies to {@link defineCodec}.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @template TProjection - The per-node projection the reducer folds into.
 * @template TMessage - The per-message domain type.
 */
export interface DefineCodecConfig<
  TInput extends { kind: string },
  TOutput extends { type: string },
  TProjection,
  TMessage,
> {
  /** Optional Ably-Agent identifier registered on the channel; omit to opt out. */
  adapterTag?: string;
  /** Reducer parts; `TProjection` / `TMessage` infer from here. */
  reducer: CodecReducer<TInput, TOutput, TProjection, TMessage>;
  /**
   * The declarative output (`ai-output`) descriptor table, returned from the
   * injected `{ event, stream }` builder (both curried on `TOutput`).
   */
  output: (b: OutputBuilder<TOutput>) => readonly OutputDescriptor<TOutput>[];
  /**
   * The declarative input (`ai-input`) descriptor table, returned from the
   * injected `{ event, batch }` builder (both curried on `TInput`).
   */
  input: (b: InputBuilder<TInput>) => readonly InputDescriptor<TInput>[];
  /**
   * Factory for a fresh decode lifecycle policy per decoder instance (the
   * policy's closures capture a fresh, per-decoder lifecycle tracker). Omit
   * for a codec with no mid-stream-join repair.
   */
  decodeLifecycle?: () => LifecyclePolicy<TOutput>;
}

/**
 * A codec assembled by {@link defineCodec}: a conforming {@link Codec} whose
 * well-known input factories are typed concretely by {@link WellKnownInputFactories}
 * (so `createToolResult` etc. are callable without a guard). The factory methods
 * are sourced from `WellKnownInputFactories` rather than `Codec` because the
 * former types them against `UserMessageOf<TInput>` / `ToolResultPayloadOf<TInput>`
 * — equal to the codec's `TMessage` / payloads for every real codec, but not
 * provably so to the generic type system. At a concrete call site a
 * `DefinedCodec` is assignable to the corresponding `Codec`.
 */
export type DefinedCodec<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> = Omit<
  Codec<TInput, TOutput, TProjection, TMessage>,
  'createUserMessage' | 'createRegenerate' | 'createToolResult' | 'createToolResultError' | 'createToolApprovalResponse'
> &
  WellKnownInputFactories<TInput>;

// ---------------------------------------------------------------------------
// Generic encoder
// ---------------------------------------------------------------------------

class DefaultCodecEncoder<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> implements Encoder<
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
    outputs: readonly OutputDescriptor<TOutput>[],
    inputs: readonly InputDescriptor<TInput>[],
  ) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
    this._outputEncoder = createOutputDescriptorEncoder(outputs, EVENT_AI_OUTPUT);
    this._inputEncoder = createInputDescriptorEncoder(inputs, EVENT_AI_INPUT);
  }

  async publishInput(input: TInput, options?: WriteOptions): Promise<void> {
    // No `messageId` threads into inputs — user-message parts carry no
    // transport codec-message-id today; inputs rely on opts.messageId stamped
    // by the client session.
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
    const pre = lifecycle?.onDiscrete?.[codecKind]?.(runId, { codecHeaders }) ?? [];
    return [...pre, ...outputDecoder.decodeDiscrete(codecKind, codecHeaders, transportHeaders, payload.data)];
  }

  return [];
};

const buildHooks = <TInput extends { kind: string }, TOutput extends { type: string }>(
  outputs: readonly OutputDescriptor<TOutput>[],
  inputs: readonly InputDescriptor<TInput>[],
  lifecycle: LifecyclePolicy<TOutput> | undefined,
): DecoderCoreHooks<TInput | TOutput> => {
  const outputDecoder = createOutputDescriptorDecoder(outputs);
  const inputDecoder = createInputDescriptorDecoder(inputs);
  return {
    buildStartEvents: (tracker) => {
      const runId = tracker.transportHeaders[HEADER_RUN_ID] ?? '';
      const pre = lifecycle?.onStreamStart?.(runId, tracker) ?? [];
      return [...pre, ...outputDecoder.buildStart(tracker)];
    },
    buildDeltaEvents: (tracker, delta) => outputDecoder.buildDelta(tracker, delta),
    buildEndEvents: (tracker, closingCodecHeaders) => outputDecoder.buildEnd(tracker, closingCodecHeaders),
    decodeDiscrete: (payload) => decodeDiscretePayload(payload, outputDecoder, inputDecoder, lifecycle),
  };
};

class DefaultCodecDecoder<TInput extends CodecInputEvent, TOutput extends CodecOutputEvent> implements Decoder<
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
 * - duplicate dispatch literals within a namespace — the domain chunk `type`
 *   namespace (discrete event types + stream phase types, which drive encode
 *   dispatch) and the wire `kind` namespace (discrete event types + stream
 *   family kinds, which drive decode dispatch);
 * - duplicate input `kind`s and duplicate `partType`s within a batch;
 * - field bindings on the driver-reserved `kind` / `partType` header keys.
 * @param outputs - The assembled output descriptor table.
 * @param inputs - The assembled input descriptor table.
 */
const validateTables = <TInput, TOutput>(
  outputs: readonly OutputDescriptor<TOutput>[],
  inputs: readonly InputDescriptor<TInput>[],
): void => {
  const chunkTypes = new Map<string, string>();
  const wireKinds = new Map<string, string>();
  for (const descriptor of outputs) {
    if (descriptor.construct === 'event') {
      const owner = `output event '${descriptor.type}'`;
      reserve(chunkTypes, descriptor.type, owner);
      reserve(wireKinds, descriptor.type, owner);
      rejectReservedFieldKeys(descriptor.fields, owner);
    } else {
      const owner = `output stream '${descriptor.kind}'`;
      reserve(wireKinds, descriptor.kind, owner);
      for (const phase of [descriptor.start, descriptor.delta, descriptor.end]) {
        reserve(chunkTypes, phase, owner);
      }
      rejectReservedFieldKeys(descriptor.fields, owner);
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
 * Assemble a fully-formed {@link Codec} from a codec's parts. Curried on the
 * input/output unions so `TProjection` / `TMessage` infer from `config.reducer`
 * — a caller writes `defineCodec<TInput, TOutput>()({ ... })` and never spells
 * out the projection or message types.
 * @template TInput - The codec's input union.
 * @template TOutput - The codec's output union.
 * @returns A function taking the codec's parts and returning the assembled codec.
 */
export const defineCodec =
  <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>() =>
  <TProjection, TMessage>(
    config: DefineCodecConfig<TInput, TOutput, TProjection, TMessage>,
  ): DefinedCodec<TInput, TOutput, TProjection, TMessage> => {
    const { reducer, decodeLifecycle } = config;
    // Build the direction-scoped builders, hand them to the codec's table
    // functions, and collect the descriptor arrays the drivers consume.
    const outputs = config.output(outputBuilder<TOutput>());
    const inputs = config.input(inputBuilder<TInput>());
    validateTables(outputs, inputs);
    return {
      // adapterTag is optional on Codec; only set it when supplied so a codec
      // can opt out of Ably-Agent registration.
      ...(config.adapterTag === undefined ? {} : { adapterTag: config.adapterTag }),
      init: reducer.init,
      fold: reducer.fold,
      getMessages: reducer.getMessages,
      createEncoder: (writer, options = {}) => new DefaultCodecEncoder(writer, options, outputs, inputs),
      createDecoder: (options: DecoderCoreOptions = {}) =>
        new DefaultCodecDecoder<TInput, TOutput>(
          createDecoderCore(buildHooks(outputs, inputs, decodeLifecycle?.()), options),
        ),
      ...wellKnownInputs<TInput>(),
    };
  };
