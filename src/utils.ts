/**
 * Shared utilities for working with Ably messages.
 *
 * These are general-purpose helpers used by both the codec and transport
 * layers. They live at the top level to avoid either layer depending on
 * the other.
 */

import type * as Ably from 'ably';

/**
 * Read one tier of the SDK's `extras.ai` namespace from an Ably message.
 * `extras.ai` is the SDK's reserved corner of the message envelope, split into
 * a `transport` tier (generic transport headers) and a `codec` tier (codec
 * headers). The application's own `extras.headers` is deliberately left
 * untouched.
 * @param message - The Ably message to read from.
 * @param tier - Which `extras.ai` sub-namespace to read.
 * @returns The tier's headers record, or an empty object if absent.
 */
const getAiTier = (message: Ably.InboundMessage, tier: 'transport' | 'codec'): Record<string, string> => {
  // CAST: Ably SDK types `extras` as `any`; runtime checks below guard access.
  const extras = message.extras as unknown;
  if (!extras || typeof extras !== 'object') return {};
  const ai = (extras as { ai?: unknown }).ai;
  if (!ai || typeof ai !== 'object') return {};
  const sub = (ai as Record<string, unknown>)[tier];
  if (!sub || typeof sub !== 'object') return {};
  // CAST: Ably wire protocol guarantees the tier is Record<string, string>
  // when present, verified by the runtime guards above.
  return sub as Record<string, string>;
};

/**
 * Extract the transport-tier headers (`extras.ai.transport`) from an Ably
 * InboundMessage. These are the generic transport headers (run/stream/identity/
 * branching), set and read by the transport layer.
 * @param message - The Ably message to extract headers from.
 * @returns The transport headers record, or an empty object if absent.
 */
export const getTransportHeaders = (message: Ably.InboundMessage): Record<string, string> =>
  getAiTier(message, 'transport');

/**
 * Extract the codec-tier headers (`extras.ai.codec`) from an Ably
 * InboundMessage. These are the codec's own headers, with no prefix — the
 * tier isolates them from transport headers.
 * @param message - The Ably message to extract headers from.
 * @returns The codec headers record, or an empty object if absent.
 */
export const getCodecHeaders = (message: Ably.InboundMessage): Record<string, string> => getAiTier(message, 'codec');

/**
 * Parse a JSON string, returning undefined on failure.
 * @param value - The JSON string to parse.
 * @returns The parsed value, or undefined if parsing fails.
 */
export const parseJson = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Merge two header records into a new object. Later values override earlier ones.
 * Undefined inputs are treated as empty.
 * @param base - Base headers (lower priority).
 * @param overrides - Override headers (higher priority).
 * @returns A new merged headers object.
 */
export const mergeHeaders = (
  base: Record<string, string> | undefined,
  overrides: Record<string, string> | undefined,
): Record<string, string> => ({
  ...base,
  ...overrides,
});

/**
 * Parse a boolean header ("true"/"false"), returning undefined if absent.
 * @param value - The header string to parse.
 * @returns True if "true", false for any other string, or undefined if absent.
 */
export const parseBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === 'true';
};

/** A record carrying an optional Ably `serial`, orderable by {@link compareBySerial}. */
interface HasSerial {
  /** Ably serial, or undefined if the server has not yet assigned one. */
  readonly serial?: string;
}

/**
 * Comparator that orders records by their Ably `serial` ascending
 * (chronological). Serials are lexicographically comparable; records whose
 * serial is undefined sort last. Pass directly to `Array.prototype.sort`.
 * @param a - First record to compare.
 * @param b - Second record to compare.
 * @returns Negative if `a` precedes `b`, positive if `a` follows `b`, 0 if equal.
 */
export const compareBySerial = (a: HasSerial, b: HasSerial): number => {
  if (a.serial === undefined && b.serial === undefined) return 0;
  if (a.serial === undefined) return 1;
  if (b.serial === undefined) return -1;
  if (a.serial < b.serial) return -1;
  if (a.serial > b.serial) return 1;
  return 0;
};

/**
 * Mapped type that converts properties whose type includes `undefined`
 * into optional properties with `undefined` excluded from the value.
 * Properties typed as `unknown` are kept required (since `undefined extends unknown`
 * is always true, but `unknown` fields are intentionally broad, not optional).
 */
export type Stripped<T> = {
  [K in keyof T as undefined extends T[K] ? (unknown extends T[K] ? K : never) : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? (unknown extends T[K] ? never : K) : never]?: Exclude<T[K], undefined>;
};

/**
 * Remove all keys whose value is `undefined` from a shallow object.
 * Returns a new object — the input is not mutated. Useful for building
 * chunk literals with optional fields without conditional spread noise.
 *
 * The return type converts `{ foo: T | undefined }` to `{ foo?: T }`,
 * matching the optional-field pattern used by the AI SDK chunk types.
 * @param obj - The object to strip undefined values from.
 * @returns A shallow copy with undefined-valued keys removed.
 */
export const stripUndefined = <T extends Record<string, unknown>>(obj: T): Stripped<T> => {
  const result = {} as Record<string, unknown>;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  // CAST: The runtime strip guarantees the Stripped<T> contract —
  // required keys are always present, optional keys are absent when undefined.
  return result as Stripped<T>;
};

// ---------------------------------------------------------------------------
// DomainHeaderReader — typed accessors for domain headers
// ---------------------------------------------------------------------------

/**
 * Typed accessor wrapper around a headers record for reading domain headers.
 * Reduces repetitive header lookup + `parseBool` / `parseJson` chains.
 */
export interface DomainHeaderReader {
  /** Read a domain header as a string, or undefined if absent. */
  str(key: string): string | undefined;
  /** Read a domain header as a string, falling back to a default if absent. */
  strOr(key: string, fallback: string): string;
  /** Read a domain header as a boolean: `true` only for the exact string "true", `false` for any other present value, or undefined if absent. */
  bool(key: string): boolean | undefined;
  /** Read a domain header as parsed JSON, or undefined if absent or invalid. */
  json(key: string): unknown;
}

/**
 * Create a {@link DomainHeaderReader} over a headers record.
 * @param headers - The raw headers record to read domain headers from.
 * @returns A typed accessor for domain header values.
 */
export const headerReader = (headers: Record<string, string>): DomainHeaderReader => ({
  str: (key: string) => headers[key],
  strOr: (key: string, fallback: string) => headers[key] ?? fallback,
  bool: (key: string) => parseBool(headers[key]),
  json: (key: string) => parseJson(headers[key]),
});

// ---------------------------------------------------------------------------
// DomainHeaderWriter — typed builder for domain headers
// ---------------------------------------------------------------------------

/**
 * Fluent builder for constructing domain header records with typed setters.
 * Mirrors {@link DomainHeaderReader} with the same method names for symmetry.
 * Undefined values are silently skipped on all setters.
 */
export interface DomainHeaderWriter {
  /** Set a string domain header. Skips if value is undefined. */
  str(key: string, value: string | undefined): DomainHeaderWriter;
  /** Set a boolean domain header (serialized as "true"/"false"). Skips if value is undefined. */
  bool(key: string, value: boolean | undefined): DomainHeaderWriter;
  /** Set a JSON-serialized domain header. Skips if value is undefined or null. */
  json(key: string, value: unknown): DomainHeaderWriter;
  /** Return the accumulated headers record. */
  build(): Record<string, string>;
}

/**
 * Create a {@link DomainHeaderWriter} for building a codec-tier headers record.
 * @returns A fluent builder that accumulates codec headers under their bare keys.
 */
export const headerWriter = (): DomainHeaderWriter => {
  const h: Record<string, string> = {};
  const writer: DomainHeaderWriter = {
    str: (key: string, value: string | undefined) => {
      if (value !== undefined) h[key] = value;
      return writer;
    },
    bool: (key: string, value: boolean | undefined) => {
      if (value !== undefined) h[key] = String(value);
      return writer;
    },
    json: (key: string, value: unknown) => {
      if (value !== undefined && value !== null) h[key] = JSON.stringify(value);
      return writer;
    },
    build: () => h,
  };
  return writer;
};
