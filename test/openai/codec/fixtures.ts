/**
 * The Responses API stream for a turn that calls a function, then answers:
 * two responses, the second after the client sends the function call's output
 * back as input. Shared by the OpenAI codec's unit and integration suites.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { OpenAIEvent } from '../../../src/openai/index.js';

// CAST: the suites read only `id` and `status` off a response; a minimal stub
// stands in for the full shape.
const response = (id: string, status: Responses.ResponseStatus): Responses.Response =>
  ({ id, status, output: [] }) as unknown as Responses.Response;

export const functionCall: Responses.ResponseFunctionToolCall = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'weather',
  arguments: '',
  status: 'in_progress',
};

export const message: Responses.ResponseOutputMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  status: 'in_progress',
  content: [],
};

/** The first response: the model calls a tool. */
export const toolCallResponse: OpenAIEvent[] = [
  { type: 'response.created', response: response('resp_1', 'in_progress'), sequence_number: 0 },
  { type: 'response.output_item.added', output_index: 0, item: functionCall, sequence_number: 1 },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '{"city":',
    sequence_number: 2,
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '"London"}',
    sequence_number: 3,
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_1',
    name: 'weather',
    output_index: 0,
    arguments: '{"city":"London"}',
    sequence_number: 4,
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: { ...functionCall, arguments: '{"city":"London"}', status: 'completed' },
    sequence_number: 5,
  },
  { type: 'response.completed', response: response('resp_1', 'completed'), sequence_number: 6 },
];

/** The second response: the model answers in text. */
export const textResponse: OpenAIEvent[] = [
  { type: 'response.created', response: response('resp_2', 'in_progress'), sequence_number: 0 },
  { type: 'response.output_item.added', output_index: 0, item: message, sequence_number: 1 },
  {
    type: 'response.content_part.added',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
    sequence_number: 2,
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'It is 21°C',
    logprobs: [],
    sequence_number: 3,
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: ' in London.',
    logprobs: [],
    sequence_number: 4,
  },
  {
    type: 'response.output_text.done',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    text: 'It is 21°C in London.',
    logprobs: [],
    sequence_number: 5,
  },
  {
    type: 'response.content_part.done',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: 'It is 21°C in London.', annotations: [] },
    sequence_number: 6,
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      ...message,
      status: 'completed',
      content: [{ type: 'output_text', text: 'It is 21°C in London.', annotations: [] }],
    },
    sequence_number: 7,
  },
  { type: 'response.completed', response: response('resp_2', 'completed'), sequence_number: 8 },
];

/**
 * The events a subscriber decodes for a response: everything but the opener,
 * without `sequence_number`, and with each repeat of streamed text emptied: a
 * closer's text field, a finished item's streamed fields, and the terminal
 * response's `output`.
 * @param events - The response's events.
 * @returns The expected decoded events.
 */
export const decodedOf = (events: OpenAIEvent[]): OpenAIEvent[] =>
  events
    .filter((e) => e.type !== 'response.created')
    .map((e) => {
      const fields = Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'sequence_number'));
      switch (e.type) {
        case 'response.function_call_arguments.done': {
          fields.arguments = '';
          break;
        }
        case 'response.output_text.done': {
          fields.text = '';
          break;
        }
        case 'response.output_item.done': {
          fields.item = withoutStreamedText(e.item);
          break;
        }
        case 'response.completed': {
          fields.response = { ...e.response, output: [] };
          break;
        }
        default: {
          break;
        }
      }
      // CAST: the same member as the fixture holds, with the fields the codec empties emptied.
      return fields as OpenAIEvent;
    });

/**
 * A finished item as the codec carries it: the fixtures' function call with
 * its `arguments` emptied, or message with its parts' `text` emptied.
 * @param item - The fixture's finished item.
 * @returns The emptied item.
 */
const withoutStreamedText = (item: Responses.ResponseOutputItem): Responses.ResponseOutputItem => {
  if (item.type === 'function_call') return { ...item, arguments: '' };
  if (item.type === 'message') {
    return {
      ...item,
      content: item.content.map((part) => (part.type === 'output_text' ? { ...part, text: '' } : part)),
    };
  }
  return item;
};

/**
 * The event at `index`, for a fixture that must hold one there.
 * @param events - The fixture.
 * @param index - The position.
 * @returns The event.
 */
export const at = (events: OpenAIEvent[], index: number): OpenAIEvent => {
  const event = events[index];
  if (event === undefined) throw new Error(`fixture has no event at ${String(index)}`);
  return event;
};
