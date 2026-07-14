/**
 * Shared header-field bag helpers.
 *
 * The wire dispatch discriminator (`kind`) plus the symmetric field↔headers
 * write and read used by the descriptor drivers. Centralised so encode and
 * decode operate on the same record shape and the dispatch key has one home —
 * and so the input drivers can reuse the same primitives as the output drivers.
 */

import type { HeaderField } from './fields.js';
import type { OutputDescriptor, OutputEventDescriptor } from './output-descriptors.js';

/** The codec header carrying the SDK-controlled dispatch kind / stream family id. */
export const KIND_HEADER = 'kind';

/** The sentinel suffix marking a descriptor literal as a wildcard family. */
const WILDCARD_SUFFIX = '-*';

/**
 * Derive a wildcard dispatch predicate from a descriptor literal: a literal
 * ending in `-*` matches any value sharing its prefix, so the literal and its
 * predicate can never disagree. Returns `undefined` for an exact literal.
 * Shared by the output event builder and the input part builder so the `-*`
 * sentinel rule lives in one place, next to the {@link partFor} that consumes it.
 * @param literal - The declared descriptor literal (`type` / `partType`).
 * @returns A prefix-match predicate for a wildcard literal, else `undefined`.
 */
export const wildcardMatcher = (literal: string): ((value: string) => boolean) | undefined =>
  literal.endsWith(WILDCARD_SUFFIX) ? (value: string): boolean => value.startsWith(literal.slice(0, -1)) : undefined;

/**
 * The codec header carrying a batch part's sub-discriminator. A batch stamps it
 * on every exploded part on encode; the decoder reads it back to resolve the
 * matching part descriptor. Centralised so the key has one home across the
 * input encode and decode drivers and cannot drift between them.
 */
export const PART_TYPE_HEADER = 'partType';

/**
 * Read the value at a declared field key off a source object.
 * @param source - The object to index (a chunk, or a lensed sub-object such as a payload).
 * @param key - The declared field key.
 * @returns The value at `key`, typed `unknown`.
 */
// CAST: a descriptor indexes a source object's props by a declared key. The
// source's indexed type isn't statically known here, but a descriptor only ever
// runs against the member it matches, so the value has the field's type at runtime.
export const prop = (source: object, key: string): unknown => (source as Record<string, unknown>)[key];

/**
 * Build a codec-headers record from a source object through declared fields,
 * seeded with the dispatch `kind`. Each field writes the value at its key on
 * `source`; an optional `keys` subset restricts which fields are written.
 * @param fields - The declared header fields.
 * @param kindValue - The dispatch kind / stream family id to seed under {@link KIND_HEADER}.
 * @param source - The object to read field values from (a chunk, or a lensed payload).
 * @param keys - Optional subset of field keys to write; omit to write all.
 * @returns The codec-headers record.
 */
export const writeFields = (
  fields: readonly HeaderField<unknown>[],
  kindValue: string,
  source: object,
  keys?: readonly string[],
): Record<string, string> => {
  const rec: Record<string, string> = { [KIND_HEADER]: kindValue };
  for (const field of fields) {
    if (keys && !keys.includes(field.key)) continue;
    field.write(rec, prop(source, field.key));
  }
  return rec;
};

/**
 * Read declared fields out of a codec-headers record into a bag keyed by field key.
 * A field that reads `undefined` (absent, with no default) contributes no key — the
 * bag carries only the values that are actually present.
 * @param fields - The declared header fields.
 * @param headers - The inbound codec-tier headers.
 * @returns A bag of the present field values, keyed by each field's key.
 */
/** The structural slice of a part descriptor {@link partFor} dispatches on. */
interface PartDispatch {
  /** The exact `partType` literal, or the `-*` wildcard literal for a family. */
  partType: string;
  /** Wildcard dispatch predicate; absent for an exact part. */
  match?: (partType: string) => boolean;
}

/**
 * Resolve the part descriptor for a `partType`: an exact non-wildcard match,
 * else a wildcard whose derived predicate accepts it. Wildcards are excluded
 * from the exact pass — only their predicate may route to them. Shared by the
 * input encode and decode drivers.
 * @param parts - The batch's part descriptor sub-table.
 * @param partType - The `partType` to resolve (from `partTypeOf` on encode, the wire header on decode).
 * @returns The matching part descriptor, or undefined when none matches.
 */
export const partFor = <P extends PartDispatch>(parts: readonly P[], partType: string): P | undefined =>
  parts.find((part) => !part.match && part.partType === partType) ?? parts.find((part) => part.match?.(partType));

/** An output descriptor set's event descriptors, split for dispatch. */
export interface OutputEventDispatch<U> {
  /** Exact (non-wildcard) event descriptors, keyed by `type`. */
  discreteByType: Map<string, OutputEventDescriptor<U>>;
  /** Wildcard event descriptors, dispatched by their `match` predicate. */
  wildcards: OutputEventDescriptor<U>[];
}

/**
 * Partition an output descriptor set's `event` descriptors into an exact-type
 * map and a wildcard list. Non-`event` descriptors are skipped — each driver
 * indexes stream descriptors by its own key (phase on encode, kind on decode),
 * and drop descriptors are the encode driver's concern alone. Shared by the
 * output encode and decode drivers so the exact-vs-wildcard split has one home.
 * @template U - The codec's event union.
 * @param descriptors - The full descriptor set (events, streamed families, and dropped types).
 * @returns The event descriptors split into {@link OutputEventDispatch}.
 */
export const partitionOutputEvents = <U extends { type: string }>(
  descriptors: readonly OutputDescriptor<U>[],
): OutputEventDispatch<U> => {
  const discreteByType = new Map<string, OutputEventDescriptor<U>>();
  const wildcards: OutputEventDescriptor<U>[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.construct !== 'event') continue;
    if (descriptor.match) wildcards.push(descriptor);
    else discreteByType.set(descriptor.type, descriptor);
  }
  return { discreteByType, wildcards };
};

export const readFields = (
  fields: readonly HeaderField<unknown>[],
  headers: Record<string, string>,
): Record<string, unknown> => {
  const bag: Record<string, unknown> = {};
  for (const field of fields) {
    const value = field.read(headers);
    if (value !== undefined) bag[field.key] = value;
  }
  return bag;
};
