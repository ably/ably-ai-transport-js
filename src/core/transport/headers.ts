/**
 * The headers a `send` or `pipe` call attaches to every message it publishes.
 *
 * They ride under `extras.headers`, the key Ably provides for a publisher's
 * own fields, alongside the headers the codec's decode row wrote. Where both
 * name a key the row's value is preferred, so a row keeps a header it sets.
 * Ably admits only a flat map of string, number, boolean and null values under
 * that key, so the type admits the same, and `prepareHeaders` checks it once
 * per call, before anything is published, for a caller outside TypeScript or
 * behind a cast.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { type HeaderPrimitive, HEADERS_KEY, isHeaderPrimitive, isRecord } from '../wire.js';

/**
 * The headers a `send` or `pipe` call attaches to every message it publishes:
 * a flat map of the values Ably stores under `extras.headers`.
 */
export type MessageHeaders = Record<string, HeaderPrimitive>;

/**
 * Check a call's headers before anything is published. An `undefined` value is
 * dropped, as the builder drops an `undefined` row header; any other value
 * outside string, number, boolean and null is rejected.
 * @param headers - The call's headers, or `undefined` for none.
 * @param operation - The call, for the error message.
 * @returns The headers to publish, or `undefined` when there are none.
 * @throws {Ably.ErrorInfo} `InvalidArgument` naming the first key whose value Ably would not store.
 */
export const prepareHeaders = (
  headers: Record<string, unknown> | undefined,
  operation: 'send' | 'pipe',
): MessageHeaders | undefined => {
  if (headers === undefined) return undefined;
  const prepared: MessageHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!isHeaderPrimitive(value)) {
      throw new Ably.ErrorInfo(
        `unable to ${operation}; header '${key}' is not a string, number, boolean or null`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    prepared[key] = value;
  }
  return Object.keys(prepared).length === 0 ? undefined : prepared;
};

/**
 * A copy of `message` with `headers` upserted into its `extras.headers`,
 * preferring the header keys already in the message. `extras.ai` and every
 * other extras key are untouched; an `extras.headers` that is not an object is
 * treated as absent. Neither `message` nor its `extras` is mutated.
 * @param message - The message to stamp.
 * @param headers - The call's headers.
 * @returns The stamped copy.
 */
export const withHeaders = (message: Ably.Message, headers: MessageHeaders): Ably.Message => {
  // CAST: Ably types `extras` as `any`; the guards narrow it.
  const current = message.extras as unknown;
  const extras = isRecord(current) ? current : {};
  const own = isRecord(extras[HEADERS_KEY]) ? extras[HEADERS_KEY] : {};
  return { ...message, extras: { ...extras, [HEADERS_KEY]: { ...headers, ...own } } };
};
