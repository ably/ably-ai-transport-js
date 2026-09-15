/**
 * Shared utilities used by the codec and transport layers. They live at the
 * top level so neither layer depends on the other for them.
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
 * Returns a new object; the input is not mutated. Useful for building event
 * literals with optional fields without conditional spread noise.
 *
 * The return type converts `{ foo: T | undefined }` to `{ foo?: T }`,
 * matching the optional-field pattern used by provider event types.
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
  // CAST: The runtime strip guarantees the Stripped<T> contract:
  // required keys are always present, optional keys are absent when undefined.
  return result as Stripped<T>;
};
