/**
 * The `extras.ai` vocabulary: the `extras` key Ably reserves for this SDK and
 * the fields written under it.
 *
 * Two layers write there and neither imports the other, so the names live
 * here. The codec builder writes `type`, which picks the row on decode, and
 * `json`, the header keys whose values travel as JSON text. The transport's
 * pipe writer writes `stream`, `true` on every write under a live key (the
 * publish that opens the key, each append and each update), and `ends`, the
 * serial of the message a key's closer ends. Ably stores the last write's
 * extras on an appended message, so `stream` is on a stream's message however
 * it is read back, and the decoder core reads both fields to know which
 * messages to remember and when to forget them.
 */

import type * as Ably from 'ably';

/** The `extras` key Ably reserves for this SDK. */
export const EXTRAS_KEY = 'ai';

/** Builder: the event type that picks the row on decode. */
export const TYPE_FIELD = 'type';

/** Builder: the header keys whose values travel as JSON text. */
export const JSON_FIELD = 'json';

/** Transport: `true` on every write under a live key, so a stream's message is marked however it is read back. */
export const STREAM_FIELD = 'stream';

/** Transport: on the message that ends a key, the serial of the message it ends. */
export const ENDS_FIELD = 'ends';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The object under `extras.ai`, or `undefined` when the message carries none.
 * @param extras - A message's `extras`.
 * @returns The SDK's own fields.
 */
export const readOwnExtras = (extras: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(extras)) return undefined;
  const own = extras[EXTRAS_KEY];
  return isRecord(own) ? own : undefined;
};

/**
 * A copy of `message` with `field` set under `extras.ai`. Neither `message`
 * nor its `extras` is mutated; `extras` and `ai` are created when absent.
 * @param message - The message to stamp.
 * @param field - The field under `extras.ai`.
 * @param value - Its value.
 * @returns The stamped copy.
 */
export const withOwnField = (message: Ably.Message, field: string, value: unknown): Ably.Message => {
  // CAST: Ably types `extras` as `any`; the guards narrow it.
  const current = message.extras as unknown;
  const extras = isRecord(current) ? current : {};
  const own = isRecord(extras[EXTRAS_KEY]) ? extras[EXTRAS_KEY] : {};
  return { ...message, extras: { ...extras, [EXTRAS_KEY]: { ...own, [field]: value } } };
};
