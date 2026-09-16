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
    it('streams a function call’s arguments under the item id and publishes the rest whole', () => {
      const encoded = encodeAll(codec, toolCallResponse);
      // A plain publish carries the whole event as the body, with the text
      // the deltas streamed sent empty; a delta carries its text, appended.
      const expected = decodedOf(toolCallResponse);
      expect(encoded.map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }))).toEqual([
        { data: expected[0] },
        { data: '{"city":', append: 'fc_1' },
        { data: '"London"}', append: 'fc_1' },
        { data: expected[3], ends: 'fc_1' },
        { data: expected[4] },
        { data: expected[5] },
      ]);
    });

    it('empties the text a closer repeats and keeps the rest of the event, in the body', () => {
      const [done] = codec.encode(at(textResponse, 5));
      expect(done?.ends).toBe('msg_1:0');
      expect(done?.message).toEqual({
        name: 'ai',
        data: { ...at(textResponse, 5), text: '' },
        extras: { ai: { type: 'response.output_text.done' } },
      });
      const [args] = codec.encode(at(toolCallResponse, 4));
      expect(args?.message.data).toMatchObject({ arguments: '', name: 'weather' });
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
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 9,
        item: {
          ...message,
          status: 'completed',
          content: [
            { type: 'output_text', text: '', annotations, logprobs },
            { type: 'refusal', refusal: '' },
          ],
        },
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
      expect(encoded?.message.data).toMatchObject({
        item: {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: '' }],
          content: [{ type: 'reasoning_text', text: '' }],
          encrypted_content: 'opaque',
        },
      });
    });

    it('carries a finished item of another type whole, since nothing of it streamed', () => {
      const item: Responses.ResponseOutputItem = {
        id: 'fs_1',
        type: 'file_search_call',
        status: 'completed',
        queries: ['weather in London'],
      };
      const event: OpenAIEvent = { type: 'response.output_item.done', output_index: 0, item, sequence_number: 9 };
      const [encoded] = codec.encode(event);
      expect(encoded?.message.data).toEqual(event);
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
        type: 'response.completed',
        sequence_number: 9,
        response: {
          id: 'resp_9',
          status: 'completed',
          output: [],
          usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
        },
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

    it('carries an event’s fields under extras.headers, arrays as JSON text', () => {
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
            sequence_number: 3,
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

    it('publishes an output item that is not a function call as a plain event, whole in the body', () => {
      const [encoded] = codec.encode(at(textResponse, 1));
      expect(encoded?.publish).toBeUndefined();
      expect(encoded?.message.data).toEqual(at(textResponse, 1));
      expect(encoded?.message.extras).toEqual({ ai: { type: 'response.output_item.added' } });
    });

    it('publishes input items as the message data', () => {
      const items: Responses.ResponseInputItem[] = [{ role: 'user', content: 'What is the weather?' }];
      expect(codec.encode({ type: 'input', items })).toEqual([
        { message: { name: 'ai', data: items, extras: { ai: { type: 'input' } } } },
      ]);
    });

    it('streams a hosted tool’s code, input or arguments under its item id and empties the repeat in its closer', () => {
      const streams: { delta: OpenAIEvent; done: OpenAIEvent; field: string }[] = [
        {
          delta: {
            type: 'response.code_interpreter_call_code.delta',
            item_id: 'ci_1',
            output_index: 0,
            delta: 'print(',
            sequence_number: 1,
          },
          done: {
            type: 'response.code_interpreter_call_code.done',
            item_id: 'ci_1',
            output_index: 0,
            code: 'print(1)',
            sequence_number: 2,
          },
          field: 'code',
        },
        {
          delta: {
            type: 'response.custom_tool_call_input.delta',
            item_id: 'ct_1',
            output_index: 0,
            delta: '{"q":',
            sequence_number: 1,
          },
          done: {
            type: 'response.custom_tool_call_input.done',
            item_id: 'ct_1',
            output_index: 0,
            input: '{"q":1}',
            sequence_number: 2,
          },
          field: 'input',
        },
        {
          delta: {
            type: 'response.mcp_call_arguments.delta',
            item_id: 'mcp_1',
            output_index: 0,
            delta: '{"a":',
            sequence_number: 1,
          },
          done: {
            type: 'response.mcp_call_arguments.done',
            item_id: 'mcp_1',
            output_index: 0,
            arguments: '{"a":1}',
            sequence_number: 2,
          },
          field: 'arguments',
        },
      ];
      for (const { delta, done, field } of streams) {
        const itemId = 'item_id' in delta ? delta.item_id : '';
        const [first, last] = encodeAll(codec, [delta, done]);
        expect(first?.append).toBe(itemId);
        expect(first?.message.data).toBe('delta' in delta ? delta.delta : undefined);
        expect(last?.ends).toBe(itemId);
        expect(last?.message.data).toMatchObject({ [field]: '' });
        // The decoded sequence is the agent's, with the closer's repeat emptied.
        const [expectedDelta, expectedDone] = decodedOf([delta, done]);
        expect(roundTrip(createOpenAICodec(), [delta, done])).toStrictEqual([
          expectedDelta,
          { ...expectedDone, [field]: '' },
        ]);
      }
    });

    it('publishes an audio delta, a transcript delta and a partial image whole, one message each', () => {
      const events: OpenAIEvent[] = [
        { type: 'response.audio.delta', delta: 'AAAA', sequence_number: 1 },
        { type: 'response.audio.transcript.delta', delta: 'Hello', sequence_number: 2 },
        {
          type: 'response.image_generation_call.partial_image',
          item_id: 'ig_1',
          output_index: 0,
          partial_image_index: 0,
          partial_image_b64: 'iVBOR',
          sequence_number: 3,
        },
      ];
      const encoded = encodeAll(codec, events);
      // No stream key exists for these, so each is a plain publish carrying
      // the whole event as the body.
      expect(encoded.map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }))).toEqual([
        { data: events[0] },
        { data: events[1] },
        { data: events[2] },
      ]);
      expect(encoded[2]?.message.extras).toEqual({ ai: { type: 'response.image_generation_call.partial_image' } });
      expect(roundTrip(createOpenAICodec(), events)).toStrictEqual(decodedOf(events));
    });

    it('empties the streamed field of a finished hosted-tool item', () => {
      // CAST: minimal items carrying the fields the row empties; the row reads `type` and one field.
      const items = [
        { id: 'ci_1', type: 'code_interpreter_call', code: 'print(1)', status: 'completed' },
        { id: 'ct_1', type: 'custom_tool_call', call_id: 'c', name: 't', input: '{"q":1}' },
        { id: 'mcp_1', type: 'mcp_call', name: 't', server_label: 's', arguments: '{"a":1}' },
      ] as unknown as Responses.ResponseOutputItem[];
      const emptied = items.map((item) => {
        const [encoded] = codec.encode({
          type: 'response.output_item.done',
          output_index: 0,
          item,
          sequence_number: 9,
        });
        // CAST: the body is the event; the test reads its item.
        return (encoded?.message.data as { item?: unknown } | undefined)?.item;
      });
      expect(emptied).toEqual([
        { id: 'ci_1', type: 'code_interpreter_call', code: '', status: 'completed' },
        { id: 'ct_1', type: 'custom_tool_call', call_id: 'c', name: 't', input: '' },
        { id: 'mcp_1', type: 'mcp_call', name: 't', server_label: 's', arguments: '' },
      ]);
    });

    it('empties the text a finished part repeats and keeps its annotations, in the body', () => {
      const [done] = codec.encode(at(textResponse, 6));
      expect(done?.ends).toBeUndefined();
      expect(done?.message).toEqual({
        name: 'ai',
        data: { ...at(textResponse, 6), part: { type: 'output_text', text: '', annotations: [] } },
        extras: { ai: { type: 'response.content_part.done' } },
      });
    });

    it('throws for an event type outside the union', () => {
      // CAST: an event outside the union, to exercise the unlisted-type path.
      const rogue = { type: 'response.not_a_thing' } as unknown as OpenAIEvent;
      expect(() => codec.encode(rogue)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('decode', () => {
    it('round-trips both responses event for event', () => {
      expect(roundTrip(codec, toolCallResponse)).toStrictEqual(decodedOf(toolCallResponse));
      // A fresh codec: the simulated wire reuses its serials, which a decoder
      // table that has seen them would drop as replays.
      expect(roundTrip(createOpenAICodec(), textResponse)).toStrictEqual(decodedOf(textResponse));
    });

    it('decodes history as the sequence the agent produced, with the text deltas joined', () => {
      const decoded = historyOf(encodeAll(codec, textResponse)).flatMap((m) => codec.decode(m));
      const expected = decodedOf(textResponse);
      // The message the deltas share keeps the last append's headers, so the
      // joined delta reads back with the last delta's sequence number.
      expect(decoded).toStrictEqual([
        at(expected, 0),
        at(expected, 1),
        { ...at(expected, 3), delta: 'It is 21°C in London.' },
        ...expected.slice(4),
      ]);
    });

    it('throws for a plain publish whose body is not an object', () => {
      const [delivery] = deliveriesOf([
        { message: { name: 'ai', data: 'nope', extras: { ai: { type: 'response.output_item.added' } } } },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode response.output_item.added; data is not an object',
      });
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
          sequence_number: 4,
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
