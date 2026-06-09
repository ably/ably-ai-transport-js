/**
 * Declarative event descriptors — the single source of truth for a codec's
 * regular event families.
 *
 * A codec declares each ordinary event once, as a descriptor built on the
 * typed header-field bindings ({@link HeaderField}). The generic encode/decode
 * drivers consume the descriptor set, so adding an ordinary event is one
 * descriptor entry instead of three hand-synchronised switch arms (encoder,
 * decoder, stream reconstruction).
 *
 * Authoring is cast-free: the curried {@link defineEvent} / {@link defineStream}
 * helpers take the codec's event union as their first type argument and infer
 * the **narrowed** member from the literal `type`/family, so every `data` /
 * `encode` / `decode` callback receives the exact chunk member. The descriptors
 * are then erased to a heterogeneous `Descriptor<U>` array via a single
 * documented cast at the constructor boundary — never in author code.
 */

import type * as Ably from 'ably';

import type { HeaderField } from './fields.js';
import type { MessagePayload, StreamPayload, WriteOptions } from './types.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** The string-valued keys of `C` — the only keys `idField`/`deltaField` may name. */
export type StringKeyOf<C> = { [K in keyof C]-?: C[K] extends string ? K : never }[keyof C];

/**
 * Resolve the union member a descriptor `type` literal selects. An exact match
 * wins; a wildcard literal (`'data-*'`) resolves to the template member
 * (`data-${string}`), so wildcard descriptors still narrow to the real member.
 */
export type ResolveType<U extends { type: string }, T extends string> =
  Extract<U, { type: T }> extends never
    ? T extends `${infer P}-*`
      ? Extract<U, { type: `${P}-${string}` }>
      : never
    : Extract<U, { type: T }>;

// ---------------------------------------------------------------------------
// Escape-hatch core surface
// ---------------------------------------------------------------------------

/**
 * The narrowed view of the encoder core that escape-hatch `encode` functions
 * receive — only the publish/stream operations a hatch legitimately needs. The
 * full internal `EncoderCore` satisfies this structurally.
 */
export interface EscapeHatchCore {
  /** Publish a single discrete message. */
  publishDiscrete(payload: MessagePayload, opts?: WriteOptions): Promise<Ably.PublishResult>;
  /** Start a streamed message. */
  startStream(streamId: string, payload: StreamPayload, opts?: WriteOptions): Promise<void>;
  /** Append a fragment to an in-flight stream (fire-and-forget). */
  appendStream(streamId: string, data: string): void;
  /** Close a streamed message. */
  closeStream(streamId: string, payload: StreamPayload): Promise<void>;
  /** Cancel all in-progress streams. */
  cancelAllStreams(opts?: WriteOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Header builder + contexts
// ---------------------------------------------------------------------------

/**
 * Builds a codec headers record from a chunk through the descriptor's declared
 * fields, stamping the dispatch `type` plus each field read off `chunk`. An
 * optional `keys` subset restricts which declared fields are written; the keys
 * are checked against the chunk so the imperative path can't drift.
 * @template C - The narrowed chunk member.
 */
export type HeaderBuilder<C> = <K extends keyof C & string>(chunk: C, keys?: readonly K[]) => Record<string, string>;

/**
 * Context passed to an escape-hatch `encode` function.
 * @template C - The narrowed chunk member.
 */
export interface EncodeCtx<C> {
  /** Header builder bound to the descriptor's declared fields. */
  h: HeaderBuilder<C>;
  /** The wire message name for this direction (`ai-output` / `ai-input`). */
  name: string;
  /** The encoder's configured fallback message id, if any. */
  messageId: string | undefined;
  /** Per-write overrides to thread into the hatch's publish/cancel calls. */
  opts: WriteOptions | undefined;
}

/** Context passed to a discrete escape-hatch `decode` function. */
export interface DecodeCtx {
  /** The inbound codec-tier headers. */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers. */
  transportHeaders: Record<string, string>;
  /** The inbound message data. */
  data: unknown;
}

/** Context passed to a stream descriptor's `decodeEnd` escape hatch. */
export interface StreamEndCtx {
  /** The stream identifier (e.g. chunk id, toolCallId). */
  streamId: string;
  /** The full accumulated stream text. */
  accumulated: string;
  /** The stream's persistent (start) codec headers. */
  codecHeaders: Record<string, string>;
  /** The codec headers carried on close (may differ from the start headers). */
  closingCodecHeaders: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Data codec
// ---------------------------------------------------------------------------

/**
 * Symmetric codec for a descriptor's wire `data`. Many wire payloads are object
 * envelopes a decode reads several chunk props out of (e.g. `{ errorText, input }`),
 * so a single field can't model them. `encode` produces the wire data from the
 * chunk; `decode` returns the chunk props the envelope contributes, merged into
 * the rebuilt chunk by the driver.
 * @template C - The narrowed chunk member.
 */
export interface DataCodec<C> {
  /** Produce the wire `data` from the chunk. */
  encode: (chunk: C) => unknown;
  /** Extract the chunk props this envelope contributes from the wire `data`. */
  decode: (data: unknown) => Partial<C>;
}

// ---------------------------------------------------------------------------
// Author-facing specs (narrowed)
// ---------------------------------------------------------------------------

/**
 * A discrete (non-streaming) event descriptor spec, narrowed to chunk member `C`.
 * @template C - The narrowed chunk member.
 */
export interface DiscreteSpec<C> {
  /** Declared header fields, written on encode and read on decode by key. */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec. Omit when the event carries no data (`data: ''`). */
  data?: DataCodec<C>;
  /** Whether the publish is ephemeral (not persisted). Default false. */
  ephemeral?: (chunk: C) => boolean;
  /** Decode-dispatch predicate for wildcard types (e.g. `data-*`). Default exact `type` match. */
  matchType?: (type: string) => boolean;
  /** Escape-hatch encode — overrides the default discrete publish. */
  encode?: (chunk: C, core: EscapeHatchCore, ctx: EncodeCtx<C>) => Promise<void>;
  /** Escape-hatch decode — overrides the default field-bag rebuild. */
  decode?: (ctx: DecodeCtx) => C[];
}

/**
 * A streamed-family descriptor spec. `start`/`delta`/`end` are the domain chunk
 * `type` literals; the family id (the {@link defineStream} first argument) is the
 * codec `type` header all three phases stamp.
 * @template U - The codec's event union.
 * @template S - The start chunk `type` literal.
 * @template D - The delta chunk `type` literal.
 * @template E - The end chunk `type` literal.
 */
export interface StreamSpec<U extends { type: string }, S extends U['type'], D extends U['type'], E extends U['type']> {
  /** The start chunk `type` literal. */
  start: S;
  /** The delta chunk `type` literal. */
  delta: D;
  /** The end chunk `type` literal. */
  end: E;
  /** The string-valued chunk key carrying the stream id (e.g. `id`, `toolCallId`). */
  idField: StringKeyOf<ResolveType<U, S>> & StringKeyOf<ResolveType<U, D>> & StringKeyOf<ResolveType<U, E>>;
  /** The string-valued delta chunk key carrying the appended fragment. */
  deltaField: StringKeyOf<ResolveType<U, D>>;
  /** Declared header fields written/read on start and end. */
  fields: readonly HeaderField<unknown>[];
  /** Escape-hatch override for the stream-close step only (e.g. close-or-discrete fallback). */
  onEnd?: (chunk: ResolveType<U, E>, core: EscapeHatchCore, ctx: EncodeCtx<ResolveType<U, E>>) => Promise<void>;
  /** Escape-hatch override for the end-chunk rebuild (e.g. input from accumulated text). */
  decodeEnd?: (ctx: StreamEndCtx) => ResolveType<U, E>[];
  /**
   * Escape-hatch decode for when the family arrives as a discrete (non-streamed)
   * message — codec `type` equals the family id but the wire wasn't streamed
   * (e.g. history compaction). Reconstructs the start/end chunk pair.
   */
  decodeDiscrete?: (ctx: DecodeCtx) => ResolveType<U, S | E>[];
}

// ---------------------------------------------------------------------------
// Erased descriptor (heterogeneous array element)
// ---------------------------------------------------------------------------

/** A discrete descriptor erased to the codec's union `U`. */
export interface EventDescriptor<U> {
  /** Discriminator. */
  kind: 'event';
  /** The dispatch `type` literal (or wildcard sentinel). */
  type: string;
  /** Declared header fields. */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec, if any. */
  data?: DataCodec<U>;
  /** Ephemeral predicate, if any. */
  ephemeral?: (chunk: U) => boolean;
  /** Wildcard decode-dispatch predicate, if any. */
  matchType?: (type: string) => boolean;
  /** Escape-hatch encode, if any. */
  encode?: (chunk: U, core: EscapeHatchCore, ctx: EncodeCtx<U>) => Promise<void>;
  /** Escape-hatch decode, if any. */
  decode?: (ctx: DecodeCtx) => U[];
}

/** A streamed-family descriptor erased to the codec's union `U`. */
export interface StreamDescriptor<U> {
  /** Discriminator. */
  kind: 'stream';
  /** The family id stamped as the codec `type` header for every phase. */
  familyId: string;
  /** The start chunk `type`. */
  start: string;
  /** The delta chunk `type`. */
  delta: string;
  /** The end chunk `type`. */
  end: string;
  /** The chunk key carrying the stream id. */
  idField: string;
  /** The delta chunk key carrying the appended fragment. */
  deltaField: string;
  /** Declared header fields. */
  fields: readonly HeaderField<unknown>[];
  /** Escape-hatch close override, if any. */
  onEnd?: (chunk: U, core: EscapeHatchCore, ctx: EncodeCtx<U>) => Promise<void>;
  /** Escape-hatch end-rebuild override, if any. */
  decodeEnd?: (ctx: StreamEndCtx) => U[];
  /** Escape-hatch non-streamed decode, if any. */
  decodeDiscrete?: (ctx: DecodeCtx) => U[];
}

/** An erased descriptor — a discrete event or a streamed family. */
export type Descriptor<U> = EventDescriptor<U> | StreamDescriptor<U>;

// ---------------------------------------------------------------------------
// Curried constructors
// ---------------------------------------------------------------------------

/**
 * Define a discrete event descriptor. Curried: supply the codec's event union as
 * the first type argument, then call with the `type` literal and its narrowed spec.
 * @template U - The codec's event union.
 * @returns A function taking `(type, spec)` and returning an erased descriptor.
 */
export const defineEvent =
  <U extends { type: string }>() =>
  <T extends U['type'] | `${string}-*`>(type: T, spec: DiscreteSpec<ResolveType<U, T>>): Descriptor<U> =>
    // CAST: `spec` is narrowed to the member selected by `type`; the descriptor
    // erases that to the codec's union `U` so heterogeneous descriptors share one
    // array type. The drivers only ever invoke a descriptor's callbacks with the
    // matching member, so the erasure is sound by construction.
    ({ kind: 'event', type, ...spec }) as unknown as Descriptor<U>;

/**
 * Define a streamed-family descriptor. Curried like {@link defineEvent}; `start`/
 * `delta`/`end` are domain chunk `type` literals and `familyId` is the codec
 * `type` header every phase stamps.
 * @template U - The codec's event union.
 * @returns A function taking `(familyId, spec)` and returning an erased descriptor.
 */
export const defineStream =
  <U extends { type: string }>() =>
  <S extends U['type'], D extends U['type'], E extends U['type']>(
    familyId: string,
    spec: StreamSpec<U, S, D, E>,
  ): Descriptor<U> =>
    // CAST: see defineEvent — the narrowed stream spec erases to `Descriptor<U>`.
    ({ kind: 'stream', familyId, ...spec }) as unknown as Descriptor<U>;
