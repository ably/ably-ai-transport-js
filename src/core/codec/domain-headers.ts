/**
 * Domain header helpers — typed builders and readers for `x-domain-*`
 * headers carried inside an Ably message's `extras.headers`. These are
 * codec-author tools; SDK-level headers (`x-ably-*`) live in
 * `src/headers.ts` and are written by the writer.
 *
 * The prefix lets a codec attach correlation metadata (message ids, tool
 * call ids, lifecycle markers) on the wire alongside the SDK's routing
 * headers without colliding with them.
 */

/** Prefix applied to every domain header key. */
export const DOMAIN_HEADER_PREFIX = 'x-domain-';

/**
 * Parse a JSON string, returning `undefined` on failure. Used by domain
 * header readers that carry JSON-serialised payloads.
 * @param value The string to parse.
 * @returns The parsed value, or `undefined` if absent or invalid.
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
 * Parse a boolean header (`"true"`/`"false"`).
 * @param value The string to parse.
 * @returns `true` for `"true"`, `false` for any other string, `undefined`
 *   if absent.
 */
export const parseBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === 'true';
};

/**
 * Read a domain header value from a headers record.
 * @param headers The headers record to read from.
 * @param key The unprefixed domain key (e.g. `'messageId'` reads
 *   `'x-domain-messageId'`).
 * @returns The header value, or `undefined` if absent.
 */
export const getDomainHeader = (headers: Record<string, string>, key: string): string | undefined =>
  headers[DOMAIN_HEADER_PREFIX + key];

/**
 * Typed accessor wrapper around a headers record for reading domain
 * headers. Reduces repetitive `getDomainHeader` + `parseBool` / `parseJson`
 * chains in a codec's decoder.
 */
export interface DomainHeaderReader {
  /**
   * Read a domain header as a string.
   * @param key The unprefixed domain key.
   * @returns The string value, or `undefined` if absent.
   */
  str(key: string): string | undefined;
  /**
   * Read a domain header as a string, falling back to a default if absent.
   * @param key The unprefixed domain key.
   * @param fallback The value to return when the header is absent.
   * @returns The string value, or `fallback`.
   */
  strOr(key: string, fallback: string): string;
  /**
   * Read a domain header as a boolean (`"true"`/`"false"`).
   * @param key The unprefixed domain key.
   * @returns The boolean value, or `undefined` if absent.
   */
  bool(key: string): boolean | undefined;
  /**
   * Read a domain header as parsed JSON.
   * @param key The unprefixed domain key.
   * @returns The parsed value, or `undefined` if absent or invalid.
   */
  json(key: string): unknown;
}

/**
 * Create a {@link DomainHeaderReader} over a headers record.
 * @param headers The raw headers record to read domain headers from.
 * @returns A typed accessor for domain header values.
 */
export const headerReader = (headers: Record<string, string>): DomainHeaderReader => ({
  str: (key: string) => getDomainHeader(headers, key),
  strOr: (key: string, fallback: string) => getDomainHeader(headers, key) ?? fallback,
  bool: (key: string) => parseBool(getDomainHeader(headers, key)),
  json: (key: string) => parseJson(getDomainHeader(headers, key)),
});

/**
 * Fluent builder for constructing a domain headers record with typed
 * setters. Mirrors {@link DomainHeaderReader} for symmetry; undefined
 * values are silently skipped on every setter.
 */
export interface DomainHeaderWriter {
  /**
   * Set a string domain header. No-op when `value` is `undefined`.
   * @param key The unprefixed domain key.
   * @param value The string value to set, or `undefined` to skip.
   * @returns This writer, for chaining.
   */
  str(key: string, value: string | undefined): DomainHeaderWriter;
  /**
   * Set a boolean domain header (serialised as `"true"`/`"false"`). No-op
   * when `value` is `undefined`.
   * @param key The unprefixed domain key.
   * @param value The boolean value to set, or `undefined` to skip.
   * @returns This writer, for chaining.
   */
  bool(key: string, value: boolean | undefined): DomainHeaderWriter;
  /**
   * Set a JSON-serialised domain header. No-op when `value` is `undefined`
   * or `null`.
   * @param key The unprefixed domain key.
   * @param value The value to JSON-stringify, or `undefined`/`null` to skip.
   * @returns This writer, for chaining.
   */
  json(key: string, value: unknown): DomainHeaderWriter;
  /**
   * Return the accumulated headers record.
   * @returns The headers record built so far.
   */
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
