import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT } from '../../../src/constants.js';
import { defineCodec } from '../../../src/core/codec/define-codec.js';
import type { ChannelWriter, CodecEvent, CodecMessage, ReducerMeta } from '../../../src/core/codec/types.js';

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
