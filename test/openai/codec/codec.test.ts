import type { Responses } from 'openai/resources/responses/responses';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { createOpenAICodec, openai, type OpenAIEvent } from '../../../src/openai/index.js';
import { deliveriesOf, encodeAll, historyOf, roundTrip } from '../../helper/wire.js';
import { at, decodedOf, functionCall, message, textResponse, toolCallResponse } from './fixtures.js';

describe('the OpenAI codec', () => {
  let codec: Codec<OpenAIEvent>;

  beforeEach(() => {
    codec = createOpenAICodec();
  });

  describe('encode', () => {
    it('streams a function call’s arguments under the item id and publishes the rest', () => {
      const encoded = encodeAll(codec, toolCallResponse);
      expect(encoded.map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }))).toEqual([
        { data: '' },
        { data: '{"city":', append: 'fc_1' },
        { data: '"London"}', append: 'fc_1' },
        { data: '', ends: 'fc_1' },
        { data: { ...functionCall, arguments: '', status: 'completed' } },
        { data: { id: 'resp_1', status: 'completed', output: [] } },
      ]);
    });

    it('empties the text a closer repeats and keeps the rest of the event', () => {
      const [done] = codec.encode(at(textResponse, 5));
      expect(done?.ends).toBe('msg_1:0');
      expect(done?.message.extras).toEqual({
        ai: { type: 'response.output_text.done', json: ['logprobs'] },
        headers: {
          type: 'response.output_text.done',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          text: '',
          logprobs: '[]',
        },
      });
      const [args] = codec.encode(at(toolCallResponse, 4));
      expect(args?.message.extras).toMatchObject({ headers: { arguments: '', name: 'weather' } });
    });

    it('empties a finished item’s streamed text and keeps what the deltas could not carry', () => {
      const annotations: Responses.ResponseOutputText['annotations'] = [
        { type: 'url_citation', url: 'https://example.com', title: 'Example', start_index: 0, end_index: 5 },
      ];
      const logprobs: Responses.ResponseOutputText['logprobs'] = [
        { token: 'It', logprob: -0.1, bytes: [], top_logprobs: [] },
      ];
      const [encoded] = codec.encode({
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 9,
        item: {
          ...message,
          status: 'completed',
          content: [
            { type: 'output_text', text: 'It is 21°C', annotations, logprobs },
            { type: 'refusal', refusal: 'I cannot help with that' },
          ],
        },
      });
      expect(encoded?.message.data).toEqual({
        ...message,
        status: 'completed',
        content: [
          { type: 'output_text', text: '', annotations, logprobs },
          { type: 'refusal', refusal: '' },
        ],
      });
    });

    it('empties a reasoning item’s summary and content text and keeps its encrypted content', () => {
      const [encoded] = codec.encode({
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 9,
        item: {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'thinking' }],
          content: [{ type: 'reasoning_text', text: 'step by step' }],
          encrypted_content: 'opaque',
        },
      });
      expect(encoded?.message.data).toEqual({
        id: 'rs_1',
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: '' }],
        content: [{ type: 'reasoning_text', text: '' }],
        encrypted_content: 'opaque',
      });
    });

    it('carries a finished item of another type whole, since nothing of it streamed', () => {
      const item: Responses.ResponseOutputItem = {
        id: 'fs_1',
        type: 'file_search_call',
        status: 'completed',
        queries: ['weather in London'],
      };
      const [encoded] = codec.encode({ type: 'response.output_item.done', output_index: 0, item, sequence_number: 9 });
      expect(encoded?.message.data).toEqual(item);
    });

    it('empties the terminal response’s output and keeps its status and usage', () => {
      // CAST: the suites read only the fields asserted below; a minimal stub stands in for the full shape.
      const response = {
        id: 'resp_9',
        status: 'completed',
        output: [{ ...functionCall, arguments: '{"city":"London"}', status: 'completed' }],
        usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
      } as unknown as Responses.Response;
      const [encoded] = codec.encode({ type: 'response.completed', response, sequence_number: 9 });
      expect(encoded?.message.data).toEqual({
        id: 'resp_9',
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
      });
    });

    it('streams a content part’s deltas under its item and slot, with the opener and closer as plain publishes', () => {
      const encoded = encodeAll(codec, textResponse);
      expect(encoded.map(({ publish, append, ends }) => ({ publish, append, ends }))).toEqual([
        { publish: undefined, append: undefined, ends: undefined },
        { publish: undefined, append: undefined, ends: undefined },
        { publish: undefined, append: 'msg_1:0', ends: undefined },
        { publish: undefined, append: 'msg_1:0', ends: undefined },
        { publish: undefined, append: undefined, ends: 'msg_1:0' },
        { publish: undefined, append: undefined, ends: undefined },
        { publish: undefined, append: undefined, ends: undefined },
        { publish: undefined, append: undefined, ends: undefined },
      ]);
    });

    it('streams a reasoning summary’s deltas under its item and slot, ended by its done event', () => {
      const encoded = encodeAll(codec, [
        {
          type: 'response.reasoning_summary_part.added',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
          sequence_number: 1,
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          delta: 'thinking',
          sequence_number: 2,
        },
        {
          type: 'response.reasoning_summary_text.done',
          item_id: 'rs_1',
          output_index: 0,
          summary_index: 0,
          text: 'thinking',
          sequence_number: 3,
        },
      ]);
      expect(encoded.map(({ publish, append, ends }) => ({ publish, append, ends }))).toEqual([
        { publish: undefined, append: undefined, ends: undefined },
        { publish: undefined, append: 'rs_1:summary:0', ends: undefined },
        { publish: undefined, append: undefined, ends: 'rs_1:summary:0' },
      ]);
    });

    it('carries an event’s fields under extras.headers without its sequence number, arrays as JSON text', () => {
      expect(codec.encode(at(textResponse, 3))[0]?.message).toEqual({
        name: 'ai',
        data: 'It is 21°C',
        extras: {
          ai: { type: 'response.output_text.delta', json: ['logprobs'] },
          headers: {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            logprobs: '[]',
          },
        },
      });
    });

    it('publishes nothing for the response openers', () => {
      for (const type of ['response.created', 'response.in_progress', 'response.queued'] as const) {
        // CAST: a minimal opener; the row reads nothing off the response.
        const event = { type, response: {} as Responses.Response, sequence_number: 0 } as OpenAIEvent;
        expect(codec.encode(event)).toEqual([]);
      }
    });

    it('publishes an output item that is not a function call as a plain event', () => {
      const [encoded] = codec.encode(at(textResponse, 1));
      expect(encoded?.publish).toBeUndefined();
      expect(encoded?.message.data).toBe('');
    });

    it('publishes input items as the message data', () => {
      const items: Responses.ResponseInputItem[] = [{ role: 'user', content: 'What is the weather?' }];
      expect(codec.encode({ type: 'input', items })).toEqual([
        { message: { name: 'ai', data: items, extras: { ai: { type: 'input' } } } },
      ]);
    });

    it('throws for an event type outside the union', () => {
      // CAST: an event outside the union, to exercise the unlisted-type path.
      const rogue = { type: 'response.not_a_thing' } as unknown as OpenAIEvent;
      expect(() => codec.encode(rogue)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('decode', () => {
    it('round-trips both responses event for event, without sequence numbers', () => {
      expect(roundTrip(codec, toolCallResponse)).toStrictEqual(decodedOf(toolCallResponse));
      // A fresh codec: the simulated wire reuses its serials, which a decoder
      // table that has seen them would drop as replays.
      expect(roundTrip(createOpenAICodec(), textResponse)).toStrictEqual(decodedOf(textResponse));
    });

    it('decodes history as the sequence the agent produced, with the text deltas joined', () => {
      const decoded = historyOf(encodeAll(codec, textResponse)).flatMap((m) => codec.decode(m));
      const expected = decodedOf(textResponse);
      expect(decoded).toStrictEqual([
        at(expected, 0),
        at(expected, 1),
        { ...at(expected, 2), delta: 'It is 21°C in London.' },
        ...expected.slice(4),
      ]);
    });

    it('decodes an event from the builder’s type when the spread type header is missing', () => {
      const [delivery] = deliveriesOf(encodeAll(codec, [at(textResponse, 5)]));
      if (delivery === undefined) throw new Error('fixture');
      // CAST: `extras` is typed `any`; the fixture reads the two keys the builder wrote.
      const extras = delivery.extras as { ai: unknown; headers: Record<string, unknown> };
      const headers = Object.fromEntries(Object.entries(extras.headers).filter(([key]) => key !== 'type'));
      // CAST: a fixture inbound message whose headers lost their type copy.
      const stripped = { ...delivery, extras: { ai: extras.ai, headers } } as typeof delivery;
      expect(codec.decode(stripped)).toEqual(decodedOf([at(textResponse, 5)]));
    });

    it('round-trips the input items', () => {
      const items: Responses.ResponseInputItem[] = [
        { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
      ];
      expect(roundTrip(codec, [{ type: 'input', items }])).toStrictEqual([{ type: 'input', items }]);
    });

    it('decodes a late joiner’s full-content update to one delta carrying the text so far', () => {
      const [, opener, first, second] = deliveriesOf(encodeAll(codec, textResponse.slice(0, 5)));
      if (opener === undefined || first === undefined || second === undefined) throw new Error('fixture');
      // The first delta opened the message the second appends to; the update
      // the joiner receives is on that message.
      expect(second.serial).toBe(first.serial);
      const update = { ...second, action: 'message.update', data: 'It is 21°C in London.' };
      // CAST: a fixture inbound message.
      expect(codec.decode(update as typeof second)).toEqual([
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          logprobs: [],
          delta: 'It is 21°C in London.',
        },
      ]);
    });

    it('throws for input whose data is not a list of items', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'ai', data: 'nope', extras: { ai: { type: 'input' } } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('decodes nothing for a message that is not the codec’s', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'chat', data: 'hello', extras: { headers: {} } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });
  });

  it('exports a prebuilt codec carrying the adapter tag', () => {
    expect(openai.adapterTag).toBe('openai-responses');
    expect(Object.keys(openai).toSorted()).toEqual(['adapterTag', 'decode', 'encode']);
  });
});
