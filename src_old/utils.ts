/**
 * Shared utilities for working with Ably messages.
 *
 * These are general-purpose helpers used by both the codec and transport
 * layers. They live at the top level to avoid either layer depending on
 * the other.
 */

import type * as Ably from 'ably';

import { DOMAIN_HEADER_PREFIX } from './constants.js';

/**
 * Extract extras.headers from an Ably InboundMessage.
 * @param message - The Ably message to extract headers from.
 * @returns The headers record, or an empty object if absent.
 */
export const getHeaders = (message: Ably.InboundMessage): Record<string, string> => {
  // CAST: Ably SDK types `extras` as `any`; runtime checks below guard access.
  const extras = message.extras as unknown;
  if (!extras || typeof extras !== 'object') return {};
  const headers = (extras as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return {};
  // CAST: Ably wire protocol guarantees headers is Record<string, string>
  // when present, verified by the runtime guards above.
  return headers as Record<string, string>;
};

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
 * Set a header value if defined, skipping undefined and null. Strings are set directly,
 * booleans and numbers are stringified, objects are JSON-serialized.
 * @param headers - The headers object to mutate.
 * @param key - The header key.
 * @param value - The value to set.
 */
export const setIfPresent = (headers: Record<string, string>, key: string, value: unknown): void => {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    headers[key] = value;
  } else if (typeof value === 'boolean' || typeof value === 'number') {
    headers[key] = String(value);
  } else if (typeof value === 'object') {
    headers[key] = JSON.stringify(value);
  }
};

/**
 * Set multiple headers at once, skipping entries whose values are undefined or null.
 * Each value is converted using the same rules as {@link setIfPresent}.
 * @param headers - The headers object to mutate.
 * @param entries - Key-value pairs to set.
 */
export const setHeadersIfPresent = (headers: Record<string, string>, entries: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(entries)) {
    setIfPresent(headers, key, value);
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

/**
 * Build a domain headers record from key-value pairs. Each key is automatically
 * prefixed with {@link DOMAIN_HEADER_PREFIX}. Values that are undefined or null
 * are skipped; strings are set directly; booleans, numbers, and objects are
 * converted using the same rules as {@link setIfPresent}.
 * @param entries - Unprefixed key-value pairs (e.g. `{ toolCallId: 'tc-1' }` becomes `{ 'x-domain-toolCallId': 'tc-1' }`).
 * @returns A new headers record with prefixed keys.
 */
export const domainHeaders = (entries: Record<string, unknown>): Record<string, string> => {
  const h: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    setIfPresent(h, DOMAIN_HEADER_PREFIX + key, value);
  }
  return h;
};

/**
 * Read a domain header value from a headers record.
 * @param headers - The headers record to read from.
 * @param key - The unprefixed domain key (e.g. `'toolCallId'` reads `'x-domain-toolCallId'`).
 * @returns The header value, or undefined if absent.
 */
export const getDomainHeader = (headers: Record<string, string>, key: string): string | undefined =>
  headers[DOMAIN_HEADER_PREFIX + key];

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
 * Reduces repetitive `getDomainHeader` + `parseBool` / `parseJson` chains.
 */
export interface DomainHeaderReader {
  /** Read a domain header as a string, or undefined if absent. */
  str(key: string): string | undefined;
  /** Read a domain header as a string, falling back to a default if absent. */
  strOr(key: string, fallback: string): string;
  /** Read a domain header as a boolean ("true"/"false"), or undefined if absent. */
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
  str: (key: string) => getDomainHeader(headers, key),
  strOr: (key: string, fallback: string) => getDomainHeader(headers, key) ?? fallback,
  bool: (key: string) => parseBool(getDomainHeader(headers, key)),
  json: (key: string) => parseJson(getDomainHeader(headers, key)),
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
 * Create a {@link DomainHeaderWriter} for building a domain headers record.
 * @returns A fluent builder that prefixes each key with the domain header prefix.
 */
export const headerWriter = (): DomainHeaderWriter => {
  const h: Record<string, string> = {};
  const writer: DomainHeaderWriter = {
    str: (key: string, value: string | undefined) => {
      if (value !== undefined) h[DOMAIN_HEADER_PREFIX + key] = value;
      return writer;
    },
    bool: (key: string, value: boolean | undefined) => {
      if (value !== undefined) h[DOMAIN_HEADER_PREFIX + key] = String(value);
      return writer;
    },
    json: (key: string, value: unknown) => {
      if (value !== undefined && value !== null) h[DOMAIN_HEADER_PREFIX + key] = JSON.stringify(value);
      return writer;
    },
    build: () => h,
  };
  return writer;
};
