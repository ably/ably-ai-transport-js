/**
 * Declarative output descriptors — the single source of truth for a codec's
 * `ai-output` wire mapping, the output-side sibling of {@link import('./input-descriptors.js')}.
 *
 * A codec declares each ordinary output event once, as a descriptor built on the
 * typed header-field bindings ({@link HeaderField}). The generic encode/decode
 * drivers consume the descriptor set, so adding an ordinary event is one
 * descriptor entry instead of three hand-synchronised switch arms (encoder,
 * decoder, stream reconstruction).
 *
 * Authoring is cast-free: the {@link outputBuilder} factory hands the codec an
 * `{ event, stream }` pair curried on the codec's output union, so every `data` /
 * `encode` / `decode` callback receives the exact narrowed member. The descriptors
 * are then erased to a heterogeneous {@link OutputDescriptor} via a single
 * documented cast at each constructor boundary — never in author code.
 */

import type * as Ably from 'ably';

import { wildcardMatcher } from './field-bag.js';
import type { DataCodec, FieldFor, HeaderField } from './fields.js';
import type { MessagePayload, StreamPayload, WriteOptions } from './types.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** The string-valued keys of `C` — the only keys `streamId.field`/`deltaField` may name. */
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
export interface OutputEncodeHatchContext<C> {
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
export interface OutputDecodeContext {
  /** The codec `kind` header value the message dispatched on (mirrors the input context's `codecKind`). */
  codecKind: string;
  /** The inbound codec-tier headers. */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers. */
  transportHeaders: Record<string, string>;
  /** The inbound message data. */
  data: unknown;
}

/** Context passed to a stream descriptor's `decodeEnd` escape hatch. */
export interface OutputStreamEndContext {
  /** The stream identifier (e.g. chunk id, toolCallId). */
  streamId: string;
  /** The full accumulated stream text. */
  accumulated: string;
  /** The stream's persistent (start) codec headers. */
  codecHeaders: Record<string, string>;
  /** The codec headers carried on close (may differ from the start headers). */
  closingCodecHeaders: Record<string, string>;
}

/** Context passed to a stream descriptor's `decodeDelta` escape hatch. */
export interface OutputStreamDeltaContext {
  /** The opaque transport stream id (the `stream-id` header) — never parsed for routing. */
  streamId: string;
  /** This delta's appended text fragment. */
  delta: string;
  /** The stream's persistent (start) codec headers, re-stamped on every append. */
  codecHeaders: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Data codec
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Author-facing specs (narrowed)
// ---------------------------------------------------------------------------

/**
 * A discrete (non-streaming) output event descriptor spec, narrowed to chunk member `C`.
 * @template C - The narrowed chunk member.
 */
export interface OutputEventSpec<C> {
  /**
   * Declared header fields, written on encode and read on decode. Each field's
   * key names both the wire header and the chunk property it carries (see
   * {@link FieldFor}). Omit for a header-less event.
   */
  fields?: readonly FieldFor<C>[];
  /** Wire `data` codec. Omit when the event carries no data (`data: ''`). */
  data?: DataCodec<C>;
  /** Whether the publish is ephemeral (not persisted). Default false. */
  ephemeral?: (chunk: C) => boolean;
  /** Escape-hatch encode — overrides the default discrete publish. */
  encode?: (chunk: C, core: EscapeHatchCore, ctx: OutputEncodeHatchContext<C>) => Promise<void>;
}

/**
 * A streamed-family descriptor spec. `start`/`delta`/`end` are the domain chunk
 * `type` literals; the family id (the {@link OutputBuilder.stream} first argument)
 * is the wire `kind` header all three phases stamp.
 * @template U - The codec's event union.
 * @template S - The start chunk `type` literal.
 * @template D - The delta chunk `type` literal.
 * @template E - The end chunk `type` literal.
 */
export interface OutputStreamSpec<
  U extends { type: string },
  S extends U['type'],
  D extends U['type'],
  E extends U['type'],
> {
  /** The start chunk `type` literal. */
  start: S;
  /** The delta chunk `type` literal. */
  delta: D;
  /** The end chunk `type` literal. */
  end: E;
  /**
   * How the transport stream id (the Ably `stream-id` header) is derived, on
   * encode. `{ field }` names a single top-level string key present on all three
   * phases; a function derives the id from the chunk — to compose several fields
   * (`item_id + content_index`) or relocate (read a different place per phase).
   * Either way the id is an opaque uniqueness handle for the wire message — never
   * parsed by the reducer, which recovers a chunk's real fields via {@link fields}
   * / {@link deltaFields}. An extractor may throw (e.g. an `Ably.ErrorInfo`) to
   * reject a chunk whose id it cannot derive; the throw surfaces from the encode call.
   */
  streamId:
    | { field: StringKeyOf<ResolveType<U, S>> & StringKeyOf<ResolveType<U, D>> & StringKeyOf<ResolveType<U, E>> }
    | ((chunk: ResolveType<U, S> | ResolveType<U, D> | ResolveType<U, E>) => string);
  /** The string-valued delta chunk key carrying the appended fragment. */
  deltaField: StringKeyOf<ResolveType<U, D>>;
  /**
   * Declared header fields written/read on the start and end chunks. Each
   * field's key names both the wire header and the chunk property (see
   * {@link FieldFor}); a field may bind a property carried by either phase.
   */
  fields: readonly (FieldFor<ResolveType<U, S>> | FieldFor<ResolveType<U, E>>)[];
  /**
   * The header fields the *delta* chunk carries — its own field set, distinct
   * from the start/end {@link fields} (e.g. a `content_part.added` start carries
   * `part`, but the real text delta does not). Their values are stream-invariant
   * coordinates (`item_id`, `content_index`) re-stamped on every append, so the
   * decoder reconstructs each delta from them. Omit when the delta needs no
   * fields beyond {@link deltaField}, or when {@link decodeDelta} takes over.
   */
  deltaFields?: readonly FieldFor<ResolveType<U, D>>[];
  /**
   * Payload discriminator resolving a *shared* start event to this family. When
   * more than one family shares a `start` type (e.g. several part kinds opened by
   * one `content_part.added`), the encoder starts the first family whose
   * `startWhen` returns true. Default: always true — an unshared start. When no
   * family's `startWhen` matches a chunk of a shared start type, the chunk is not
   * a stream start: the encoder falls through to the discrete `event()` descriptor
   * for that type (`stream()` publishes nothing).
   */
  startWhen?: (chunk: ResolveType<U, S>) => boolean;
  /** Escape-hatch override for the stream-close step only (e.g. close-or-discrete fallback). */
  onEnd?: (
    chunk: ResolveType<U, E>,
    core: EscapeHatchCore,
    ctx: OutputEncodeHatchContext<ResolveType<U, E>>,
  ) => Promise<void>;
  /**
   * Escape-hatch override for the delta-chunk rebuild — for a delta whose real
   * fields can't be read straight from a header key (e.g. a value nested inside
   * a carried envelope). Receives the transport stream id, the fragment, and the
   * re-stamped start headers. Takes precedence over {@link deltaFields}.
   */
  decodeDelta?: (ctx: OutputStreamDeltaContext) => ResolveType<U, D>[];
  /** Escape-hatch override for the end-chunk rebuild (e.g. input from accumulated text). */
  decodeEnd?: (ctx: OutputStreamEndContext) => ResolveType<U, E>[];
  /**
   * Escape-hatch decode for when the family arrives as a discrete (non-streamed)
   * message — the wire `kind` equals the family id but the wire wasn't streamed
   * (e.g. history compaction). Reconstructs the start/end chunk pair.
   */
  decodeDiscrete?: (ctx: OutputDecodeContext) => ResolveType<U, S | E>[];
}

// ---------------------------------------------------------------------------
// Erased descriptor (heterogeneous array element)
// ---------------------------------------------------------------------------

/** A discrete output event descriptor erased to the codec's union `U`. */
export interface OutputEventDescriptor<U> {
  /** Discriminator — the construct this descriptor was built with. */
  construct: 'event';
  /** The dispatch `type` literal (or wildcard sentinel), stamped as the wire `kind` header. */
  type: string;
  /** Declared header fields. */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec, if any. */
  data?: DataCodec<U>;
  /** Ephemeral predicate, if any. */
  ephemeral?: (chunk: U) => boolean;
  /** Wildcard dispatch predicate (both directions), derived by the builder from a `-*` type literal. */
  match?: (type: string) => boolean;
  /** Escape-hatch encode, if any. */
  encode?: (chunk: U, core: EscapeHatchCore, ctx: OutputEncodeHatchContext<U>) => Promise<void>;
}

/** A streamed-family descriptor erased to the codec's union `U`. */
export interface OutputStreamDescriptor<U> {
  /** Discriminator — the construct this descriptor was built with. */
  construct: 'stream';
  /** The stream family id, stamped as the wire `kind` header on every phase. */
  kind: string;
  /** The start chunk `type`. */
  start: string;
  /** The delta chunk `type`. */
  delta: string;
  /** The end chunk `type`. */
  end: string;
  /** How the transport stream id is derived — a `{ field }` naming a top-level string key, or an extractor. */
  streamId: { field: string } | ((chunk: U) => string);
  /** The delta chunk key carrying the appended fragment. */
  deltaField: string;
  /** Declared header fields (start/end). */
  fields: readonly HeaderField<unknown>[];
  /** Declared header fields the delta chunk carries, if any. */
  deltaFields?: readonly HeaderField<unknown>[];
  /** Payload discriminator resolving a shared start event to this family, if any. */
  startWhen?: (chunk: U) => boolean;
  /** Escape-hatch close override, if any. */
  onEnd?: (chunk: U, core: EscapeHatchCore, ctx: OutputEncodeHatchContext<U>) => Promise<void>;
  /** Escape-hatch delta-rebuild override, if any. */
  decodeDelta?: (ctx: OutputStreamDeltaContext) => U[];
  /** Escape-hatch end-rebuild override, if any. */
  decodeEnd?: (ctx: OutputStreamEndContext) => U[];
  /** Escape-hatch non-streamed decode, if any. */
  decodeDiscrete?: (ctx: OutputDecodeContext) => U[];
}

/** An erased output descriptor — a discrete event or a streamed family. */
export type OutputDescriptor<U> = OutputEventDescriptor<U> | OutputStreamDescriptor<U>;

// ---------------------------------------------------------------------------
// Builder factory
// ---------------------------------------------------------------------------

/**
 * The direction-scoped output builder `defineCodec` injects into the `output`
 * config function — `event` (single discrete) and `stream` (streamed family),
 * both curried on the codec's output union so author entries narrow cast-free.
 * @template U - The codec's output union.
 */
export interface OutputBuilder<U extends { type: string }> {
  /**
   * Declare a single discrete output event. Curried on the output union; narrows
   * `spec` to the member the `type` literal selects. The `type` literal is stamped
   * as the wire `kind` dispatch header.
   * @param type - The event's `type` literal (or a `*-*` wildcard); stamped as the wire `kind` header.
   * @param spec - The narrowed output event spec. Omit for a header-less event with no data.
   * @returns An erased {@link OutputDescriptor}.
   */
  event: <T extends U['type'] | `${string}-*`>(
    type: T,
    spec?: OutputEventSpec<ResolveType<U, T>>,
  ) => OutputDescriptor<U>;
  /**
   * Declare a streamed output family (start / delta / end). `start`/`delta`/`end`
   * are domain chunk `type` literals; the first argument is the family id, stamped
   * as the wire `kind` dispatch header on every phase.
   * @param kind - The stream family id, stamped as the wire `kind` header on every phase.
   * @param spec - The narrowed stream spec.
   * @returns An erased {@link OutputDescriptor}.
   */
  stream: <S extends U['type'], D extends U['type'], E extends U['type']>(
    kind: string,
    spec: OutputStreamSpec<U, S, D, E>,
  ) => OutputDescriptor<U>;
}

/**
 * Build the curried `{ event, stream }` output builder for a codec's output union.
 * `defineCodec` calls this once and hands the result to the `output` config
 * function; mirrors the input side's {@link import('./input-descriptors.js').inputBuilder}.
 * @template U - The codec's output union.
 * @returns The direction-scoped {@link OutputBuilder}.
 */
export const outputBuilder = <U extends { type: string }>(): OutputBuilder<U> => ({
  event: (type, spec) =>
    // CAST: `spec` is narrowed to the member selected by `type`; the descriptor
    // erases that to the codec's union `U` so heterogeneous descriptors share one
    // array type. The drivers only ever invoke a descriptor's callbacks with the
    // matching member, so the erasure is sound by construction. `fields` defaults
    // to `[]` so a header-less event needs no spec (mirrors the input `event` builder).
    ({
      construct: 'event',
      type,
      fields: spec?.fields ?? [],
      data: spec?.data,
      ephemeral: spec?.ephemeral,
      // A `-*` literal declares a wildcard family; the dispatch predicate is
      // derived from the literal so the two can never disagree (see wildcardMatcher).
      match: wildcardMatcher(type),
      encode: spec?.encode,
    }) as unknown as OutputDescriptor<U>,
  stream: (kind, spec) =>
    // CAST: see `event` — the narrowed stream spec erases to `OutputDescriptor<U>`.
    ({ construct: 'stream', kind, ...spec }) as unknown as OutputDescriptor<U>,
});
