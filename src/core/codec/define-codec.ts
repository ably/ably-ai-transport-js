/**
 * `defineCodec` — build a {@link Codec} from a table of events.
 *
 * The author supplies `typeOf`, which reads an event's type, and one
 * `{ encode, decode }` pair per type. Both speak the same body, a
 * {@link RowMessage}: `encode` returns it with routing, and `decode` receives
 * it assembled from the Ably message, with the `type` the builder matched
 * beside it (see {@link DecodedRow}). The builder derives nothing between the
 * two. A row produces at most one message and at most one event, and the built
 * codec wraps each into the zero- or one-element array the {@link Codec}
 * contract speaks. On every message it encodes it writes the row's `headers` under
 * `extras.headers` and its own fields under `extras.ai`, reads both back on
 * decode, applies a default message `name` to a message that names none, and
 * wraps `decode` with the decoder core so a late joiner's full-content update
 * reaches the row as the unseen tail and replays are dropped.
 *
 * Ably accepts only known keys at the top of `extras` and rejects a publish
 * carrying any other. `headers` is the key Ably provides for a publisher's own
 * fields, so a row's `headers` go there. The platform admits only a flat map
 * of string, number, boolean and null values under it (error 40032 otherwise),
 * and a provider's events carry nested objects and arrays, so the builder
 * writes such a value as its JSON text and lists the key under `extras.ai.json`
 * so decode can parse it back; a primitive travels as it is, and an
 * `undefined` value is dropped. `ai` is the key the platform reserves for this
 * SDK. The builder writes two fields under it, the `type` that picks the row
 * and that list, and the transport writes two more on the messages that open
 * and end a key (see `src/core/wire.ts`); the builder reads its own two and
 * ignores the rest. The builder never reads `extras.headers.type` and never
 * writes it: a row whose headers carry a `type` of their own, as one that
 * spreads a whole event does, sends it like any other header and gets it back
 * unchanged, and a row that wants the type the builder matched reads it off
 * the decode body. A row never sees `extras`, and a hand-written codec may put
 * its type anywhere Ably allows.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorMessage } from '../../utils.js';
import { EXTRAS_KEY, isRecord, JSON_FIELD, readOwnExtras, TYPE_FIELD } from '../wire.js';
import type { Codec, EncodedMessage } from './codec.js';
import { createDecoderCore } from './decoder.js';

/** The `extras` key Ably provides for a publisher's own fields; a row's `headers` go under it. */
const HEADERS_KEY = 'headers';

/** A value Ably admits under `extras.headers` as it is. */
type HeaderPrimitive = string | number | boolean | null;

const isPrimitive = (value: unknown): value is HeaderPrimitive =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The suffix that makes a row key match every type sharing its prefix (`data-*` matches `data-weather`). */
const WILDCARD_SUFFIX = '-*';

/**
 * The event types a row key selects. A wildcard key `p-*` selects the
 * template `p-${string}`; any other key selects itself.
 * @template T - The row key.
 */
export type RowEventType<T extends string> = T extends `${infer P}-*` ? `${P}-${string}` : T;

/**
 * The event a row's `encode` receives. When the union has a `type` field the
 * row key matches, the member it selects; otherwise the whole union, and the
 * row narrows for itself.
 * @template E - The codec's event union.
 * @template T - The row key.
 */
export type RowEvent<E, T extends string> = [Extract<E, { type: RowEventType<T> }>] extends [never]
  ? E
  : Extract<E, { type: RowEventType<T> }>;

/**
 * The message body a row speaks in, in both directions. On encode a row
 * returns it with routing (see {@link EncodedRow}). On decode the builder
 * hands it back, assembled from the Ably message, with the type it matched
 * beside it (see {@link DecodedRow}): `data` is what this delivery adds, and
 * `headers` is what the row's encode wrote.
 */
export interface RowMessage {
  /**
   * The Ably message name. Stamped on every message, an append or update
   * included, since Ably replaces the stored name with the one the append
   * carries and the first append of a stream may be the publish that opens it.
   * Defaults to the codec's `name`.
   */
  name?: string;
  /**
   * The appendable value, Ably's `data`. On encode, the one field appends
   * concatenate; defaults to an empty string. On decode, an append's fragment,
   * or the unseen tail of a full-content update after the decoder core has
   * reduced it.
   */
  data?: unknown;
  /**
   * Every other field the event carries, as JSON. Survives a repair update
   * untouched. Where and how they sit on the wire is the builder's choice, not
   * the row's: a nested value travels as JSON text and comes back parsed, and
   * an `undefined` value is dropped. A `type` key here is ordinary: the
   * builder neither reads it nor writes it. On decode, always present (empty
   * when the message carries none) and exactly what encode wrote; the type
   * the builder matched arrives as {@link DecodedRow.type}, not in here.
   */
  headers?: Record<string, unknown>;
}

/**
 * What a row's `decode` receives: the body, plus the type the builder matched.
 */
export interface DecodedRow extends RowMessage {
  /**
   * The type under `extras.ai`, the one the builder picked this row by. It is
   * what the encoding codec's `typeOf` returned for the event, so for a
   * wildcard row `data-*` it is the concrete type `'data-weather'`, never the
   * key.
   */
  type: string;
  /** What `extras.headers` carries, with the listed keys parsed back; empty when the message carries none. */
  headers: Record<string, unknown>;
}

/** What a row's `encode` returns: the body, plus where the message goes. */
export interface EncodedRow extends RowMessage {
  /** Publish, and remember the ack's serial under this key so later rows can append to or update it. Throws if the key is still live. See {@link EncodedMessage.publish}. */
  publish?: string;
  /** Append `data` to the message remembered under this key, or publish this message and open the key when none is live. See {@link EncodedMessage.append}. */
  append?: string;
  /** Replace the content of the message remembered under this key. See {@link EncodedMessage.update}. */
  update?: string;
  /** Forget this key once this message is written. Independent of where the message itself goes. See {@link EncodedMessage.ends}. */
  ends?: string;
  /** Publish as an ephemeral message: delivered to subscribers, kept out of history. Written as `extras.ephemeral`. */
  ephemeral?: boolean;
}

/**
 * One event type's mapping in both directions.
 * @template E - The codec's event union.
 * @template T - The row key.
 */
export interface EventRow<E, T extends string> {
  /**
   * Build the body for one event and say where it goes, or return `undefined`
   * to publish nothing for it.
   * @param event - The event, narrowed to the row's member where `E` has a `type` field.
   */
  encode(event: RowEvent<E, T>): EncodedRow | undefined;
  /**
   * Rebuild the event from the body. `data` is what this delivery adds,
   * `headers` is what encode wrote and nothing more, and `type` is the type
   * the builder matched.
   * @param message - The body, after the decoder core.
   */
  decode(message: DecodedRow): E;
}

/**
 * The table: one row per type `typeOf` returns.
 *
 * A key ending in `-*` is a wildcard: it matches every type sharing its
 * prefix, on encode and on decode alike. An exact key wins over a wildcard, so
 * `data-weather` may have its own row beside `data-*`. The builder writes the
 * concrete type to the wire, never the wildcard key.
 *
 * A missing row for a literal member is a compile error. A missing wildcard
 * row for a template member is not (a mapped type over `p-${string}` accepts
 * the key without requiring it); its absence surfaces as an `InvalidArgument`
 * throw on the first event of that type at encode.
 * @template E - The codec's event union.
 * @template K - The union of types `typeOf` returns.
 */
export type EventRows<E, K extends string> = { [T in K]: EventRow<E, T> };

/**
 * The parts {@link defineCodec} assembles a codec from.
 * @template E - The codec's event union.
 * @template K - The union of types `typeOf` returns.
 */
export interface DefineCodecConfig<E, K extends string> {
  /** The Ably message name for a message whose row names none. Defaults to `ai`. */
  name?: string;
  /** The codec's entry in the channel's `params.agent` attribution string. See {@link Codec.adapterTag}. */
  adapterTag?: string;
  /**
   * Read an event's type. Its return type is the union of row keys, so the
   * table is checked against it. Annotate the parameter with the event union:
   * `typeOf: (e: MyEvent) => e.type`.
   * @param event - The event to classify.
   * @returns The row key for the event.
   */
  typeOf: (event: E) => K;
  /** One `{ encode, decode }` pair per event type; a `-*` key covers a template member. See {@link EventRows}. */
  events: NoInfer<EventRows<E, K>>;
  /** Logger for diagnostics. */
  logger?: Logger;
}

/** The builder's own fields, read off an inbound message. */
interface OwnFields {
  /** The event type. */
  type: string;
  /** The header keys whose values travel as JSON text. */
  json: string[];
}

/**
 * Read the builder's own fields off an inbound message: the object under
 * `extras.ai`, when it has a string `type`. Anything else is not this
 * builder's message.
 * @param message - The inbound message.
 * @returns The fields, or `undefined`.
 */
const readOwn = (message: Ably.InboundMessage): OwnFields | undefined => {
  const own = readOwnExtras(message.extras);
  if (own === undefined) return undefined;
  const type = own[TYPE_FIELD];
  if (typeof type !== 'string') return undefined;
  const listed = own[JSON_FIELD];
  const json = Array.isArray(listed) ? listed.filter((key): key is string => typeof key === 'string') : [];
  return { type, json };
};

/**
 * Rebuild the row's headers from an inbound message: the map under
 * `extras.headers`, with each value listed under `extras.ai.json` parsed back
 * from its JSON text, and nothing added. The type under `extras.ai` picks the
 * row and is not copied in; a row that wants it in its headers wrote it there.
 * @param message - The inbound message.
 * @param own - The builder's own fields.
 * @returns The headers, empty when the message carries none.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a listed value is not valid JSON.
 */
const readHeaders = (message: Ably.InboundMessage, own: OwnFields): Record<string, unknown> => {
  // CAST: Ably types `extras` as `any`; the guards below narrow it.
  const extras = message.extras as unknown;
  const raw = isRecord(extras) && isRecord(extras[HEADERS_KEY]) ? extras[HEADERS_KEY] : {};
  const headers: Record<string, unknown> = { ...raw };
  for (const key of own.json) {
    const text = raw[key];
    if (typeof text !== 'string') continue;
    try {
      headers[key] = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Ably.ErrorInfo(
        `unable to decode message; header '${key}' of type '${own.type}' is not valid JSON: ${errorMessage(error)}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }
  return headers;
};

/**
 * Lay a row's headers out for the wire: primitives as they are, anything
 * nested as JSON text, `undefined` dropped. A `type` header travels like any
 * other; the builder's own copy under `extras.ai` is the one decode reads.
 * @param headers - The row's headers.
 * @returns The flat map, and the keys that were encoded.
 */
const flattenHeaders = (
  headers: Record<string, unknown> | undefined,
): { flat: Record<string, HeaderPrimitive>; json: string[] } => {
  const flat: Record<string, HeaderPrimitive> = {};
  const json: string[] = [];
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (isPrimitive(value)) {
      flat[key] = value;
    } else {
      flat[key] = JSON.stringify(value);
      json.push(key);
    }
  }
  return { flat, json };
};

/**
 * Build a {@link Codec} from a table of event rows.
 * @template E - The codec's event union.
 * @template K - The union of types `typeOf` returns, inferred from it.
 * @param config - See {@link DefineCodecConfig}.
 * @returns The codec.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a row key carries the wildcard suffix with no prefix.
 */
export const defineCodec = <E, K extends string>(config: DefineCodecConfig<E, K>): Codec<E> => {
  const name = config.name ?? 'ai';
  // CAST: the table is typed per key for the author; the dispatcher reads it
  // by string, and invokes each row only with the member its key selects.
  const rows = config.events as unknown as Record<string, EventRow<E, string>>;
  const wildcards = Object.keys(rows)
    .filter((key) => key.endsWith(WILDCARD_SUFFIX))
    .map((key) => ({ key, prefix: key.slice(0, -1) }));
  for (const { prefix } of wildcards) {
    if (prefix === '-') {
      throw new Ably.ErrorInfo(
        `unable to define codec; wildcard row key '${WILDCARD_SUFFIX}' has no prefix`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }

  // Own-property lookup only: the type comes off the wire on decode, so a
  // crafted value such as 'valueOf' must not resolve through Object.prototype.
  const findRow = (type: string): EventRow<E, string> | undefined => {
    if (Object.hasOwn(rows, type)) return rows[type];
    const wildcard = wildcards.find((w) => type.startsWith(w.prefix));
    return wildcard === undefined ? undefined : rows[wildcard.key];
  };

  const core = createDecoderCore({ logger: config.logger });

  const codec: Codec<E> = {
    encode: (event) => {
      const type = config.typeOf(event);
      const row = findRow(type);
      if (row === undefined) {
        throw new Ably.ErrorInfo(`unable to encode event; no row for type '${type}'`, ErrorCode.InvalidArgument, 400);
      }
      // CAST: `findRow` selected the row by this event's type, so the event is
      // the member the row's `encode` is typed to receive.
      const produced = row.encode(event as RowEvent<E, string>);
      if (produced === undefined) return [];

      const targets = [produced.publish, produced.append, produced.update].filter((k) => k !== undefined);
      if (targets.length > 1) {
        throw new Ably.ErrorInfo(
          `unable to encode event; row '${type}' sets more than one of publish, append and update`,
          ErrorCode.InvalidArgument,
          400,
        );
      }

      const { flat, json } = flattenHeaders(produced.headers);
      const own: Record<string, unknown> = { [TYPE_FIELD]: type };
      if (json.length > 0) own[JSON_FIELD] = json;
      const extras: Record<string, unknown> = { [EXTRAS_KEY]: own };
      if (Object.keys(flat).length > 0) extras[HEADERS_KEY] = flat;
      if (produced.ephemeral === true) extras.ephemeral = true;
      const data: unknown = produced.data ?? '';
      // Every message carries a name: an append to a key not yet live is the
      // publish that opens it, and Ably keeps the name of an append anyway.
      const message: Ably.Message = { name: produced.name ?? name, data, extras };

      const encoded: EncodedMessage = { message };
      if (produced.publish !== undefined) encoded.publish = produced.publish;
      if (produced.append !== undefined) encoded.append = produced.append;
      if (produced.update !== undefined) encoded.update = produced.update;
      if (produced.ends !== undefined) encoded.ends = produced.ends;
      return [encoded];
    },
    decode: (message) => {
      const prepared = core.prepare(message);
      if (prepared === undefined) return [];
      const own = readOwn(prepared);
      if (own === undefined) return [];
      const row = findRow(own.type);
      if (row === undefined) {
        throw new Ably.ErrorInfo(
          `unable to decode message; no row for type '${own.type}'`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      const body: DecodedRow = { type: own.type, data: prepared.data as unknown, headers: readHeaders(prepared, own) };
      if (prepared.name !== undefined) body.name = prepared.name;
      return [row.decode(body)];
    },
  };

  // adapterTag is optional on Codec; set it only when supplied so a codec can
  // opt out of channel attribution.
  return config.adapterTag === undefined ? codec : { ...codec, adapterTag: config.adapterTag };
};
