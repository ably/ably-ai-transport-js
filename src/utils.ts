/**
 * Shared utilities used by the codec, adaptor and decoder layers, and by the
 * client adapters. They live at the top level so no layer or provider depends
 * on another for them.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from './errors.js';

/** How many characters of a failed response's body go into an error. */
const RESPONSE_EXCERPT_CHARS = 200;

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
 * Wrap a failure to read a channel, such as an attach the channel refused
 * or a history page that could not be fetched. The wrapped error keeps the
 * failure's code and status, `InternalError` when it has no code, and
 * carries the failure as its cause. ably-js rejects some reads with a
 * `PartialErrorInfo`, such as a history request that timed out, and an
 * `ErrorInfo` takes only an `ErrorInfo` as its cause, so such a failure is
 * carried as one.
 * @param error - The failure.
 * @returns The error to report.
 */
export const wrapReadError = (error: unknown): Ably.ErrorInfo => {
  const cause =
    error instanceof Ably.PartialErrorInfo
      ? new Ably.ErrorInfo(
          error.message,
          error.code ?? ErrorCode.InternalError,
          error.statusCode ?? 500,
          errorCause(error.cause),
        )
      : errorCause(error);
  return new Ably.ErrorInfo(
    `unable to read the channel; ${errorMessage(error)}`,
    cause?.code ?? ErrorCode.InternalError,
    cause?.statusCode ?? 500,
    cause,
  );
};

/**
 * What a failed response says about itself: the start of its body, or its
 * status text when the body is empty or cannot be read.
 * @param response - The response.
 * @returns The text.
 */
export const responseText = async (response: Response): Promise<string> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return response.statusText;
  }
  if (text === '') return response.statusText;
  return text.length > RESPONSE_EXCERPT_CHARS ? `${text.slice(0, RESPONSE_EXCERPT_CHARS)}…` : text;
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
