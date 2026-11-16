import { beforeEach, describe, expect, it } from 'vitest';

import { anthropic, createAnthropicCodec } from '../../../src/anthropic/codec/index.js';
import type { AnthropicEvent } from '../../../src/anthropic/index.js';
import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { foldWithMessageStream } from '../../helper/anthropic-fold.js';
import { deliveriesOf, encodeAll, historyOf, roundTrip } from '../../helper/wire.js';
import { at, citation, emptyText, openedMessage, searchTurn, toolResult, toolTurn } from './fixtures.js';

/**
 * The body and routing of each encoded message, without the rest of the message.
 * @param codec - The codec.
 * @param events - The events.
 * @returns One entry per encoded message.
 */
const wireOf = (codec: Codec<AnthropicEvent>, events: AnthropicEvent[]): Record<string, unknown>[] =>
  encodeAll(codec, events).map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }));

/**
 * What a subscriber that reads history decodes for `events`.
 * @param events - The events the agent piped.
 * @returns The decoded events, oldest first.
 */
const fromHistory = (events: AnthropicEvent[]): AnthropicEvent[] => {
  const codec = createAnthropicCodec();

  return historyOf(encodeAll(codec, events)).flatMap((m) => codec.decode(m));
};

describe('the Anthropic codec', () => {
  let codec: Codec<AnthropicEvent>;

  beforeEach(() => {
    codec = createAnthropicCodec();
  });

  describe('encode', () => {
    it('appends a block’s deltas under its index and publishes the rest whole', () => {
      expect(wireOf(codec, toolTurn)).toEqual([
        { data: at(toolTurn, 0) },
        { data: at(toolTurn, 1) },
        { data: 'The user wants ', append: '0' },
        { data: 'the weather.', append: '0' },
        { data: at(toolTurn, 4) },
        { data: at(toolTurn, 5), ends: '0' },
        { data: at(toolTurn, 6) },
        { data: 'Let me check ', append: '1' },
        { data: 'London.', append: '1' },
        { data: at(toolTurn, 9), ends: '1' },
        { data: at(toolTurn, 10) },
        { data: '', append: '2' },
        { data: '{"city":', append: '2' },
        { data: ' "London"}', append: '2' },
        { data: at(toolTurn, 14), ends: '2' },
        { data: at(toolTurn, 15) },
        { data: at(toolTurn, 16) },
      ]);
    });

    it('carries a delta’s text as the body and the rest of the event under extras.ai.fields', () => {
      const [delta] = codec.encode(at(toolTurn, 2));

      expect(delta?.message).toEqual({
        name: 'ai',
        data: 'The user wants ',
        extras: {
          ai: {
            codec: 'anthropic-messages',
            type: 'content_block_delta',
            fields: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } },
          },
        },
      });
    });

    it('publishes a signature and a citation whole, off the block’s key', () => {
      const [signature] = codec.encode(at(toolTurn, 4));
      const [cited] = codec.encode(at(searchTurn, 10));

      expect(signature).toEqual({
        message: {
          name: 'ai',
          data: at(toolTurn, 4),
          extras: { ai: { codec: 'anthropic-messages', type: 'content_block_delta' } },
        },
      });
      expect(cited).toEqual({
        message: {
          name: 'ai',
          data: at(searchTurn, 10),
          extras: { ai: { codec: 'anthropic-messages', type: 'content_block_delta' } },
        },
      });
    });

    it('publishes a block that does not stream whole in its start, and its stop ends no live key', () => {
      expect(wireOf(codec, searchTurn.slice(0, 8))).toEqual([
        { data: at(searchTurn, 0) },
        { data: at(searchTurn, 1) },
        { data: at(searchTurn, 2), ends: '0' },
        { data: at(searchTurn, 3) },
        { data: '{"query": "London weather"}', append: '1' },
        { data: at(searchTurn, 5), ends: '1' },
        { data: at(searchTurn, 6) },
        { data: at(searchTurn, 7), ends: '2' },
      ]);
    });

    it('sends message_start with the content the API sent, and leaves the agent’s event as it was', () => {
      // The SDK yields message_start with the Message it keeps adding blocks
      // to, so by encode time it can hold blocks that stream on their own.
      const grown: AnthropicEvent = {
        type: 'message_start',
        message: { ...openedMessage('msg_1'), content: [{ ...emptyText, text: 'Let me check' }] },
      };

      const [encoded] = codec.encode(grown);

      expect(encoded?.message.data).toEqual({ type: 'message_start', message: openedMessage('msg_1') });
      expect(grown.message.content).toHaveLength(1);
    });

    it('publishes input messages as the message data', () => {
      expect(codec.encode({ type: 'input', messages: toolResult })).toEqual([
        { message: { name: 'ai', data: toolResult, extras: { ai: { codec: 'anthropic-messages', type: 'input' } } } },
      ]);
    });

    it('throws for a delta type the codec does not know', () => {
      // CAST: a delta outside the SDK's union, as a newer API version may send.
      const rogue = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'compaction_delta' },
      } as unknown as AnthropicEvent;

      expect(() => codec.encode(rogue)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to encode content_block_delta; no row for delta type 'compaction_delta'",
      });
    });

    it('throws for an event type outside the union', () => {
      // CAST: an event outside the union, to exercise the unlisted-type path.
      const rogue = { type: 'message_restart' } as unknown as AnthropicEvent;

      expect(() => codec.encode(rogue)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('decode', () => {
    it('round-trips both turns event for event', () => {
      expect(roundTrip(codec, toolTurn)).toStrictEqual(toolTurn);
      // A fresh codec: the simulated wire reuses its serials, which a decoder
      // table that has seen them would drop as replays.
      expect(roundTrip(createAnthropicCodec(), searchTurn)).toStrictEqual(searchTurn);
    });

    it('decodes history as the turn the agent produced, with each block’s deltas joined', () => {
      // A block's deltas share one message, which keeps the fields of the
      // last append, so each block reads back as one delta with all its text.
      expect(fromHistory(toolTurn)).toStrictEqual([
        at(toolTurn, 0),
        at(toolTurn, 1),
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'The user wants the weather.' },
        },
        at(toolTurn, 4),
        at(toolTurn, 5),
        at(toolTurn, 6),
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check London.' } },
        at(toolTurn, 9),
        at(toolTurn, 10),
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"city": "London"}' },
        },
        ...toolTurn.slice(14),
      ]);
    });

    it('decodes a late joiner’s full-content update to one delta carrying the text so far', () => {
      const deliveries = deliveriesOf(encodeAll(codec, toolTurn));
      const first = deliveries[7];
      const second = deliveries[8];
      if (first === undefined || second === undefined) throw new Error('fixture');

      // The first text delta opened the message the second appends to; the
      // update the joiner receives is on that message.
      expect(second.serial).toBe(first.serial);

      // CAST: a fixture inbound message.
      const update = { ...second, action: 'message.update', data: 'Let me check London.' } as typeof second;

      expect(codec.decode(update)).toEqual([
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check London.' } },
      ]);
    });

    it('round-trips the input messages', () => {
      expect(roundTrip(codec, [{ type: 'input', messages: toolResult }])).toStrictEqual([
        { type: 'input', messages: toolResult },
      ]);
    });

    it('throws for a plain publish whose body is not an object', () => {
      const [delivery] = deliveriesOf([
        {
          message: { name: 'ai', data: 'nope', extras: { ai: { codec: 'anthropic-messages', type: 'message_delta' } } },
        },
      ]);
      if (delivery === undefined) throw new Error('fixture');

      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode message_delta; data is not an object',
      });
    });

    it('throws for a streamed delta whose type carries no text', () => {
      const [delivery] = deliveriesOf([
        {
          message: {
            name: 'ai',
            data: 'EqQB',
            extras: {
              ai: {
                codec: 'anthropic-messages',
                type: 'content_block_delta',
                fields: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } },
              },
            },
          },
          append: '0',
        },
      ]);
      if (delivery === undefined) throw new Error('fixture');

      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode content_block_delta; delta type signature_delta does not stream text',
      });
    });

    it('throws for input whose data is not a list of messages', () => {
      const [delivery] = deliveriesOf([
        { message: { name: 'ai', data: 'nope', extras: { ai: { codec: 'anthropic-messages', type: 'input' } } } },
      ]);
      if (delivery === undefined) throw new Error('fixture');

      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode input; data is not a list of messages',
      });
    });

    it('decodes nothing for a message that is not the codec’s', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'chat', data: 'hello', extras: { headers: {} } } }]);
      if (delivery === undefined) throw new Error('fixture');

      expect(codec.decode(delivery)).toEqual([]);
    });
  });

  describe('folded with the SDK’s MessageStream', () => {
    it('builds the Messages the agent’s stream built, live and from history', async () => {
      const turns = [...toolTurn, ...searchTurn];
      const expected = await foldWithMessageStream(turns);

      expect(await foldWithMessageStream(roundTrip(codec, turns))).toStrictEqual(expected);
      expect(await foldWithMessageStream(fromHistory(turns))).toStrictEqual(expected);

      // The fold is worth comparing: it holds the signature, the parsed tool
      // input and the citation.
      expect(expected).toMatchObject([
        {
          content: [
            { type: 'thinking', thinking: 'The user wants the weather.', signature: 'EqQBCkYIBxgCKkA=' },
            { type: 'text', text: 'Let me check London.' },
            { type: 'tool_use', id: 'toolu_1', input: { city: 'London' } },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [
            { type: 'redacted_thinking' },
            { type: 'server_tool_use', input: { query: 'London weather' } },
            { type: 'web_search_tool_result' },
            { type: 'text', text: 'It is 12°C and cloudy.', citations: [citation] },
          ],
          stop_reason: 'end_turn',
        },
      ]);
    });

    it('builds the same Message when a citation or signature arrives ahead of the text before it', async () => {
      // A plain publish can reach a subscriber ahead of an append Ably still
      // holds, so the signature and the citation can overtake their block's text.
      const turns = [...toolTurn, ...searchTurn];
      const wire = deliveriesOf(encodeAll(codec, turns));

      // The signature (4) moves ahead of the thinking deltas (2, 3), and the
      // citation ahead of the text delta before it.
      const citationAt = toolTurn.length + 10;
      wire.splice(2, 0, ...wire.splice(4, 1));
      wire.splice(citationAt - 1, 0, ...wire.splice(citationAt, 1));

      const decoded = wire.flatMap((m) => codec.decode(m));

      expect(await foldWithMessageStream(decoded)).toStrictEqual(await foldWithMessageStream(turns));
    });
  });

  it('builds a codec carrying its id and name and nothing else beside encode and decode', () => {
    expect(anthropic.id).toBe('anthropic-messages');
    expect(Object.keys(anthropic).toSorted()).toEqual(['decode', 'encode', 'id', 'name']);
  });
});
