/**
 * `defineCodec` — composition packaging for a codec.
 *
 * A codec author supplies only its **parts** — a reducer, an output descriptor
 * table, an imperative input adapter, an optional decode lifecycle policy, and
 * an optional agent identifier — and `defineCodec` assembles a fully-formed
 * {@link Codec}: the generic encoder/decoder skeletons (built here, codec-agnostic),
 * the reducer methods, and the well-known input factories (merged internally).
 *
 * The split is deliberate: `outputs` is declarative (a {@link Descriptor} array
 * driven by the generic encode/decode drivers), while `inputs` is the complete
 * imperative `{ encode, decode }` adapter — inputs are nested, `kind`-discriminated,
 * never streamed, and dominated by the 1→N user-message fan-out, so a table earns
 * nothing. Both build/read wire headers through the same shared field bindings.
 */

import type * as Ably from 'ably';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT, HEADER_RUN_ID } from '../../constants.js';
import type { DecoderCore, DecoderCoreHooks, DecoderCoreOptions } from './decoder.js';
import { createDecoderCore } from './decoder.js';
import { createDescriptorDecoder } from './descriptor-decoder.js';
import { createDescriptorEncoder, type DescriptorEncoder, KIND_HEADER } from './descriptor-encoder.js';
import type { Descriptor, EscapeHatchCore } from './descriptors.js';
import type { EncoderCore, EncoderCoreOptions } from './encoder.js';
import { createEncoderCore } from './encoder.js';
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

// ---------------------------------------------------------------------------
// Input adapter surface
// ---------------------------------------------------------------------------

/**
 * The encoder-core view an input adapter's `encode` receives: the escape-hatch
 * publish/stream operations plus `publishDiscreteBatch` for the user-message
 * 1→N fan-out (not on the output {@link EscapeHatchCore}). The concrete
 * {@link EncoderCore} satisfies this structurally.
 */
export type InputAdapterCore = EscapeHatchCore & {
  /** Publish multiple discrete messages atomically (the user-message fan-out). */
  publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult>;
};

/** Per-write context passed to an input adapter's `encode`. */
export interface InputEncodeContext {
  /** Per-write overrides (the wire codec-message-id is stamped here by the client session). */
  opts: WriteOptions | undefined;
}

/** Context passed to an input adapter's `decode` for one inbound `ai-input` message. */
export interface InputDecodeContext {
  /** The codec `kind` header value (the input adapter's dispatch key). */
  codecKind: string;
  /** The inbound message data. */
  data: unknown;
  /** The inbound codec-tier headers. */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers (role, codec-message-id, discrete marker). */
  transportHeaders: Record<string, string>;
}

/**
 * The complete imperative input adapter — covers every input `kind`, the
 * user-message fan-out included. Headers are built/read through the codec's
 * shared field bindings so encode and decode cannot drift.
 * @template TInput - The codec's input union.
 */
export interface InputAdapter<TInput> {
  /** Encode and publish one input on the `ai-input` wire. */
  encode(input: TInput, core: InputAdapterCore, ctx: InputEncodeContext): Promise<void>;
  /** Rebuild zero or more inputs from one inbound `ai-input` message. */
  decode(ctx: InputDecodeContext): TInput[];
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
export interface DefineCodecConfig<TInput, TOutput, TProjection, TMessage> {
  /** Optional Ably-Agent identifier registered on the channel; omit to opt out. */
  adapterTag?: string;
  /** Reducer parts; `TProjection` / `TMessage` infer from here. */
  reducer: CodecReducer<TInput, TOutput, TProjection, TMessage>;
  /** The declarative output descriptor table. */
  outputs: readonly Descriptor<TOutput>[];
  /** The complete imperative input adapter. */
  inputs: InputAdapter<TInput>;
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
  private readonly _outputEncoder: DescriptorEncoder<TOutput>;
  private readonly _inputs: InputAdapter<TInput>;

  constructor(
    writer: ChannelWriter,
    options: EncoderCoreOptions,
    outputs: readonly Descriptor<TOutput>[],
    inputs: InputAdapter<TInput>,
  ) {
    this._core = createEncoderCore(writer, options);
    this._messageId = options.messageId;
    this._outputEncoder = createDescriptorEncoder(outputs, EVENT_AI_OUTPUT);
    this._inputs = inputs;
  }

  async publishInput(input: TInput, options?: WriteOptions): Promise<void> {
    // No `messageId` threads into inputs — user-message parts carry no
    // transport codec-message-id today; inputs rely on opts.messageId stamped
    // by the client session.
    await this._inputs.encode(input, this._core, { opts: options });
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

const decodeDiscretePayload = <TInput, TOutput>(
  payload: MessagePayload,
  outputDecoder: ReturnType<typeof createDescriptorDecoder<TOutput & { type: string }>>,
  inputs: InputAdapter<TInput>,
  lifecycle: LifecyclePolicy<TOutput> | undefined,
): (TInput | TOutput)[] => {
  const codecHeaders = payload.codecHeaders ?? {};
  const transportHeaders = payload.transportHeaders ?? {};
  const codecKind = codecHeaders[KIND_HEADER] ?? '';

  if (payload.name === EVENT_AI_INPUT) {
    return inputs.decode({ codecKind, data: payload.data, codecHeaders, transportHeaders });
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

const buildHooks = <TInput, TOutput extends { type: string }>(
  outputs: readonly Descriptor<TOutput>[],
  inputs: InputAdapter<TInput>,
  lifecycle: LifecyclePolicy<TOutput> | undefined,
): DecoderCoreHooks<TInput | TOutput> => {
  const outputDecoder = createDescriptorDecoder(outputs);
  return {
    buildStartEvents: (tracker) => {
      const runId = tracker.transportHeaders[HEADER_RUN_ID] ?? '';
      const pre = lifecycle?.onStreamStart?.(runId, tracker) ?? [];
      return [...pre, ...outputDecoder.buildStart(tracker)];
    },
    buildDeltaEvents: (tracker, delta) => outputDecoder.buildDelta(tracker, delta),
    buildEndEvents: (tracker, closingCodecHeaders) => outputDecoder.buildEnd(tracker, closingCodecHeaders),
    decodeDiscrete: (payload) => decodeDiscretePayload(payload, outputDecoder, inputs, lifecycle),
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
    const { reducer, outputs, inputs, decodeLifecycle } = config;
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
