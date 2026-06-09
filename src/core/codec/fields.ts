/**
 * Typed header-field bindings.
 *
 * A {@link HeaderField} binds a codec header key to its value type **once**,
 * and exposes a symmetric {@link HeaderField.read | read} / {@link
 * HeaderField.write | write} pair over a raw `Record<string, string>` headers
 * record. Because a single binding drives both the encode and decode side, the
 * header key and its value type stay in lockstep across directions — a key
 * cannot be misspelled on one side and silently read as absent on the other.
 *
 * This is deliberately **not** a schema library: it is a thin bidirectional
 * string (de)serializer over the headers record. The SDK ships no hard runtime
 * dependencies, and a schema approach would force re-declaring peer-SDK-owned
 * types. The four constructors cover every header value shape the codecs use:
 *
 * - {@link strField} — string values, optional default.
 * - {@link boolField} — `"true"`/`"false"` booleans, optional default.
 * - {@link jsonField} — JSON-serialized structured values.
 * - {@link enumField} — string values validated against an allow-list with a
 *   fallback (e.g. a finish reason).
 *
 * Passing a default to `strField`/`boolField` makes the field **total**: its
 * `read` returns `V` rather than `V | undefined`, for required headers that
 * should always decode to a concrete value.
 */

import { parseBool, parseJson } from '../../utils.js';

/**
 * A header key bound to its value type, with symmetric read/write over a raw
 * headers record. Created via {@link strField}, {@link boolField}, {@link
 * jsonField}, or {@link enumField}.
 * @template V - The decoded value type this field reads and writes.
 */
export interface HeaderField<V> {
  /** The raw header key this field reads from and writes to. */
  readonly key: string;
  /**
   * Read and decode this field's value from a headers record.
   * @param headers - The raw codec headers record to read from.
   * @returns The decoded value. For defaulted/validated fields this is total
   * (the default/fallback is returned when the header is absent or invalid);
   * otherwise `undefined` when the header is absent.
   */
  read(headers: Record<string, string>): V;
  /**
   * Encode and write this field's value into a headers record, mutating it in
   * place. `undefined` (and `null`, for JSON values) is skipped — the key is
   * left unset rather than written as an empty string.
   * @param headers - The headers record to mutate.
   * @param value - The value to encode and set.
   */
  write(headers: Record<string, string>, value: V): void;
}

/**
 * Bind a string-valued header field.
 * @param key - The header key.
 * @returns A field whose `read` yields `string | undefined` (absent → `undefined`).
 */
export function strField(key: string): HeaderField<string | undefined>;
/**
 * Bind a string-valued header field with a default, making it total.
 * @param key - The header key.
 * @param fallback - Value returned by `read` when the header is absent.
 * @returns A field whose `read` yields `string` (absent → `fallback`).
 */
export function strField(key: string, fallback: string): HeaderField<string>;
export function strField(key: string, fallback?: string): HeaderField<string | undefined> {
  return {
    key,
    read: (headers) => headers[key] ?? fallback,
    write: (headers, value) => {
      if (value !== undefined) headers[key] = value;
    },
  };
}

/**
 * Bind a boolean-valued header field, serialized as `"true"`/`"false"`.
 * @param key - The header key.
 * @returns A field whose `read` yields `boolean | undefined` (absent → `undefined`).
 */
export function boolField(key: string): HeaderField<boolean | undefined>;
/**
 * Bind a boolean-valued header field with a default, making it total.
 * @param key - The header key.
 * @param fallback - Value returned by `read` when the header is absent.
 * @returns A field whose `read` yields `boolean` (absent → `fallback`).
 */
export function boolField(key: string, fallback: boolean): HeaderField<boolean>;
export function boolField(key: string, fallback?: boolean): HeaderField<boolean | undefined> {
  return {
    key,
    read: (headers) => parseBool(headers[key]) ?? fallback,
    write: (headers, value) => {
      if (value !== undefined) headers[key] = String(value);
    },
  };
}

/**
 * Bind a JSON-serialized header field. The value is written with
 * `JSON.stringify` and read back with `JSON.parse`; malformed JSON reads as
 * `undefined`. The decoded shape is a trust boundary — the caller asserts it
 * via the `V` type parameter.
 * @template V - The expected decoded shape of the JSON value.
 * @param key - The header key.
 * @returns A field whose `read` yields `V | undefined` (absent or malformed → `undefined`).
 */
export const jsonField = <V>(key: string): HeaderField<V | undefined> => ({
  key,
  // CAST: header values are wire data parsed via JSON.parse — a trust
  // boundary. The caller declares the expected shape through `V`; malformed
  // JSON reads back as `undefined` (parseJson swallows the parse error).
  read: (headers) => parseJson(headers[key]) as V | undefined,
  write: (headers, value) => {
    // Skip undefined and null so an absent value leaves the key unset rather
    // than serializing to "null".
    if (value !== undefined && value !== null) headers[key] = JSON.stringify(value);
  },
});

/**
 * Bind a string-valued header field validated against a fixed allow-list,
 * falling back to a given value when the header is absent or unrecognized. Use
 * for headers with a small closed set of valid values (e.g. a finish reason).
 * @template T - The union of allowed string literals, inferred from `allowed`.
 * @param key - The header key.
 * @param allowed - The exhaustive list of valid values.
 * @param fallback - Value returned by `read` when the header is absent or not in `allowed`.
 * @returns A total field whose `read` yields one of the allowed literals.
 */
export const enumField = <const T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: NoInfer<T>,
): HeaderField<T> => ({
  key,
  read: (headers) => {
    const raw = headers[key];
    // find returns the matched literal (typed T) or undefined — no cast needed.
    return allowed.find((candidate) => candidate === raw) ?? fallback;
  },
  write: (headers, value) => {
    headers[key] = value;
  },
});
