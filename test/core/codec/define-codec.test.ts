import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT } from '../../../src/constants.js';
import { defineCodec } from '../../../src/core/codec/define-codec.js';
import { strField } from '../../../src/core/codec/fields.js';
import type { ChannelWriter, CodecEvent, CodecMessage, ReducerMeta } from '../../../src/core/codec/types.js';
import { ErrorCode } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// Fixture codec
//
// The output variant deliberately carries a `kind` field — the exact shape the
// retired `'kind' in event` direction heuristic would have misrouted to inputs.
// The decoder must instead route by the wire message name (ai-input/ai-output).
// ---------------------------------------------------------------------------

interface QuirkyOutput {
  type: 'quirky';
  kind: string;
}

interface NoopInput {
  kind: 'noop';
  codecMessageId: string;
  payload: Record<string, never>;
}

// A minimal real reducer so the wiring tests can prove `init`/`fold`/`getMessages`
// are threaded from the supplied parts: it records every folded event and surfaces
// them through `getMessages`.
interface FixtureProjection {
  folded: (NoopInput | QuirkyOutput)[];
}

const codec = defineCodec<NoopInput, QuirkyOutput>()({
  reducer: {
    init: (): FixtureProjection => ({ folded: [] }),
    fold: (state: FixtureProjection, event: CodecEvent<NoopInput, QuirkyOutput>): FixtureProjection => {
      state.folded.push(event.event);
      return state;
    },
    getMessages: (state: FixtureProjection): CodecMessage<NoopInput | QuirkyOutput>[] =>
      state.folded.map((message, i) => ({ codecMessageId: `cm-${String(i)}`, message })),
  },
  output: ({ event }) => [
    event('quirky', {
      fields: [],
      // Rebuilds to { type: 'quirky', kind: 'looks-like-input' } — an output that
      // structurally resembles an input.
      data: { encode: () => '', decode: () => ({ kind: 'looks-like-input' }) },
    }),
  ],
  // A single event with no fields/data rebuilds to the { kind, codecMessageId, payload } envelope.
  input: ({ event }) => [event('noop')],
});

const aiMessage = (name: string, codecHeaders: Record<string, string>): Ably.InboundMessage =>
  ({
    serial: 's1',
    action: 'message.create',
    name,
    data: '',
    extras: { ai: { codec: codecHeaders, transport: {} } },
    // CAST: minimal InboundMessage stub — only the fields the decoder reads.
  }) as Ably.InboundMessage;

// A writer that records published messages so the encoder-wiring tests can
// assert what `createEncoder` puts on the wire.
const createMockWriter = (): ChannelWriter & { published: Ably.Message[] } => {
  const published: Ably.Message[] = [];
  return {
    published,
    publish: vi.fn(async (message: Ably.Message | Ably.Message[]) => {
      published.push(...(Array.isArray(message) ? message : [message]));
      return await Promise.resolve({ serials: ['serial-1'] });
    }),
    // CAST: minimal append/update stubs — the fixture codec never streams.
    appendMessage: vi.fn(async () => await Promise.resolve({} as Ably.UpdateDeleteResult)),
    updateMessage: vi.fn(async () => await Promise.resolve({} as Ably.UpdateDeleteResult)),
  };
};

// Flatten an encoded message's disjoint transport/codec header tiers into one view.
const headersOf = (msg: Ably.Message): Record<string, string> => {
  // CAST: the encoder writes headers under extras.ai.{transport,codec}.
  const extras = msg.extras as { ai?: { transport?: Record<string, string>; codec?: Record<string, string> } };
  return { ...extras.ai?.transport, ...extras.ai?.codec };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defineCodec — decoder direction routing', () => {
  it('routes an ai-output event to outputs even when it carries a `kind` field', () => {
    const decoder = codec.createDecoder();

    const { inputs, outputs } = decoder.decode(aiMessage(EVENT_AI_OUTPUT, { kind: 'quirky' }));

    // The decoded event is { type: 'quirky', kind: 'looks-like-input' }. The old
    // `'kind' in event` check would have placed it in `inputs`; routing by the wire
    // name keeps it in `outputs`. The domain `kind` field is reconstructed by the
    // data decoder and is distinct from the `kind` wire dispatch header.
    expect(outputs).toEqual([{ type: 'quirky', kind: 'looks-like-input' }]);
    expect(inputs).toEqual([]);
  });

  it('routes an ai-input message to inputs', () => {
    const decoder = codec.createDecoder();

    const { inputs, outputs } = decoder.decode(aiMessage(EVENT_AI_INPUT, { kind: 'noop' }));

    expect(inputs).toEqual([{ kind: 'noop', codecMessageId: '', payload: {} }]);
    expect(outputs).toEqual([]);
  });

  it('yields no events for an unrecognised wire name', () => {
    const decoder = codec.createDecoder();

    const { inputs, outputs } = decoder.decode(aiMessage('some-other-event', { kind: 'quirky' }));

    expect(inputs).toEqual([]);
    expect(outputs).toEqual([]);
  });
});

describe('defineCodec — encoder wiring', () => {
  it('publishes an output event as an ai-output message carrying its wire kind', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);

    await encoder.publishOutput({ type: 'quirky', kind: 'ignored-domain-field' });

    expect(writer.published).toHaveLength(1);
    const msg = writer.published[0];
    if (!msg) throw new Error('no publish');
    expect(msg.name).toBe(EVENT_AI_OUTPUT);
    // The wire dispatch `kind` is the descriptor's output type, never the
    // event's own domain `kind` field.
    expect(headersOf(msg).kind).toBe('quirky');
  });

  it('publishes an input event as an ai-input message carrying its wire kind', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);

    await encoder.publishInput({ kind: 'noop', codecMessageId: 'cm-1', payload: {} });

    expect(writer.published).toHaveLength(1);
    const msg = writer.published[0];
    if (!msg) throw new Error('no publish');
    expect(msg.name).toBe(EVENT_AI_INPUT);
    expect(headersOf(msg).kind).toBe('noop');
  });

  it('round-trips an output event through encode then decode', async () => {
    const writer = createMockWriter();
    const encoder = codec.createEncoder(writer);
    await encoder.publishOutput({ type: 'quirky', kind: 'ignored-domain-field' });

    const msg = writer.published[0];
    if (!msg) throw new Error('no publish');
    const decoder = codec.createDecoder();
    const { inputs, outputs } = decoder.decode(aiMessage(EVENT_AI_OUTPUT, headersOf(msg)));

    // The data decoder rebuilds the domain `kind`; the round-trip lands in outputs.
    expect(outputs).toEqual([{ type: 'quirky', kind: 'looks-like-input' }]);
    expect(inputs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ignored output types — the `ignore` construct
//
// A pass-through codec models only a subset of a large provider union. `ignore`
// names the events it deliberately drops on encode; any other undescribed event
// still throws, so a genuinely unexpected event is never dropped unnoticed.
// ---------------------------------------------------------------------------

type IgnoreOutput = { type: 'kept' } | { type: 'dropped' } | { type: 'surprise' };

const ignoreCodec = defineCodec<NoopInput, IgnoreOutput>()({
  reducer: {
    init: (): FixtureProjection => ({ folded: [] }),
    // The reducer is irrelevant to these encode-side tests.
    fold: (state: FixtureProjection): FixtureProjection => state,
    getMessages: (): CodecMessage<NoopInput | QuirkyOutput>[] => [],
  },
  output: ({ event, ignore }) => [event('kept'), ignore('dropped')],
  input: ({ event }) => [event('noop')],
});

describe('defineCodec — ignored output types', () => {
  it('publishes a described output type', async () => {
    const writer = createMockWriter();
    await ignoreCodec.createEncoder(writer).publishOutput({ type: 'kept' });
    expect(writer.published).toHaveLength(1);
  });

  it('drops an ignored output type silently (no publish, no throw)', async () => {
    const writer = createMockWriter();
    await ignoreCodec.createEncoder(writer).publishOutput({ type: 'dropped' });
    expect(writer.published).toHaveLength(0);
  });

  it('still throws on an output type that is neither described nor ignored', async () => {
    const writer = createMockWriter();
    await expect(ignoreCodec.createEncoder(writer).publishOutput({ type: 'surprise' })).rejects.toThrow(
      /unsupported event type 'surprise'/,
    );
  });

  it('rejects a table that both handles and ignores the same type', () => {
    expect(() =>
      defineCodec<NoopInput, IgnoreOutput>()({
        reducer: {
          init: (): FixtureProjection => ({ folded: [] }),
          fold: (state: FixtureProjection): FixtureProjection => state,
          getMessages: (): CodecMessage<NoopInput | QuirkyOutput>[] => [],
        },
        output: ({ event, ignore }) => [event('kept'), ignore('kept')],
        input: ({ event }) => [event('noop')],
      }),
    ).toThrow(/dispatch literal 'kept'/);
  });
});

// ---------------------------------------------------------------------------
// Wire-controlled kind robustness
//
// The decode lifecycle policy's onDiscrete is a plain-object Record indexed by
// the wire-controlled `kind` header. A crafted kind naming an Object.prototype
// member ('valueOf', 'toString', …) must not resolve through the prototype
// chain — it has to be treated as an unknown kind and dropped.
// ---------------------------------------------------------------------------

describe('defineCodec — wire-controlled kind robustness', () => {
  const lifecycleCodec = defineCodec<NoopInput, QuirkyOutput>()({
    reducer: {
      init: (): FixtureProjection => ({ folded: [] }),
      fold: (state: FixtureProjection): FixtureProjection => state,
      getMessages: (): CodecMessage<NoopInput | QuirkyOutput>[] => [],
    },
    output: ({ event }) => [event('quirky', { data: { encode: () => '', decode: () => ({ kind: 'decoded' }) } })],
    input: ({ event }) => [event('noop')],
    decodeLifecycle: () => ({
      onDiscrete: { quirky: () => [{ type: 'quirky', kind: 'lead-in' }] },
    }),
  });

  it.each(['valueOf', 'toString', 'constructor', 'hasOwnProperty'])(
    'drops a discrete ai-output with crafted kind %j',
    (kind) => {
      const decoder = lifecycleCodec.createDecoder();
      const { inputs, outputs } = decoder.decode(aiMessage(EVENT_AI_OUTPUT, { kind }));
      expect(inputs).toEqual([]);
      expect(outputs).toEqual([]);
    },
  );

  it('drops a streamed ai-input instead of rebuilding it through the output stream path', () => {
    const decoder = lifecycleCodec.createDecoder();
    // A streamed message under the ai-input wire name (foreign or crafted —
    // the SDK never publishes one) must not rebuild via the output stream
    // hooks, where its events would be mislabelled as inputs.
    const streamed = {
      serial: 's-in',
      action: 'message.create',
      name: EVENT_AI_INPUT,
      data: 'partial',
      version: {},
      extras: { ai: { codec: { kind: 'quirky' }, transport: { stream: 'true', 'stream-id': 'st-1' } } },
      // CAST: minimal InboundMessage stub — only the fields the decoder reads.
    } as Ably.InboundMessage;

    const { inputs, outputs } = decoder.decode(streamed);

    expect(inputs).toEqual([]);
    expect(outputs).toEqual([]);
  });

  it('still runs the lifecycle policy for a declared kind, prepending its lead-in', () => {
    const decoder = lifecycleCodec.createDecoder();
    const { outputs } = decoder.decode(aiMessage(EVENT_AI_OUTPUT, { kind: 'quirky' }));
    expect(outputs).toEqual([
      { type: 'quirky', kind: 'lead-in' },
      { type: 'quirky', kind: 'decoded' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Table validation
//
// defineCodec is the public authoring boundary: a mistake in a descriptor
// table must throw at module init, not silently last-win at dispatch time.
// ---------------------------------------------------------------------------

type NoteOutput =
  | { type: 'note'; text: string; kind?: string }
  | { type: 'note-start'; id: string; variant?: 'a' | 'b' }
  | { type: 'note-delta'; id: string; delta: string }
  | { type: 'note-end'; id: string }
  | { type: 'note-delta-b'; id: string; delta: string }
  | { type: 'note-end-b'; id: string };

interface PingInput {
  kind: 'ping';
  codecMessageId: string;
  payload: Record<string, never>;
}

interface PostInput {
  kind: 'post';
  message: { parts: { type: 'text'; text: string; partType?: string }[] };
}

type ValidationInput = PingInput | PostInput;

interface ValidationProjection {
  folded: (ValidationInput | NoteOutput)[];
}

// A defineCodec call with a noop reducer — validation runs before any
// encode/decode, so only the descriptor tables matter.
const defineWith = (
  output: Parameters<ReturnType<typeof defineCodec<ValidationInput, NoteOutput>>>[0]['output'],
  input: Parameters<ReturnType<typeof defineCodec<ValidationInput, NoteOutput>>>[0]['input'],
): unknown =>
  defineCodec<ValidationInput, NoteOutput>()({
    reducer: {
      init: (): ValidationProjection => ({ folded: [] }),
      fold: (state: ValidationProjection): ValidationProjection => state,
      getMessages: (): CodecMessage<ValidationInput | NoteOutput>[] => [],
    },
    output,
    input,
  });

const noteStream = {
  start: 'note-start',
  delta: 'note-delta',
  end: 'note-end',
  streamId: { field: 'id' },
  deltaField: 'delta',
  fields: [],
} as const;

describe('defineCodec — table validation', () => {
  it('accepts a table with unique dispatch literals', () => {
    expect(() =>
      defineWith(
        ({ event, stream }) => [event('note'), stream('notes', noteStream)],
        ({ event }) => [event('ping')],
      ),
    ).not.toThrow();
  });

  it('throws on duplicate output event types', () => {
    expect(() =>
      defineWith(
        ({ event }) => [event('note'), event('note')],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfo({ code: ErrorCode.InvalidArgument, statusCode: 400 });
  });

  it('throws when an output event type collides with a stream phase', () => {
    expect(() =>
      defineWith(
        ({ event, stream }) => [event('note-delta'), stream('notes', noteStream)],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws when an output event type collides with a stream family kind', () => {
    expect(() =>
      defineWith(
        ({ event, stream }) => [event('note'), stream('note', noteStream)],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws when two streams share a delta/end phase literal', () => {
    // Two identical streams share their delta/end phases (a delta/end must be
    // uniquely owned); the shared start is allowed, but the delta collision is not.
    expect(() =>
      defineWith(
        ({ stream }) => [stream('notes-a', noteStream), stream('notes-b', noteStream)],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('accepts two streams sharing a start type discriminated by startWhen', () => {
    const streamA = {
      start: 'note-start',
      delta: 'note-delta',
      end: 'note-end',
      streamId: { field: 'id' },
      deltaField: 'delta',
      fields: [],
      startWhen: (c: Extract<NoteOutput, { type: 'note-start' }>) => c.variant === 'a',
    } as const;
    const streamB = {
      start: 'note-start',
      delta: 'note-delta-b',
      end: 'note-end-b',
      streamId: { field: 'id' },
      deltaField: 'delta',
      fields: [],
      startWhen: (c: Extract<NoteOutput, { type: 'note-start' }>) => c.variant === 'b',
    } as const;
    expect(() =>
      defineWith(
        ({ stream }) => [stream('notes-a', streamA), stream('notes-b', streamB)],
        ({ event }) => [event('ping')],
      ),
    ).not.toThrow();
  });

  it('accepts a stream start type that also backs a discrete event (its decline target)', () => {
    expect(() =>
      defineWith(
        ({ event, stream }) => [event('note-start'), stream('notes', noteStream)],
        ({ event }) => [event('ping')],
      ),
    ).not.toThrow();
  });

  it("throws when a stream start collides with another stream's delta/end phase", () => {
    // `note-delta` is streamC's start but noteStream's delta — the start-first
    // dispatch would shadow the continuation, so this must be rejected.
    const streamC = {
      start: 'note-delta',
      delta: 'note-delta-b',
      end: 'note-end-b',
      streamId: { field: 'id' },
      deltaField: 'delta',
      fields: [],
    } as const;
    expect(() =>
      defineWith(
        ({ stream }) => [stream('notes', noteStream), stream('notes-c', streamC)],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws on duplicate input kinds', () => {
    expect(() =>
      defineWith(
        ({ event }) => [event('note')],
        ({ event }) => [event('ping'), event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws on duplicate partTypes within a batch', () => {
    expect(() =>
      defineWith(
        ({ event }) => [event('note')],
        ({ batch }) => [
          batch('post', {
            explode: (input) => input.message.parts,
            partTypeOf: (part) => part.type,
            parts: (p) => [p('text', {}), p('text', {})],
            assemble: () => ({ message: { parts: [] } }),
          }),
        ],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws when an output field binds the reserved kind header key', () => {
    expect(() =>
      defineWith(
        ({ event }) => [event('note', { fields: [strField('kind')] })],
        ({ event }) => [event('ping')],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('throws when a batch part field binds the reserved partType header key', () => {
    expect(() =>
      defineWith(
        ({ event }) => [event('note')],
        ({ batch }) => [
          batch('post', {
            explode: (input) => input.message.parts,
            partTypeOf: (part) => part.type,
            parts: (p) => [p('text', { fields: [strField('partType')] })],
            assemble: () => ({ message: { parts: [] } }),
          }),
        ],
      ),
    ).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});

const reducerMeta = (serial: string, messageId: string): ReducerMeta => ({ serial, messageId });

describe('defineCodec — reducer wiring', () => {
  it('threads init / fold / getMessages from the supplied reducer parts', () => {
    let state = codec.init();
    // init produces the fixture's empty projection; getMessages reads it back.
    expect(codec.getMessages(state)).toEqual([]);

    const output: QuirkyOutput = { type: 'quirky', kind: 'k' };
    const input: NoopInput = { kind: 'noop', codecMessageId: 'cm-x', payload: {} };
    state = codec.fold(state, { direction: 'output', event: output }, reducerMeta('s1', 'm1'));
    state = codec.fold(state, { direction: 'input', event: input }, reducerMeta('s2', 'm2'));

    // The fixture reducer records each folded event and getMessages surfaces them,
    // proving all three reducer methods are wired through the factory.
    expect(codec.getMessages(state)).toEqual([
      { codecMessageId: 'cm-0', message: output },
      { codecMessageId: 'cm-1', message: input },
    ]);
  });
});
