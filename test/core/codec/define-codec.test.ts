import * as Ably from 'ably';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Codec,
  DecodedRow,
  EncodedMessage,
  EncodedRow,
  EventRow,
  EventRows,
  RowEvent,
} from '../../../src/core/codec/index.js';
import { defineCodec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { deliveriesOf, encodeAll, historyOf } from '../../helper/wire.js';

// ---------------------------------------------------------------------------
// Fixture: a union discriminated on `type`, with a template member
// ---------------------------------------------------------------------------

type TestEvent =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'note'; text: string; important?: boolean }
  | { type: 'ping' }
  | { type: `data-${string}`; payload: unknown };

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The fixture's rows. A function, so a test that needs a fresh decoder core
 * gets a fresh codec.
 * @returns The event table.
 */
const testEvents = (): EventRows<TestEvent, TestEvent['type']> => ({
  'text-start': {
    encode: (e) => ({ headers: { id: e.id } }),
    decode: ({ headers }) => ({ type: 'text-start', id: asString(headers.id) }),
  },
  'text-delta': {
    encode: (e) => ({ data: e.delta, headers: { id: e.id }, append: e.id }),
    decode: ({ data, headers }) => ({ type: 'text-delta', id: asString(headers.id), delta: asString(data) }),
  },
  'text-end': {
    encode: (e) => ({ headers: { id: e.id }, ends: e.id }),
    decode: ({ headers }) => ({ type: 'text-end', id: asString(headers.id) }),
  },
  note: {
    encode: (e) => ({ name: 'notes', data: e.text, headers: { important: e.important } }),
    decode: ({ data, headers }) => ({ type: 'note', text: asString(data), important: headers.important === true }),
  },
  ping: {
    // eslint-disable-next-line unicorn/no-useless-undefined -- a row that publishes nothing returns undefined
    encode: () => undefined,
    decode: () => ({ type: 'ping' }),
  },
  'data-*': {
    encode: (e) => ({ data: e.payload }),
    // CAST: the builder hands over the concrete `data-…` type it matched; the row trusts it.
    decode: ({ data, type }) => ({ type: type as `data-${string}`, payload: data }),
  },
});

const testCodec = defineCodec({
  name: 'chat',
  adapterTag: 'test-codec',
  typeOf: (e: TestEvent) => e.type,
  events: testEvents(),
});

interface InboundOptions {
  action?: Ably.InboundMessage['action'];
  serial?: string;
  data?: unknown;
  /** The builder's fields, all primitive: `type` goes under `extras.ai`, the rest under `extras.headers`. */
  fields?: Record<string, unknown>;
  /** The whole `extras`, verbatim, for a message that is not the codec's or that carries JSON-encoded headers. */
  extras?: unknown;
  version?: string;
}

/**
 * The `extras` the builder writes for a set of primitive fields: `type` under
 * `ai`, the rest under `headers` when there are any.
 * @param fields - The fields.
 * @param fields.type - The event type.
 * @returns The extras.
 */
const extrasFor = ({ type, ...headers }: Record<string, unknown>): Record<string, unknown> =>
  Object.keys(headers).length > 0 ? { ai: { type }, headers } : { ai: { type } };

const inbound = (opts: InboundOptions): Ably.InboundMessage =>
  ({
    action: opts.action ?? 'message.create',
    serial: opts.serial ?? 's1',
    data: 'data' in opts ? opts.data : '',
    extras: 'extras' in opts ? opts.extras : extrasFor(opts.fields ?? { type: 'note' }),
    version: opts.version === undefined ? {} : { serial: opts.version },
    // CAST: a minimal InboundMessage stub with the fields decode reads.
  }) as Ably.InboundMessage;

/**
 * A one-row codec over a single-member union, for shape and error tests.
 * @param encode - The single row's encode.
 * @returns The codec.
 */
const singleRow = (encode: () => ReturnType<EventRow<{ type: 'a' }, 'a'>['encode']>): Codec<{ type: 'a' }> =>
  defineCodec({
    typeOf: (e: { type: 'a' }) => e.type,
    events: { a: { encode, decode: () => ({ type: 'a' }) } },
  });

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

describe('defineCodec', () => {
  describe('encode', () => {
    it('writes the type under extras.ai, the headers under extras.headers, and the default name', () => {
      expect(testCodec.encode({ type: 'text-start', id: 'msg_1' })).toEqual([
        { message: { name: 'chat', data: '', extras: { ai: { type: 'text-start' }, headers: { id: 'msg_1' } } } },
      ]);
    });

    it('writes no extras.headers when the row supplies none', () => {
      expect(singleRow(() => ({})).encode({ type: 'a' })[0]?.message.extras).toEqual({ ai: { type: 'a' } });
      expect(singleRow(() => ({ headers: {} })).encode({ type: 'a' })[0]?.message.extras).toEqual({
        ai: { type: 'a' },
      });
    });

    it('keeps a primitive header as it is, drops an undefined one, and JSON-encodes a nested one', () => {
      // eslint-disable-next-line unicorn/no-null -- null is a value Ably admits under extras.headers as it is
      const nothing = null;
      const codec = singleRow(() => ({
        headers: { n: 1, b: false, z: nothing, s: 'x', gone: undefined, obj: { city: 'London' }, arr: [1, 2] },
      }));
      expect(codec.encode({ type: 'a' })[0]?.message.extras).toEqual({
        ai: { type: 'a', json: ['obj', 'arr'] },
        headers: { n: 1, b: false, z: nothing, s: 'x', obj: '{"city":"London"}', arr: '[1,2]' },
      });
    });

    it('lists no json keys when every header is primitive', () => {
      const codec = singleRow(() => ({ headers: { s: 'x' } }));
      expect(codec.encode({ type: 'a' })[0]?.message.extras).toEqual({ ai: { type: 'a' }, headers: { s: 'x' } });
    });

    it('carries a publish key through', () => {
      const codec = singleRow(() => ({ publish: 'k' }));
      expect(codec.encode({ type: 'a' })).toEqual([
        { message: { name: 'ai', data: '', extras: { ai: { type: 'a' } } }, publish: 'k' },
      ]);
    });

    it('marks a message ephemeral at the top level of extras when the row asks', () => {
      const codec = singleRow(() => ({ ephemeral: true }));
      expect(codec.encode({ type: 'a' })[0]?.message.extras).toEqual({ ai: { type: 'a' }, ephemeral: true });
    });

    it('writes no ephemeral flag when the row does not ask', () => {
      const codec = singleRow(() => ({ ephemeral: false }));
      expect(codec.encode({ type: 'a' })[0]?.message.extras).toEqual({ ai: { type: 'a' } });
    });

    it('lets a row name its own message', () => {
      expect(testCodec.encode({ type: 'note', text: 'hi', important: true })).toEqual([
        { message: { name: 'notes', data: 'hi', extras: { ai: { type: 'note' }, headers: { important: true } } } },
      ]);
    });

    it('names an append as it names a publish, since the first append of a stream opens its message', () => {
      expect(testCodec.encode({ type: 'text-delta', id: 'msg_1', delta: 'Hello' })).toEqual([
        {
          message: { name: 'chat', data: 'Hello', extras: { ai: { type: 'text-delta' }, headers: { id: 'msg_1' } } },
          append: 'msg_1',
        },
      ]);
    });

    it('carries ends beside a plain publish', () => {
      expect(testCodec.encode({ type: 'text-end', id: 'msg_1' })).toEqual([
        {
          message: { name: 'chat', data: '', extras: { ai: { type: 'text-end' }, headers: { id: 'msg_1' } } },
          ends: 'msg_1',
        },
      ]);
    });

    it('returns no message when the row publishes nothing', () => {
      expect(testCodec.encode({ type: 'ping' })).toEqual([]);
    });

    it('returns exactly one message for a row that produces one', () => {
      expect(testCodec.encode({ type: 'note', text: 'hi' })).toHaveLength(1);
    });

    it('routes a template type through its wildcard row and stamps the concrete type', () => {
      expect(testCodec.encode({ type: 'data-weather', payload: { temp: 21 } })).toEqual([
        { message: { name: 'chat', data: { temp: 21 }, extras: { ai: { type: 'data-weather' } } } },
      ]);
    });

    it('sends a type header like any other, beside the type it writes under extras.ai', () => {
      const codec = singleRow(() => ({ headers: { type: 'forged', keep: 1 } }));
      expect(codec.encode({ type: 'a' })[0]?.message.extras).toEqual({
        ai: { type: 'a' },
        headers: { type: 'forged', keep: 1 },
      });
    });

    it('defaults the message name to ai', () => {
      const codec = singleRow(() => ({}));
      expect(codec.encode({ type: 'a' })[0]?.message.name).toBe('ai');
    });

    it('throws for an event type with no row', () => {
      // CAST: force a type the table does not list past the compile-time check.
      const rogue = { type: 'rogue' } as unknown as TestEvent;
      expect(() => testCodec.encode(rogue)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to encode event; no row for type 'rogue'",
      });
    });

    it('throws when a row sets more than one destination', () => {
      const codec = singleRow(() => ({ publish: 'k', append: 'k' }));
      expect(() => codec.encode({ type: 'a' })).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // ---------------------------------------------------------------------------
  // Decode
  // ---------------------------------------------------------------------------

  describe('decode', () => {
    // A fresh codec per test: the decoder core inside a built codec remembers
    // every stream it has seen, and these tests reuse serials.
    let codec: Codec<TestEvent>;
    beforeEach(() => {
      codec = defineCodec({ typeOf: (e: TestEvent) => e.type, events: testEvents() });
    });

    it('picks the row from the type header, and returns exactly one event for it', () => {
      expect(codec.decode(inbound({ data: 'hi', fields: { type: 'note', important: true } }))).toEqual([
        { type: 'note', text: 'hi', important: true },
      ]);
    });

    it('hands the row the body: the name, the type it matched, the data, and the headers as the wire carries them', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: TestEvent) => e.type,
        events: {
          ...testEvents(),
          'data-*': {
            encode: (e) => ({ data: e.payload }),
            decode: (body) => {
              bodies.push(body);
              return { type: 'data-weather', payload: body.data };
            },
          },
        },
      });
      // CAST: a minimal InboundMessage stub with a name, as a publish carries.
      recording.decode({ ...inbound({ data: 1, fields: { type: 'data-weather', unit: 'C' } }), name: 'chat' });
      expect(bodies).toEqual([{ name: 'chat', type: 'data-weather', data: 1, headers: { unit: 'C' } }]);
    });

    it('leaves the name off the body when the message carries none', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: TestEvent) => e.type,
        events: {
          ...testEvents(),
          'text-delta': {
            encode: (e) => ({ data: e.delta, append: e.id }),
            decode: (body) => {
              bodies.push(body);
              return { type: 'text-delta', id: '', delta: '' };
            },
          },
        },
      });
      recording.decode(inbound({ serial: 's9', fields: { type: 'text-start', id: 'msg_1' } }));
      recording.decode(
        inbound({
          serial: 's9',
          action: 'message.append',
          data: 'Hi',
          fields: { type: 'text-delta' },
          version: 's9:v2',
        }),
      );
      expect(bodies).toEqual([{ type: 'text-delta', data: 'Hi', headers: {} }]);
    });

    it('parses the headers listed under extras.ai.json and leaves the rest as they are', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: { type: 'a' }) => e.type,
        events: {
          a: {
            encode: () => ({}),
            decode: (body) => {
              bodies.push(body);
              return { type: 'a' };
            },
          },
        },
      });
      recording.decode(
        inbound({
          extras: {
            ai: { type: 'a', json: ['obj', 'arr', 'missing', 'notText'] },
            headers: { n: 1, s: '[1]', obj: '{"city":"London"}', arr: '[1,2]', notText: 7 },
          },
        }),
      );
      expect(bodies).toEqual([
        { type: 'a', data: '', headers: { n: 1, s: '[1]', obj: { city: 'London' }, arr: [1, 2], notText: 7 } },
      ]);
    });

    it('hands decode the type it matched, separate from the headers', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: TestEvent) => e.type,
        events: {
          ...testEvents(),
          // A row that spreads its whole event, `type` included, as the
          // provider codecs do.
          'data-*': {
            encode: (e) => ({ headers: { ...e } }),
            decode: (body) => {
              bodies.push(body);
              return { type: 'data-weather', payload: body.headers.payload };
            },
          },
        },
      });
      const [delivery] = deliveriesOf(recording.encode({ type: 'data-weather', payload: 21 }));
      if (delivery === undefined) throw new Error('fixture');
      recording.decode(delivery);
      // The body's type is the builder's, from extras.ai; the headers still
      // carry the row's own copy.
      expect(bodies[0]).toEqual({
        name: 'ai',
        type: 'data-weather',
        data: '',
        headers: { type: 'data-weather', payload: 21 },
      });

      // A type header that disagrees with extras.ai.type reaches the row as
      // is, and the body's type is still the builder's.
      recording.decode(
        inbound({ serial: 's2', extras: { ai: { type: 'data-weather' }, headers: { type: 'forged', payload: 1 } } }),
      );
      expect(bodies[1]?.type).toBe('data-weather');
      expect(bodies[1]?.headers).toEqual({ type: 'forged', payload: 1 });

      // No type header on the wire: the body's type is there all the same, and
      // nothing is added to the headers.
      recording.decode(inbound({ serial: 's3', extras: { ai: { type: 'data-weather' }, headers: { payload: 2 } } }));
      expect(bodies[2]?.type).toBe('data-weather');
      expect(bodies[2]?.headers).toEqual({ payload: 2 });
    });

    it('round-trips a type header unmodified', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: { type: 'a' }) => e.type,
        events: {
          a: {
            encode: () => ({ headers: { type: 'forged', keep: 1 } }),
            decode: (body) => {
              bodies.push(body);
              return { type: 'a' };
            },
          },
        },
      });
      const encoded = recording.encode({ type: 'a' });
      expect(encoded[0]?.message.extras).toEqual({ ai: { type: 'a' }, headers: { type: 'forged', keep: 1 } });
      const [delivery] = deliveriesOf(encoded);
      if (delivery === undefined) throw new Error('fixture');
      recording.decode(delivery);
      expect(bodies).toEqual([{ name: 'ai', type: 'a', data: '', headers: { type: 'forged', keep: 1 } }]);
    });

    it('hands the row empty headers when extras.headers is missing or not an object', () => {
      const bodies: DecodedRow[] = [];
      const recording = defineCodec({
        typeOf: (e: { type: 'a' }) => e.type,
        events: {
          a: {
            encode: () => ({}),
            decode: (body) => {
              bodies.push(body);
              return { type: 'a' };
            },
          },
        },
      });
      recording.decode(inbound({ extras: { ai: { type: 'a' } } }));
      recording.decode(inbound({ serial: 's2', extras: { ai: { type: 'a' }, headers: 'nope' } }));
      expect(bodies).toEqual([
        { type: 'a', data: '', headers: {} },
        { type: 'a', data: '', headers: {} },
      ]);
    });

    it('throws InvalidArgument when a listed header is not valid JSON', () => {
      // One decode per serial: the decoder core treats a second call for the
      // same serial as a replay and returns nothing.
      let thrown: unknown;
      try {
        codec.decode(inbound({ extras: { ai: { type: 'note', json: ['bad'] }, headers: { bad: '{nope' } } }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      const message = thrown instanceof Ably.ErrorInfo ? thrown.message : '';
      expect(message).toContain("unable to decode message; header 'bad' of type 'note' is not valid JSON");
    });

    it('returns no event for a message with no extras.type', () => {
      expect(codec.decode(inbound({ data: { text: 'foreign' }, extras: { headers: { topic: 'x' } } }))).toEqual([]);
      expect(codec.decode(inbound({ data: 'foreign', extras: undefined }))).toEqual([]);
      expect(codec.decode(inbound({ fields: { type: 42 } }))).toEqual([]);
    });

    it('throws for a recognised type with no row', () => {
      expect(() => codec.decode(inbound({ fields: { type: 'rogue' } }))).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to decode message; no row for type 'rogue'",
      });
    });

    it('does not resolve a wire type through Object.prototype', () => {
      expect(() => codec.decode(inbound({ fields: { type: 'valueOf' } }))).toThrowErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('routes a concrete data- type through the wildcard row and hands it the concrete type', () => {
      expect(codec.decode(inbound({ data: { temp: 21 }, fields: { type: 'data-weather' } }))).toEqual([
        { type: 'data-weather', payload: { temp: 21 } },
      ]);
    });

    it('hands the row an append with its fragment', () => {
      const codec = defineCodec({ typeOf: (e: TestEvent) => e.type, events: testEvents() });
      codec.decode(inbound({ serial: 's9', fields: { type: 'text-start', id: 'msg_1' } }));
      expect(
        codec.decode(
          inbound({
            serial: 's9',
            action: 'message.append',
            data: 'Hello',
            fields: { type: 'text-delta', id: 'msg_1' },
            version: 's9:v2',
          }),
        ),
      ).toEqual([{ type: 'text-delta', id: 'msg_1', delta: 'Hello' }]);
    });

    it('hands the row a full-content update as its unseen tail', () => {
      const codec = defineCodec({ typeOf: (e: TestEvent) => e.type, events: testEvents() });
      codec.decode(inbound({ serial: 's9', fields: { type: 'text-start', id: 'msg_1' } }));
      codec.decode(
        inbound({
          serial: 's9',
          action: 'message.append',
          data: 'Hello',
          fields: { type: 'text-delta', id: 'msg_1' },
          version: 's9:v2',
        }),
      );
      expect(
        codec.decode(
          inbound({
            serial: 's9',
            action: 'message.update',
            data: 'Hello world',
            fields: { type: 'text-delta', id: 'msg_1' },
            version: 's9:v3',
          }),
        ),
      ).toEqual([{ type: 'text-delta', id: 'msg_1', delta: ' world' }]);
    });

    it('drops a replay of a stream message the decoder core has already seen', () => {
      const create = inbound({
        serial: 's9',
        data: 'Hello',
        extras: { ai: { type: 'text-delta', stream: true }, headers: { id: 'msg_1' } },
      });
      expect(codec.decode(create)).toEqual([{ type: 'text-delta', id: 'msg_1', delta: 'Hello' }]);
      expect(codec.decode(create)).toEqual([]);
    });

    it('decodes a replayed plain publish again, since only stream messages are remembered', () => {
      const create = inbound({ serial: 's9', fields: { type: 'text-start', id: 'msg_1' } });
      expect(codec.decode(create)).toEqual([{ type: 'text-start', id: 'msg_1' }]);
      expect(codec.decode(create)).toEqual([{ type: 'text-start', id: 'msg_1' }]);
    });

    it('decodes a finished stream read back from history as the events the agent produced, with the deltas joined', () => {
      const encoded = encodeAll(codec, [
        { type: 'text-start', id: 'm1' },
        { type: 'text-delta', id: 'm1', delta: 'Hello' },
        { type: 'text-delta', id: 'm1', delta: ' world' },
        { type: 'text-end', id: 'm1' },
      ]);
      // Decoded live first. The closer frees the deltas' message, so history
      // then decodes as a fresh read of the same stream.
      for (const delivery of deliveriesOf(encoded)) codec.decode(delivery);
      expect(historyOf(encoded).flatMap((m) => codec.decode(m))).toEqual([
        { type: 'text-start', id: 'm1' },
        { type: 'text-delta', id: 'm1', delta: 'Hello world' },
        { type: 'text-end', id: 'm1' },
      ]);
    });

    it('returns no event for a delete', () => {
      expect(codec.decode(inbound({ action: 'message.delete', fields: { type: 'note' } }))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Codec shape
  // ---------------------------------------------------------------------------

  describe('codec shape', () => {
    it('exposes encode, decode and the adapter tag', () => {
      expect(Object.keys(testCodec).toSorted()).toEqual(['adapterTag', 'decode', 'encode']);
      expect(testCodec.adapterTag).toBe('test-codec');
    });

    it('omits adapterTag when none is given', () => {
      expect(Object.keys(singleRow(() => ({}))).toSorted()).toEqual(['decode', 'encode']);
    });

    it('rejects a wildcard key with no prefix', () => {
      expect(() =>
        defineCodec({
          typeOf: (e: { type: string }) => e.type,
          events: { '-*': { encode: () => ({}), decode: () => ({ type: 'x' }) } },
        }),
      ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  describe('types', () => {
    it('narrows a row to its member when the union has a type field', () => {
      expectTypeOf<RowEvent<TestEvent, 'text-delta'>>().toEqualTypeOf<{
        type: 'text-delta';
        id: string;
        delta: string;
      }>();
      expectTypeOf<RowEvent<TestEvent, 'data-*'>>().toEqualTypeOf<{ type: `data-${string}`; payload: unknown }>();
    });

    it('hands a union without a type field to the row whole', () => {
      type Kinded = { kind: 'a'; a: number } | { kind: 'b'; b: string };
      expectTypeOf<RowEvent<Kinded, 'a'>>().toEqualTypeOf<Kinded>();
    });

    it('requires a row for every type typeOf returns', () => {
      type Kinded = { kind: 'a'; a: number } | { kind: 'b'; b: string };
      const complete: Codec<Kinded> = defineCodec({
        typeOf: (e: Kinded) => e.kind,
        events: {
          a: { encode: (e) => ({ data: e.kind === 'a' ? e.a : 0 }), decode: () => ({ kind: 'a', a: 1 }) },
          b: { encode: () => ({}), decode: () => ({ kind: 'b', b: '' }) },
        },
      });
      expect(complete.encode({ kind: 'a', a: 2 })[0]?.message.data).toBe(2);

      defineCodec({
        typeOf: (e: Kinded) => e.kind,
        // @ts-expect-error a row for `b` is missing
        events: { a: { encode: () => ({}), decode: () => ({ kind: 'a', a: 1 }) } },
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the ping row
      const { ping, ...withoutPing } = testEvents();
      defineCodec({
        typeOf: (e: TestEvent) => e.type,
        // @ts-expect-error a row for `ping` is missing
        events: withoutPing,
      });
    });

    it('types a row by its key', () => {
      expectTypeOf<EventRow<TestEvent, 'note'>['encode']>().parameter(0).toEqualTypeOf<{
        type: 'note';
        text: string;
        important?: boolean;
      }>();
    });

    it('keeps a row one-to-one while the codec it builds speaks arrays', () => {
      expectTypeOf<EventRow<TestEvent, 'note'>['encode']>().returns.toEqualTypeOf<EncodedRow | undefined>();
      expectTypeOf<EventRow<TestEvent, 'note'>['decode']>().returns.toEqualTypeOf<TestEvent>();
      expectTypeOf<Codec<TestEvent>['encode']>().returns.toEqualTypeOf<EncodedMessage[]>();
      expectTypeOf<Codec<TestEvent>['decode']>().returns.toEqualTypeOf<TestEvent[]>();
    });
  });
});
