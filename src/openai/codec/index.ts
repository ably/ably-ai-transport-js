/**
 * The OpenAI Responses codec: one row per stream event type, plus the `input`
 * a client publishes.
 *
 * Several event types stream. Their deltas are appended to a single message,
 * and the event that opens a stream and the `*.done` that closes it are plain
 * publishes of their own. Four streams are keyed by the item id: a function
 * call's `arguments`, a code interpreter call's `code`, a custom tool call's
 * `input` and an MCP call's `arguments`. Each `*.delta` carries its text as
 * the message `data`; the first delta publishes the message, the rest append
 * to it, and the matching `*.done` ends the key. A content part is keyed by
 * item id and content index, and the `output_text`, `refusal` and
 * `reasoning_text` deltas append under it until the matching `*.done`. A
 * reasoning summary is keyed by item id and summary index, and its text
 * deltas append until `reasoning_summary_text.done`.
 *
 * Ably's append replaces the stored `extras` with the extras from the last
 * append operation. So when history returns the message the deltas built, it
 * carries the last delta's type and fields and the whole text as its `data`.
 * A subscriber that reads history, or that joins late, decodes one delta
 * event carrying all of the text where a live subscriber decoded many.
 *
 * Text that streamed as deltas goes on the wire once. The Responses API
 * repeats it four more times: a stream's `*.done` carries the joined text,
 * the events that mark streaming as ended (`content_part.done` and
 * `reasoning_summary_part.done`) carry the finished part,
 * `response.output_item.done` carries the finished item with its content, and
 * the terminal event carries the whole response with every item in it. The
 * codec sends each of those text fields as an empty string: a closer's text
 * field, a finished part's `text` or `refusal`, and a finished item's streamed
 * fields (a function call's `arguments`, a code interpreter call's `code`, a
 * custom tool call's `input`, an MCP call's `arguments`, a message part's
 * `text` or `refusal`, a reasoning item's summary and content text). It sends
 * the terminal response's `output` as `[]`. Fields the deltas could not carry
 * travel as they are: a part's `annotations` and `logprobs`, a reasoning
 * item's `encrypted_content`, the response's `usage` and `status`. A
 * subscriber that wants the finished text merges the deltas it already
 * received.
 *
 * `response.created`, `response.in_progress` and `response.queued` publish
 * nothing: they carry a response with no output yet. Every other event is a
 * plain publish that nothing appends to, so it travels whole as the message
 * `data`, an object, with no fields and with the repeats above sent empty
 * inside it. That includes the audio deltas, the audio transcript deltas and
 * a partial image: they name no item to key a stream on, and a base64 chunk
 * is not joined onto another, so each is its own message. No row writes Ably
 * `headers`: every field an event carries is an event field.
 */

import * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';

import type { Codec, DecodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { OpenAIEvent } from './events.js';

/** The value the codec stamps as its `adapterTag`. */
const ADAPTER_TAG = 'openai-responses';

type Row<T extends OpenAIEvent['type']> = EventRow<OpenAIEvent, T>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rebuild an event from the body a plain publish carried and the type the
 * builder matched. The body carries a `type` of its own, since encode sends
 * the whole event; the builder's is the one that picked the row, so it is
 * the one used.
 * @param body - The row body.
 * @param body.data - The event, as the message body.
 * @param body.type - The type the builder matched.
 * @returns The event.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the body is not an object.
 */
const event = ({ data, type }: DecodedRow): OpenAIEvent => {
  if (!isRecord(data)) {
    throw new Ably.ErrorInfo(`unable to decode ${type}; data is not an object`, ErrorCode.InvalidArgument, 400);
  }
  // CAST: trust boundary of what was received on the wire. data is the event's own fields, and entire record is OpenAIEvent
  return { ...data, type } as OpenAIEvent;
};

/**
 * The decode every delta row shares: the text comes back from `data`, the rest
 * of the event from `fields`. Every streaming event names its text `delta`.
 * @param body - The row body.
 * @param body.data - The delta's text, as the appended message body.
 * @param body.fields - The event's other fields, as encode wrote them.
 * @param body.type - The type the builder matched.
 * @returns The event.
 */
const deltaEvent = ({ data, fields, type }: DecodedRow): OpenAIEvent =>
  // CAST: trust boundary of what was received on the wire. delta is string data, and entire record is OpenAIEvent
  ({ ...fields, type, delta: asString(data) }) as OpenAIEvent;

/**
 * The row of an event that travels whole as the message body.
 * @returns The row.
 */
const plain = <T extends OpenAIEvent['type']>(): Row<T> => ({
  encode: (e) => ({ data: e }),
  decode: event,
});

/**
 * The row of an event that publishes nothing.
 * @returns The row.
 */
const silent = <T extends OpenAIEvent['type']>(): Row<T> => ({
  // eslint-disable-next-line unicorn/no-useless-undefined -- a row that publishes nothing returns undefined
  encode: () => undefined,
  decode: event,
});

/**
 * A copy of `record` with each named string field emptied, where present. The
 * text those fields carry streamed as deltas ahead of the event that repeats it.
 * @param record - The record.
 * @param fields - The fields to empty.
 * @returns The copy.
 */
const emptied = (record: Record<string, unknown>, ...fields: string[]): Record<string, unknown> => {
  const copy = { ...record };
  for (const field of fields) {
    if (typeof copy[field] === 'string') copy[field] = '';
  }
  return copy;
};

/**
 * One content or summary part with its `text` or `refusal` emptied.
 * @param part - The part, as the event or item carries it.
 * @returns The part, emptied.
 */
const emptiedPart = (part: unknown): unknown => (isRecord(part) ? emptied(part, 'text', 'refusal') : part);

/**
 * Content or summary parts with their `text` or `refusal` emptied.
 * @param parts - The parts, as the item carries them.
 * @returns The parts, emptied.
 */
const emptiedParts = (parts: unknown): unknown =>
  Array.isArray(parts) ? parts.map((part: unknown) => emptiedPart(part)) : parts;

/**
 * A finished output item with the content its deltas already streamed emptied:
 * a function or MCP call's `arguments`, a code interpreter call's `code`, a
 * custom tool call's `input`, a message part's `text` or `refusal`, and a
 * reasoning item's summary and content text. An item of any other type travels
 * whole, since nothing of it streamed as appends.
 * @param item - The finished item.
 * @returns The item, emptied.
 */
const withoutRepeatedContent = (item: unknown): unknown => {
  if (!isRecord(item)) return item;
  switch (item.type) {
    case 'function_call':
    case 'mcp_call': {
      return emptied(item, 'arguments');
    }
    case 'code_interpreter_call': {
      return emptied(item, 'code');
    }
    case 'custom_tool_call': {
      return emptied(item, 'input');
    }
    case 'message': {
      return { ...item, content: emptiedParts(item.content) };
    }
    case 'reasoning': {
      const copy = { ...item };
      if ('summary' in item) copy.summary = emptiedParts(item.summary);
      if ('content' in item) copy.content = emptiedParts(item.content);
      return copy;
    }
    default: {
      return item;
    }
  }
};

/**
 * A response with its `output` emptied: every item in it streamed already.
 * @param response - The response a terminal event carries.
 * @returns The response, emptied.
 */
const withoutOutput = (response: unknown): unknown =>
  isRecord(response) && Array.isArray(response.output) ? { ...response, output: [] } : response;

/**
 * The stream key of a content part: its item and its slot in the item's content.
 * @param e - The event naming the part.
 * @param e.item_id - The item the part belongs to.
 * @param e.content_index - The part's slot in the item's content.
 * @returns The key.
 */
const contentSlot = (e: { item_id: string; content_index: number }): string =>
  `${e.item_id}:${String(e.content_index)}`;

/**
 * The stream key of a reasoning summary part: its item and its slot in the summary.
 * @param e - The event naming the part.
 * @param e.item_id - The reasoning item the part belongs to.
 * @param e.summary_index - The part's slot in the item's summary.
 * @returns The key.
 */
const summarySlot = (e: { item_id: string; summary_index: number }): string =>
  `${e.item_id}:summary:${String(e.summary_index)}`;

/**
 * Whether `data` is a list of Responses input items: the check the agent
 * relies on before it hands them to the model.
 * @param data - The delivered `data`.
 * @returns True when the shape is a list of items.
 */
const isInputItems = (data: unknown): data is Responses.ResponseInputItem[] =>
  Array.isArray(data) && data.every((item: unknown) => isRecord(item));

/**
 * Build the OpenAI Responses codec. Each call builds a fresh codec with its
 * own decoder table.
 * @returns The codec.
 */
export const createOpenAICodec = (): Codec<OpenAIEvent> =>
  defineCodec({
    name: 'ai',
    adapterTag: ADAPTER_TAG,
    typeOf: (e: OpenAIEvent) => e.type,
    events: {
      // The response lifecycle. The openers carry a response with no output
      // yet. A terminal event carries the response as `data`, and that
      // response repeats every output item the earlier streaming events
      // already delivered, so the codec strips `output` rather than send the
      // whole turn a second time.
      'response.created': silent(),
      'response.in_progress': silent(),
      'response.queued': silent(),
      'response.completed': {
        encode: (e) => ({ data: { ...e, response: withoutOutput(e.response) } }),
        decode: event,
      },
      'response.incomplete': {
        encode: (e) => ({ data: { ...e, response: withoutOutput(e.response) } }),
        decode: event,
      },
      'response.failed': {
        encode: (e) => ({ data: { ...e, response: withoutOutput(e.response) } }),
        decode: event,
      },
      error: plain(),

      // Output items. A function call's arguments stream under its item id;
      // the finished item travels with its repeated content emptied. A delta
      // carries its text as `data` and the rest of the event as `fields`, since
      // an append grows `data` and carries nothing else; its closer publishes
      // the event whole with the field that repeats that text emptied.
      'response.output_item.added': plain(),
      'response.output_item.done': {
        encode: (e) => ({ data: { ...e, item: withoutRepeatedContent(e.item) } }),
        decode: event,
      },
      'response.function_call_arguments.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: rest.item_id }),
        decode: deltaEvent,
      },
      'response.function_call_arguments.done': {
        encode: (e) => ({ data: { ...e, arguments: '' }, ends: e.item_id }),
        decode: event,
      },

      // Content parts: output text, refusal and reasoning text share the key.
      'response.content_part.added': plain(),
      'response.content_part.done': {
        encode: (e) => ({ data: { ...e, part: emptiedPart(e.part) } }),
        decode: event,
      },
      'response.output_text.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: contentSlot(rest) }),
        decode: deltaEvent,
      },
      'response.output_text.done': {
        encode: (e) => ({ data: { ...e, text: '' }, ends: contentSlot(e) }),
        decode: event,
      },
      'response.refusal.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: contentSlot(rest) }),
        decode: deltaEvent,
      },
      'response.refusal.done': {
        encode: (e) => ({ data: { ...e, refusal: '' }, ends: contentSlot(e) }),
        decode: event,
      },
      'response.reasoning_text.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: contentSlot(rest) }),
        decode: deltaEvent,
      },
      'response.reasoning_text.done': {
        encode: (e) => ({ data: { ...e, text: '' }, ends: contentSlot(e) }),
        decode: event,
      },
      'response.output_text.annotation.added': plain(),

      // Reasoning summaries.
      'response.reasoning_summary_part.added': plain(),
      'response.reasoning_summary_part.done': {
        encode: (e) => ({ data: { ...e, part: emptiedPart(e.part) } }),
        decode: event,
      },
      'response.reasoning_summary_text.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: summarySlot(rest) }),
        decode: deltaEvent,
      },
      'response.reasoning_summary_text.done': {
        encode: (e) => ({ data: { ...e, text: '' }, ends: summarySlot(e) }),
        decode: event,
      },

      // Hosted tools that stream: code, custom tool input and MCP arguments
      // are keyed by their item id, as a function call's arguments are.
      'response.code_interpreter_call_code.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: rest.item_id }),
        decode: deltaEvent,
      },
      'response.code_interpreter_call_code.done': {
        encode: (e) => ({ data: { ...e, code: '' }, ends: e.item_id }),
        decode: event,
      },
      'response.custom_tool_call_input.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: rest.item_id }),
        decode: deltaEvent,
      },
      'response.custom_tool_call_input.done': {
        encode: (e) => ({ data: { ...e, input: '' }, ends: e.item_id }),
        decode: event,
      },
      'response.mcp_call_arguments.delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: rest.item_id }),
        decode: deltaEvent,
      },
      'response.mcp_call_arguments.done': {
        encode: (e) => ({ data: { ...e, arguments: '' }, ends: e.item_id }),
        decode: event,
      },

      // The rest of the hosted-tool lifecycle travels whole, one message per
      // event. That includes the audio deltas: the API models audio as one
      // output per response, so the events carry no item id or index to key a
      // stream on, and a base64 audio chunk is not safely joined onto another.
      // A partial image is a whole image at a lower resolution, not a
      // fragment, so it travels whole too.
      'response.audio.delta': plain(),
      'response.audio.done': plain(),
      'response.audio.transcript.delta': plain(),
      'response.audio.transcript.done': plain(),
      'response.code_interpreter_call.completed': plain(),
      'response.code_interpreter_call.in_progress': plain(),
      'response.code_interpreter_call.interpreting': plain(),
      'response.file_search_call.completed': plain(),
      'response.file_search_call.in_progress': plain(),
      'response.file_search_call.searching': plain(),
      'response.image_generation_call.completed': plain(),
      'response.image_generation_call.generating': plain(),
      'response.image_generation_call.in_progress': plain(),
      'response.image_generation_call.partial_image': plain(),
      'response.mcp_call.completed': plain(),
      'response.mcp_call.failed': plain(),
      'response.mcp_call.in_progress': plain(),
      'response.mcp_list_tools.completed': plain(),
      'response.mcp_list_tools.failed': plain(),
      'response.mcp_list_tools.in_progress': plain(),
      'response.web_search_call.completed': plain(),
      'response.web_search_call.in_progress': plain(),
      'response.web_search_call.searching': plain(),

      // The codec's own event, not one of the API's: the Responses input items
      // a client publishes to start a turn or answer a function call, in the
      // API's own input item type so the agent hands them to the model as they
      // are. See `OpenAIInput` in ./events.ts.
      input: {
        encode: (e) => ({ data: e.items }),
        decode: (m) => {
          const data: unknown = m.data;
          if (!isInputItems(data)) {
            throw new Ably.ErrorInfo(
              'unable to decode input; data is not a list of input items',
              ErrorCode.InvalidArgument,
              400,
            );
          }
          return { type: 'input', items: data };
        },
      },
    },
  });

/** The OpenAI Responses codec, with one decoder table shared by every transport that uses it. */
export const openai: Codec<OpenAIEvent> = createOpenAICodec();
