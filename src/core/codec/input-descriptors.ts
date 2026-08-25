/**
 * Declarative input descriptors — the single source of truth for a codec's
 * `ai-input` wire mapping, the input-side sibling of {@link import('./output-descriptors.js')}.
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

import type * as Ably from 'ably';

import type { DataCodec, FieldFor, HeaderField } from './fields.js';
import { wildcardMatcher } from './header-fields.js';
import type { MessagePayload, WriteOptions } from './types.js';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Resolve the input union member a `kind` literal selects. */
export type ResolveInput<U extends { kind: string }, K extends U['kind']> = Extract<U, { kind: K }>;

/**
 * The payload an input `event`'s `fields` / `data` operate on. Inputs nest their
 * domain body under `payload` (the `{ kind, payload }` envelope), so a single
 * event's spec is authored against the payload, and the driver wraps/unwraps
 * the envelope. A member with no `payload`
 * (a `wireOnly` signal) resolves to `never` — such an event declares no `fields` /
 * `data`, so the payload type is never used.
 * @template C - The narrowed input member.
 */
export type PayloadOf<C> = C extends { payload: infer P } ? P : never;

/**
 * Resolve the part union member a `partType` literal selects, mirroring the
 * output {@link import('./output-descriptors.js').ResolveType} curry one level down.
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

// ---------------------------------------------------------------------------
// Input driver core surface + contexts
// ---------------------------------------------------------------------------

/**
 * The encoder-core view the input encode driver receives: discrete publishes
 * only — inputs never stream. The concrete {@link EncoderCore} satisfies this
 * structurally.
 */
export interface InputEncoderCore {
  /** Publish a single discrete message. */
  publishDiscrete(payload: MessagePayload, opts?: WriteOptions): Promise<Ably.PublishResult>;
  /** Publish multiple discrete messages atomically (the batch fan-out). */
  publishDiscreteBatch(payloads: MessagePayload[], opts?: WriteOptions): Promise<Ably.PublishResult>;
}

/** Per-write context passed to the input encode driver. */
export interface InputEncodeContext {
  /** Per-write overrides (the wire transport-message-id is stamped here by the transport). */
  opts: WriteOptions | undefined;
}

/** Per-message context the input decode driver receives for one inbound `ai-input` message. */
export interface InputDecodeContext {
  /** The codec `kind` header value (the input descriptor's dispatch key). */
  codecKind: string;
  /** The inbound message data. */
  data: unknown;
  /** The inbound codec-tier headers. */
  codecHeaders: Record<string, string>;
  /** The inbound transport-tier headers (role, transport-message-id, discrete marker). */
  transportHeaders: Record<string, string>;
}

/**
 * The spec the input `event` construct accepts for member `C`. A member with
 * no `payload` has nothing for `fields` / `data` to lens onto, so it may only
 * be declared `wireOnly` or escape-hatched; the driver also rejects a
 * payload-less encode at runtime.
 * @template C - The narrowed input member.
 */
export type InputEventSpecFor<C> = [PayloadOf<C>] extends [never]
  ? Pick<InputEventSpec<C>, 'wireOnly'>
  : InputEventSpec<C>;

/**
 * A single-event input descriptor spec, narrowed to input member `C`. `fields`
 * and `data` operate on the member's {@link PayloadOf payload}; the driver wraps
 * the `{ kind, transportMessageId, payload }` envelope on decode and unwraps it on
 * encode. A `wireOnly` event carries no payload (kind only).
 * @template C - The narrowed input member.
 */
export interface InputEventSpec<C> {
  /**
   * Declared header fields over the member's payload, written on encode and
   * read on decode. Each field's key names both the wire header and the
   * payload property it carries (see {@link FieldFor}). Omit for none.
   */
  fields?: readonly FieldFor<PayloadOf<C>>[];
  /** Wire `data` codec over the payload. Omit when the input carries no data (`data: ''`). */
  data?: DataCodec<PayloadOf<C>>;
  /** Wire-only signal: encode stamps only the `kind` header (empty data, no fields); decode yields `[]`. */
  wireOnly?: boolean;
}

/**
 * A per-part wire mapping inside a {@link BatchSpec}, narrowed to part member `Q`.
 * `fields` and `data` operate on the selected part; the batch driver fans the
 * domain message out into one wire event per part and reassembles them in the
 * consumer (merge by transport-message-id).
 * @template Q - The narrowed part member.
 */
export interface PartSpec<Q> {
  /**
   * Declared header fields for this part, written on encode and read on
   * decode. Each field's key names both the wire header and the part property
   * it carries (see {@link FieldFor}). Omit for none.
   */
  fields?: readonly FieldFor<Q>[];
  /** Wire `data` codec over the part. Omit when the part carries no data. */
  data?: DataCodec<Q>;
}

/**
 * The curried part sub-builder a {@link BatchSpec.parts} function receives.
 * Mirrors the {@link inputBuilder} `event` curry one level down — and the
 * output builder's wildcard idiom: `p(partType, spec)` narrows `spec` to the
 * part member the literal selects, and a `-*` literal (e.g. `data-*`) declares
 * a wildcard group whose dispatch predicate is derived from the literal's
 * prefix, narrowing `spec` to the template member. Both forms are cast-free in
 * author code.
 * @template P - The part union.
 */
export type PartBuilder<P extends { type: string }> = <T extends P['type'] | `${string}-*`>(
  partType: T,
  spec: PartSpec<ResolvePart<P, T>>,
) => PartDescriptor;

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
 * atomic wire events sharing the input member's `kind` and transport-message-id, each
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
   * DECODE: shape one decoded wire part into a one-part input (a consumer merges
   * parts by transport-message-id). `ctx` exposes the inbound header tiers so the
   * shared per-message metadata stamped by `messageHeaders` can be read back.
   * The driver stamps only `kind`; the per-message identity rides the
   * transport header and is recovered through `ctx` when needed.
   */
  assemble: (part: P, ctx: BatchAssembleContext) => Omit<C, 'kind'>;
}

// ---------------------------------------------------------------------------
// Erased descriptors (heterogeneous array elements)
// ---------------------------------------------------------------------------

/** A single-event input descriptor erased to the codec's input union `U`. */
export interface InputEventDescriptor {
  /** Discriminator. */
  construct: 'event';
  /** The wire `kind` this input dispatches on. */
  kind: string;
  /** Declared header fields (read/written against the member's payload). */
  fields: readonly HeaderField<unknown>[];
  /** Wire `data` codec, if any. */
  data?: DataCodec<unknown>;
  /** Wire-only signal flag. */
  wireOnly: boolean;
}

/** An erased per-part wire mapping within a {@link BatchDescriptor}. */
export interface PartDescriptor {
  /** The exact `partType` this part encodes as (the wildcard sentinel for a group). */
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
  /** Shape one decoded part into a one-part input (sans the driver-stamped `kind`). */
  assemble: (part: unknown, ctx: BatchAssembleContext) => Omit<U, 'kind'>;
}

/** An erased input descriptor — a single event or a multi-part batch. */
export type InputDescriptor<U> = InputEventDescriptor | BatchDescriptor<U>;

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
   * Declare a single-event input. Narrows `spec` to the member `kind` selects;
   * `fields` / `data` operate on that member's payload.
   * @param kind - The input member's `kind` literal (the wire dispatch key).
   * @param spec - The narrowed input spec. Omit for a bare-`kind` input.
   * @returns An erased {@link InputDescriptor}.
   */
  event: <K extends U['kind']>(kind: K, spec?: InputEventSpecFor<ResolveInput<U, K>>) => InputDescriptor<U>;
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
 * function; mirrors the output side's {@link import('./output-descriptors.js').outputBuilder}.
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
  const part = (partType: string, spec: ErasedPartSpec): PartDescriptor => {
    // A `-*` literal declares a wildcard group; the dispatch predicate is
    // derived from the literal so the two can never disagree (see wildcardMatcher).
    const match = wildcardMatcher(partType);
    return {
      partType,
      ...(match ? { match } : {}),
      fields: spec.fields ?? [],
      data: spec.data,
    };
  };
  // CAST: the part sub-builder is exposed to authors narrowed (PartBuilder<P>) so
  // each `p(partType, spec)` narrows its spec to the selected part. Internally it
  // reads only the structural `fields`/`data`, so the narrowed specs erase to the
  // structural `ErasedPartSpec` at this boundary; a descriptor's part callbacks
  // only ever run against the part their literal/predicate matched.
  const p = part as unknown as PartBuilder<{ type: string }>;

  return {
    event: (kind, spec) => {
      // CAST: the author-facing spec is conditional (a payload-less member may
      // only declare wireOnly / escape hatches); both branches erase to one
      // structural bag here, and the impl only reads optional properties off it.
      const bag = spec as InputEventSpec<{ kind: string; payload: unknown }> | undefined;
      // CAST: `spec` is narrowed to the member `kind` selects; the descriptor erases
      // that to the codec's union `U` so heterogeneous descriptors share one array
      // type. The drivers only ever invoke a descriptor's callbacks with the matching
      // member, so the erasure is sound.
      return {
        construct: 'event',
        kind,
        fields: bag?.fields ?? [],
        data: bag?.data,
        wireOnly: bag?.wireOnly ?? false,
      } as unknown as InputDescriptor<U>;
    },
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
