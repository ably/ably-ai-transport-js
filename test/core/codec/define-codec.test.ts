import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT, EVENT_AI_OUTPUT } from '../../../src/constants.js';
import { defineCodec } from '../../../src/core/codec/define-codec.js';
import type { CodecMessage } from '../../../src/core/codec/types.js';

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

const codec = defineCodec<NoopInput, QuirkyOutput>()({
  reducer: {
    init: () => ({}),
    fold: (state) => state,
    getMessages: (): CodecMessage<unknown>[] => [],
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
