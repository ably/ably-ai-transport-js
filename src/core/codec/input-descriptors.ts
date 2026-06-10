/**
 * Declarative input descriptors — the single source of truth for a codec's
 * `ai-input` wire mapping, the input-side sibling of {@link import('./descriptors.js')}.
 *
 * Inputs come in two cardinalities: a single domain input ↔ one wire message
 * (the `event` construct), and a single domain message ↔ many atomic wire events
 * (the `batch` construct — the input sibling of the output `stream`). Both are
 * declared once per codec and consumed by the generic input encode/decode
 * drivers, so adding an input is one descriptor entry rather than a pair of
 * hand-synchronised switch arms.
 *
 * Authoring is cast-free: the {@link inputBuilder} factory hands the codec a
 * `{ event, batch }` pair curried on the codec's input union, so every `data` /
 * `fields` / `parts` callback receives the exact narrowed member. The descriptors
 * are then erased to a heterogeneous {@link InputDescriptor} via a single
 * documented cast at each constructor boundary — never in author code.
 */

import type { InputAdapterCore, InputDecodeContext, InputEncodeContext } from './define-codec.js';
import type { DataCodec } from './descriptors.js';
import type { HeaderField } from './fields.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Resolve the input union member a `kind` literal selects. */
export type ResolveInput<U extends { kind: string }, K extends U['kind']> = Extract<U, { kind: K }>;

/**
 * The lens target an input `event` spec's `fields` / `data` operate on: the
 * member's `payload` when `via: 'payload'`, else the member itself. Tool inputs
 * nest their domain data under `payload` and are addressed by codec-message-id;
 * flat inputs (none in Vercel today) read the member directly.
 * @template C - The narrowed input member.
 * @template V - The `via` literal (`'payload'` or `undefined`).
 */
export type Lensed<C, V extends 'payload' | undefined> = V extends 'payload'
  ? C extends { payload: infer P }
    ? P
    : never
  : C;

/**
 * Resolve the part union member a `partType` literal selects, mirroring the
 * output {@link import('./descriptors.js').ResolveType} curry one level down.
 * An exact match wins; a wildcard literal (`data-*`) resolves to the template
 * member (`data-${string}`).
 * @template P - The part union.
 * @template T - The selected `partType` literal (or a `*-*` wildcard).
 */
export type ResolvePart<P extends { type: string }, T extends string> =
  Extract<P, { type: T }> extends never
    ? T extends `${infer Pre}-*`
      ? Extract<P, { type: `${Pre}-${string}` }>
      : never
    : Extract<P, { type: T }>;

// ---------------------------------------------------------------------------
// Author-facing specs (narrowed)
// ---------------------------------------------------------------------------

/**
 * A single-event input descriptor spec, narrowed to input member `C` and lensed
 * by `via`. `fields` and `data` operate on the lens target ({@link Lensed}); on
 * decode the driver rebuilds the `{ kind, codecMessageId, payload }` envelope
 * (for `via: 'payload'`) or the flat `{ kind, ...bag }` shape.
 * @template C - The narrowed input member.
 * @template V - The `via` literal (`'payload'` or `undefined`).
 */
export interface InputEventSpec<C, V extends 'payload' | undefined> {
  /** Lens `fields` / `data` onto `chunk.payload` when `'payload'`; omit to read the member directly. */
  via?: V;
  /** Declared header fields, written on encode and read on decode by key. Omit for none. */
  fields?: readonly HeaderField<unknown>[];
  /** Wire `data` codec over the lens target. Omit when the input carries no data (`data: ''`). */
  data?: DataCodec<Lensed<C, V>>;
  /** Wire-only signal: encode stamps only the `kind` header (empty data, no fields); decode yields `[]`. */
  wireOnly?: boolean;
  /** Escape-hatch encode — overrides the default discrete publish (unused by Vercel, kept for irregular inputs). */
  encode?: (input: C, core: InputAdapterCore, ctx: InputEncodeContext) => Promise<void>;
  /** Escape-hatch decode — overrides the default field-bag rebuild. */
  decode?: (ctx: InputDecodeContext) => C[];
}

/**
 * A per-part wire mapping inside a {@link BatchSpec}, narrowed to part member `Q`.
 * `fields` and `data` operate on the selected part; the batch driver fans the
 * domain message out into one wire event per part and reassembles them in the
 * reducer (merge by codec-message-id).
 * @template Q - The narrowed part member.
 */
export interface PartSpec<Q> {
  /** Declared header fields for this part, written on encode and read on decode. Omit for none. */
  fields?: readonly HeaderField<unknown>[];
  /** Wire `data` codec over the part. Omit when the part carries no data. */
  data?: DataCodec<Q>;
}

/**
 * The curried part sub-builder a {@link BatchSpec.parts} function receives. Mirrors
 * the {@link inputBuilder} `event` curry one level down: `p(partType, spec)`
 * narrows `spec` to the part member the literal selects, and `p.wildcard(pred, spec)`
 * matches a family (e.g. `data-*`) against the template member — both cast-free
 * in author code.
 * @template P - The part union.
 */
export interface PartBuilder<P extends { type: string }> {
  /**
   * Declare an exact-`partType` part. Narrows `spec` to the selected part member.
   * @param partType - The part's `type` literal (the `partType` wire sub-discriminator).
   * @param spec - The narrowed part spec.
   * @returns An erased {@link PartDescriptor}.
   */
  <T extends P['type']>(partType: T, spec: PartSpec<ResolvePart<P, T>>): PartDescriptor;
  /**
   * Declare a wildcard part matched by predicate (e.g. `(t) => t.startsWith('data-')`).
   * @param match - Decode-dispatch predicate over the inbound `partType`.
   * @param spec - The narrowed part spec (the template family member).
   * @returns An erased {@link PartDescriptor}.
   */
  wildcard<T extends `${string}-*`>(
    match: (partType: string) => boolean,
    spec: PartSpec<ResolvePart<P, T>>,
  ): PartDescriptor;
}

/**
 * Per-message wire headers a {@link BatchSpec.messageHeaders} stamps on every
 * part of one batch. These carry metadata that belongs to the whole message
 * rather than an individual part (e.g. the message id as a codec header, the
 * sender role as a transport header), so the decode side can reconstruct the
 * shared message envelope from any single part. Both tiers are optional.
 */
export interface BatchMessageHeaders {
  /** Codec-tier headers stamped on every part (e.g. a per-message id). */
  codecHeaders?: Record<string, string>;
  /** Transport-tier headers stamped on every part (e.g. the sender role). */
  transportHeaders?: Record<string, string>;
}

/**
 * The context a {@link BatchSpec.assemble} receives alongside one decoded part:
 * the inbound header tiers of the wire event the part was decoded from. A batch
 * fans out into N independent wire events, so each part arrives carrying the
 * shared per-message headers ({@link BatchMessageHeaders}); `assemble` reads them
 * to rebuild the message envelope (id, role, …) around its one part.
 */
export interface BatchAssembleContext {
  /** The inbound codec-tier headers (carries the per-message codec headers). */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers (carries the per-message transport headers). */
  transportHeaders: Record<string, string>;
}

/**
 * A multi-part input descriptor spec: one domain message decomposed into many
 * atomic wire events sharing the input member's `kind` and codec-message-id, each
 * carrying a `partType` sub-discriminator. The part union `P` is inferred from
 * `explode`'s return type and threaded into `parts`'s curried `p` and `assemble`,
 * so all three are cast-free in author code.
 * @template C - The narrowed input member (the message-bearing input).
 * @template P - The part union the message explodes into.
 */
export interface BatchSpec<C, P extends { type: string }> {
  /** ENCODE: decompose the domain message into its parts. */
  explode: (input: C) => readonly P[];
  /** The `partType` sub-discriminator read off each part on encode. */
  partTypeOf: (part: P) => string;
  /** Declarative per-part wire mapping (a sub-table built via the curried `p`). */
  parts: (p: PartBuilder<P>) => readonly PartDescriptor[];
  /**
   * ENCODE: per-message headers stamped on every part (the driver merges them
   * onto each part's headers, including the ≥1-event fallback). Use for metadata
   * shared by the whole message — e.g. a message-id codec header and a role
   * transport header. Omit when parts carry no shared per-message metadata.
   */
  messageHeaders?: (input: C) => BatchMessageHeaders;
  /**
   * DECODE: shape one decoded wire part into a one-part input (the reducer merges
   * parts by codec-message-id). `ctx` exposes the inbound header tiers so the
   * shared per-message metadata stamped by `messageHeaders` can be read back.
   */
  assemble: (part: P, ctx: BatchAssembleContext) => Omit<C, 'kind' | 'codecMessageId'>;
}

// ---------------------------------------------------------------------------
// Erased descriptors (heterogeneous array elements)
// ---------------------------------------------------------------------------

/** A single-event input descriptor erased to the codec's input union `U`. */
export interface InputEventDescriptor<U> {
  /** Discriminator. */
  construct: 'event';
  /** The wire `kind` this input dispatches on. */
  kind: string;
  /** The lens (`'payload'` to read `chunk.payload`, else the member directly). */
  via: 'payload' | undefined;
  /** Declared header fields. */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec, if any. */
  data?: DataCodec<unknown>;
  /** Wire-only signal flag. */
  wireOnly: boolean;
  /** Escape-hatch encode, if any. */
  encode?: (input: U, core: InputAdapterCore, ctx: InputEncodeContext) => Promise<void>;
  /** Escape-hatch decode, if any. */
  decode?: (ctx: InputDecodeContext) => U[];
}

/** An erased per-part wire mapping within a {@link BatchDescriptor}. */
export interface PartDescriptor {
  /** The exact `partType` this part encodes as (the wildcard sentinel for a family). */
  partType: string;
  /** Decode-dispatch predicate for a wildcard part; absent for an exact part. */
  match?: (partType: string) => boolean;
  /** Declared header fields for this part. */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec over the part, if any. */
  data?: DataCodec<unknown>;
}

/** A multi-part (batch) input descriptor erased to the codec's input union `U`. */
export interface BatchDescriptor<U> {
  /** Discriminator. */
  construct: 'batch';
  /** The wire `kind` every part of this batch shares. */
  kind: string;
  /** Decompose the domain input into its parts. */
  explode: (input: U) => readonly unknown[];
  /** Read the `partType` sub-discriminator off a part. */
  partTypeOf: (part: unknown) => string;
  /** The per-part wire mappings. */
  parts: readonly PartDescriptor[];
  /** Build the per-message headers stamped on every part, if any. */
  messageHeaders?: (input: U) => BatchMessageHeaders;
  /** Shape one decoded part into a one-part input (sans the driver-stamped `kind`/`codecMessageId`). */
  assemble: (part: unknown, ctx: BatchAssembleContext) => Omit<U, 'kind' | 'codecMessageId'>;
}

/** An erased input descriptor — a single event or a multi-part batch. */
export type InputDescriptor<U> = InputEventDescriptor<U> | BatchDescriptor<U>;

// ---------------------------------------------------------------------------
// Builder factory
// ---------------------------------------------------------------------------

/**
 * The direction-scoped input builder `defineCodec` injects into the `input`
 * config function — `event` and `batch`, both curried on the codec's input union
 * so author entries narrow cast-free.
 * @template U - The codec's input union.
 */
export interface InputBuilder<U extends { kind: string }> {
  /**
   * Declare a single-event input. Narrows `spec` to the member `kind` selects and
   * lenses `fields` / `data` per `via`.
   * @param kind - The input member's `kind` literal (the wire dispatch key).
   * @param spec - The narrowed, lensed input spec. Omit for a bare-`kind` input.
   * @returns An erased {@link InputDescriptor}.
   */
  event: <K extends U['kind'], V extends 'payload' | undefined = undefined>(
    kind: K,
    spec?: InputEventSpec<ResolveInput<U, K>, V>,
  ) => InputDescriptor<U>;
  /**
   * Declare a multi-part (batch) input. Narrows the spec to the message-bearing
   * member `kind` selects; `explode`'s return type fixes the part union `P`, which
   * threads into `parts`'s curried `p` and `assemble` cast-free.
   * @param kind - The input member's `kind` literal (the shared wire dispatch key).
   * @param spec - The narrowed batch spec.
   * @returns An erased {@link InputDescriptor}.
   */
  batch: <K extends U['kind'], P extends { type: string }>(
    kind: K,
    spec: BatchSpec<ResolveInput<U, K>, P>,
  ) => InputDescriptor<U>;
}

/**
 * Build the curried `{ event, batch }` input builder for a codec's input union.
 * `defineCodec` calls this once and hands the result to the `input` config
 * function; mirrors the output side's {@link import('./descriptors.js').defineEvent}
 * / `defineStream` curry.
 * @template U - The codec's input union.
 * @returns The direction-scoped {@link InputBuilder}.
 */
export const inputBuilder = <U extends { kind: string }>(): InputBuilder<U> => {
  // The internal part sub-builder reads only the structural `fields`/`data` off the
  // spec; the narrowed part type is an author-facing concern, erased here.
  interface ErasedPartSpec {
    fields?: readonly HeaderField<unknown>[];
    data?: DataCodec<unknown>;
  }
  const part = (partType: string, spec: ErasedPartSpec): PartDescriptor => ({
    partType,
    fields: spec.fields ?? [],
    data: spec.data,
  });
  const wildcard = (match: (partType: string) => boolean, spec: ErasedPartSpec): PartDescriptor => ({
    partType: '',
    match,
    fields: spec.fields ?? [],
    data: spec.data,
  });
  // CAST: the part sub-builder is exposed to authors narrowed (PartBuilder<P>) so
  // each `p(partType, spec)` / `p.wildcard(...)` narrows its spec to the selected
  // part. Internally it reads only the structural `fields`/`data`, so the narrowed
  // specs erase to the structural `ErasedPartSpec` at this boundary; a descriptor's
  // part callbacks only ever run against the part their literal/predicate matched.
  const p = Object.assign(part, { wildcard }) as unknown as PartBuilder<{ type: string }>;

  return {
    event: (kind, spec) =>
      // CAST: `spec` is narrowed to the member `kind` selects and lensed by `via`;
      // the descriptor erases that to the codec's union `U` so heterogeneous
      // descriptors share one array type. The drivers only ever invoke a
      // descriptor's callbacks with the matching member, so the erasure is sound.
      ({
        construct: 'event',
        kind,
        via: spec?.via,
        fields: spec?.fields ?? [],
        data: spec?.data,
        wireOnly: spec?.wireOnly ?? false,
        encode: spec?.encode,
        decode: spec?.decode,
      }) as unknown as InputDescriptor<U>,
    batch: (kind, spec) => {
      // CAST: `p` is the single structural sub-builder; the author's `parts`
      // function is typed to the narrowed `PartBuilder<P>`, so we hand it `p`
      // through the same erasure the part specs already cross.
      const parts = (spec.parts as (b: PartBuilder<{ type: string }>) => readonly PartDescriptor[])(p);
      // CAST: see `event` — the narrowed batch spec (with its part-union-typed
      // `explode`/`partTypeOf`/`assemble`) erases to `BatchDescriptor<U>`.
      return {
        construct: 'batch',
        kind,
        explode: spec.explode,
        partTypeOf: spec.partTypeOf,
        parts,
        messageHeaders: spec.messageHeaders,
        assemble: spec.assemble,
      } as unknown as InputDescriptor<U>;
    },
  };
};
