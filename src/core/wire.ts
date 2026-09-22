/**
 * The `extras` vocabulary: the two `extras` keys this SDK writes and the
 * fields under them.
 *
 * Two layers write there and neither imports the other, so the names live
 * here. Under `ai`, the key Ably reserves for this SDK, the codec builder
 * writes `type`, which picks the row on decode, and `fields`, a row's event
 * fields that travel beside an appended body, nested values as they are. The
 * transport's pipe writer writes `stream`, `true` on a write that streams (the
 * publish that opens a key, each append, and the repair of a failed one), and
 * `ends`, the serial of the message a key's closer ends. An `update:` write
 * replaces a message's content, so the writer leaves `stream` off it and the
 * decoder core reads it whole. Ably stores the last write's
 * extras on an appended message, so `stream` is on a streamed message however
 * it is read back, and the decoder core reads both fields to know which
 * messages to remember, when to forget them, and which updates reduce to the
 * text a subscriber has not seen.
 *
 * Under `headers`, the key Ably provides for a publisher's own fields and the
 * one its server-side filtering reads, the builder writes a row's `headers`
 * and the transport adds a `send` or `pipe` call's headers, preferring the
 * row's where both name a key. Ably admits only a flat map of string, number,
 * boolean and null values there (error 40032 otherwise).
 */

import type * as Ably from 'ably';

/** The `extras` key Ably reserves for this SDK. */
export const EXTRAS_KEY = 'ai';

/** Builder: the event type that picks the row on decode. */
export const TYPE_FIELD = 'type';

/** Builder: a row's event fields, nested values as they are. */
export const FIELDS_FIELD = 'fields';

/** Transport: `true` on a write that streams, so a streamed message is marked however it is read back. An `update:` write goes without it. */
export const STREAM_FIELD = 'stream';

/** Transport: on the message that ends a key, the serial of the message it ends. */
export const ENDS_FIELD = 'ends';

/** The `extras` key Ably provides for a publisher's own fields, the one its filtering reads. A row's `headers` go under it, over the headers of the `send` or `pipe` call that published the message. */
export const HEADERS_KEY = 'headers';

/** A value Ably admits under `extras.headers` as it is. */
export type HeaderPrimitive = string | number | boolean | null;

export const isHeaderPrimitive = (value: unknown): value is HeaderPrimitive =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

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
