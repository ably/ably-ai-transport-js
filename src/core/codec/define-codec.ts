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
 * contract speaks. A row speaks in three things: `data`, the message body;
 * `fields`, the event fields that must stay out of a body that appends grow;
 * and `headers`, the Ably headers a codec author sets on purpose. On every
 * message it encodes the builder writes `data` as the body, the row's `fields`
 * and its own `type` under `extras.ai`, and the row's `headers` under
 * `extras.headers`, reads them back on decode, applies a default message
 * `name` to a message that names none, and wraps `decode` with the decoder
 * core so a late joiner's full-content update reaches the row as the unseen
 * tail, a row's `update:` reaches it whole, and replays are dropped.
 *
 * Ably accepts only known keys at the top of `extras` and rejects a publish
 * carrying any other. `ai` is the key the platform reserves for this SDK, and
 * a value under it travels as it is, nested objects and arrays included. The
 * builder writes two fields there, the `type` that picks the row and the row's
 * `fields`; the transport writes two more on the messages that build a stream
 * and on the message that ends a key (see `src/core/wire.ts`); the builder
 * reads its own two and ignores the rest. `headers` is the key Ably provides for a publisher's own fields and
 * the one its server-side filtering reads. Ably admits only a flat map of
 * string, number, boolean and null values under it (error 40032 otherwise),
 * so a row's `headers` are typed to that and written as given; the builder
 * translates nothing. An `undefined` value in either map is dropped. The
 * transport adds the headers of the publishing `send` or `pipe` call and
 * prefers a row's where both name a key, so a row keeps a header it writes
 * and its decode sees the merged map. The
 * builder hands the type it matched to a row's decode on the body. A row that
 * puts a `type` in its own fields sends it like any other field and gets it
 * back unchanged. A row never sees `extras`, and a hand-written codec may put
 * its type anywhere Ably allows.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import {
  EXTRAS_KEY,
  FIELDS_FIELD,
  type HeaderPrimitive,
  HEADERS_KEY,
  isRecord,
  readOwnExtras,
  TYPE_FIELD,
} from '../wire.js';
import type { Codec, EncodedMessage } from './codec.js';
import { createDecoderCore } from './decoder.js';

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
 * beside it (see {@link DecodedRow}): `data` is what this delivery adds,
 * `fields` is what the row's encode wrote, and `headers` is `extras.headers`
 * as delivered.
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
   * The message body, Ably's `data`. For a message that is appended to, the
   * text this delivery adds, and the one field appends concatenate; for a
   * plain publish, whatever the row puts there, an object included. Defaults
   * to an empty string. On decode, an append's fragment, the unseen tail of a
   * stream's full-content update after the decoder core has reduced it, a
   * plain publish's body as delivered, or the body a row's `update:` wrote,
   * which replaces the message's content and reaches the row whole.
   */
  data?: unknown;
  /**
   * The event fields that travel beside `data` when the message is appended
   * to, since an append grows `data` and carries nothing else. Written under
   * `extras.ai.fields` as given, nested objects and arrays included; an
   * `undefined` value is dropped, and a row that gives none writes no key.
   * Survives a repair update untouched. A `type` key here is ordinary: the
   * builder neither reads it nor writes it. On decode, always present (empty
   * when the message carries none) and exactly what encode wrote: a `send` or
   * `pipe` call's headers never reach here, since they ride under
   * `extras.headers`. The type the builder matched arrives as
   * {@link DecodedRow.type}, not in here.
   */
  fields?: Record<string, unknown>;
  /**
   * Ably headers, written under `extras.headers` as given. Ably's server-side
   * filtering reads that key, so this is for a field a codec author wants
   * exposed there on purpose; an event's own fields belong in `fields`. Ably
   * admits only a flat map of string, number, boolean and null values (error
   * 40032 otherwise), and the type admits the same; the builder checks
   * nothing at runtime. An `undefined` value is dropped, and a row that gives
   * none writes no key. On decode, `extras.headers` as delivered, which
   * includes any headers the call that published the message attached beside
   * the row's own: the wire cannot tell them apart, so a row that spreads
   * this map onto an event takes the caller's headers with it.
   */
  headers?: Record<string, HeaderPrimitive | undefined>;
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
  /** What `extras.ai.fields` carries; empty when the message carries none. */
  fields: Record<string, unknown>;
  /** What `extras.headers` carries, as delivered: the row's headers, plus any the publishing call attached, the row's preferred where both name a key. Empty when the message carries none. */
  headers: Record<string, HeaderPrimitive>;
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
   * `fields` is what encode wrote and nothing more, `headers` is what encode
   * wrote over the publishing call's headers, and `type` is the type the
   * builder matched.
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
  /** The row's fields, empty when the message carries none. */
  fields: Record<string, unknown>;
}

/**
 * Read the builder's own fields off an inbound message: the object under
 * `extras.ai`, when it has a string `type`. Anything else is not this
 * builder's message. The type picks the row and is not copied into the
 * fields; a row that wants it there wrote it there. A `fields` value that is
 * not an object reads as empty.
 * @param message - The inbound message.
 * @returns The fields, or `undefined`.
 */
const readOwn = (message: Ably.InboundMessage): OwnFields | undefined => {
  const own = readOwnExtras(message.extras);
  if (own === undefined) return undefined;
  const type = own[TYPE_FIELD];
  if (typeof type !== 'string') return undefined;
  const fields = own[FIELDS_FIELD];
  return { type, fields: isRecord(fields) ? fields : {} };
};

/**
 * The map under `extras.headers` as delivered, the row's headers over any the
 * publishing call attached, and nothing the builder adds. Empty when the
 * message carries none or carries something that is not an object.
 * @param message - The inbound message.
 * @returns The headers.
 */
const readHeaders = (message: Ably.InboundMessage): Record<string, HeaderPrimitive> => {
  // CAST: Ably types `extras` as `any`; the guards below narrow it.
  const extras = message.extras as unknown;
  const raw = isRecord(extras) && isRecord(extras[HEADERS_KEY]) ? extras[HEADERS_KEY] : {};
  // CAST: wire trust boundary. Ably admits only string, number, boolean and
  // null values under `extras.headers` and rejects a publish carrying any
  // other, so what it delivers is that map.
  return raw as Record<string, HeaderPrimitive>;
};

/**
 * A copy of `record` without its `undefined` values, which JSON would drop
 * anyway; `undefined` when nothing is left, so the caller writes no key.
 * @param record - The row's map, or `undefined` for none.
 * @returns The copy, or `undefined` when empty.
 */
const withoutUndefined = <V>(record: Record<string, V> | undefined): Record<string, V> | undefined => {
  if (record === undefined) return undefined;
  const copy: Record<string, V> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) copy[key] = value;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
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

      const fields = withoutUndefined(produced.fields);
      const headers = withoutUndefined(produced.headers);
      const own: Record<string, unknown> = { [TYPE_FIELD]: type };
      if (fields !== undefined) own[FIELDS_FIELD] = fields;
      const extras: Record<string, unknown> = { [EXTRAS_KEY]: own };
      if (headers !== undefined) extras[HEADERS_KEY] = headers;
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
      const body: DecodedRow = {
        type: own.type,
        data: prepared.data as unknown,
        fields: own.fields,
        headers: readHeaders(prepared),
      };
      if (prepared.name !== undefined) body.name = prepared.name;
      return [row.decode(body)];
    },
  };

  // adapterTag is optional on Codec; set it only when supplied so a codec can
  // opt out of channel attribution.
  return config.adapterTag === undefined ? codec : { ...codec, adapterTag: config.adapterTag };
};
