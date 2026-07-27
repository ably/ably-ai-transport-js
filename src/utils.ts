/**
 * Shared utilities for working with Ably messages.
 *
 * These are general-purpose helpers used by both the codec and transport
 * layers. They live at the top level to avoid either layer depending on
 * the other.
 */

import * as Ably from 'ably';

/**
 * Extract a human-readable message from an unknown thrown value.
 * @param error - The thrown value.
 * @returns The error's `message` when it is an `Error`, otherwise its string form.
 */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Narrow an unknown thrown value to an `Ably.ErrorInfo` for use as a wrapping
 * `cause`, returning `undefined` when it is not one. Pass the result as the
 * fourth argument to the `Ably.ErrorInfo` constructor to preserve the error
 * chain without asserting a type the value may not have.
 * @param error - The thrown value.
 * @returns The value when it is an `Ably.ErrorInfo`, otherwise `undefined`.
 */
export const errorCause = (error: unknown): Ably.ErrorInfo | undefined =>
  error instanceof Ably.ErrorInfo ? error : undefined;

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
 * Whether an Ably message carries the SDK's reserved `extras.ai` envelope.
 * Every wire the SDK publishes carries it — including stream appends, whose
 * `name` the platform does not echo — so its absence identifies a foreign
 * message: an application's own publish on a channel it shares with a session.
 * @param message - The Ably message to inspect.
 * @returns True when the message carries an `extras.ai` envelope.
 */
export const hasAiEnvelope = (message: Ably.InboundMessage): boolean => {
  // CAST: Ably SDK types `extras` as `any`; runtime checks below guard access.
  const extras = message.extras as unknown;
  if (!extras || typeof extras !== 'object') return false;
  const ai = (extras as { ai?: unknown }).ai;
  return Boolean(ai) && typeof ai === 'object';
};

/**
 * Extract the application's own user headers (`extras.headers`) from an Ably
 * InboundMessage. This is Ably's user-header slot, outside the SDK's
 * `extras.ai` envelope, so it can never collide with the transport or codec
 * tiers.
 * @param message - The Ably message to extract headers from.
 * @returns The user headers record, or an empty object if absent.
 */
export const getUserHeaders = (message: Ably.InboundMessage): Record<string, string> => {
  // CAST: Ably SDK types `extras` as `any`; runtime checks below guard access.
  const extras = message.extras as unknown;
  if (!extras || typeof extras !== 'object') return {};
  const headers = (extras as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return {};
  // CAST: Ably documents `extras.headers` as a flat string map when present,
  // verified object-shaped by the runtime guards above.
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
 * Parse a string as JSON, falling back to the raw string when it isn't valid
 * JSON. An empty string yields `undefined`. Used for accumulated stream text
 * whose payload may be JSON or a plain string.
 * @param value - The string to parse.
 * @returns The parsed value, the raw string on parse failure, or undefined if empty.
 */
export const parseJsonOrString = (value: string): unknown => {
  if (!value) return undefined;
  try {
    // CAST: JSON.parse returns any; unknown is the safe trust-boundary type.
    return JSON.parse(value) as unknown;
  } catch {
    return value;
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
