/**
 * The OpenAI Responses codec: one row per stream event type, plus the `input`
 * a client publishes.
 *
 * Three families stream, and in each the deltas alone share a message; the
 * event that opens a stream and the `*.done` that closes it are plain
 * publishes of their own. A function call's arguments are keyed by the item
 * id: each `function_call_arguments.delta` appends as the message `data`, the
 * first one publishing the message the rest append to, and
 * `function_call_arguments.done` ends the key. A content part is keyed by
 * item id and content index, and the `output_text`, `refusal` and
 * `reasoning_text` deltas append under it until the matching `*.done`. A
 * reasoning summary is keyed by item id and summary index, and its text
 * deltas append until `reasoning_summary_text.done`. Ably's append replaces
 * the stored `extras`, so the message the deltas share reads back from
 * history under the delta type with the joined text as its `data`, and the
 * sequence history or a late joiner decodes is the one the agent produced,
 * with the deltas joined.
 *
 * Text that streamed as deltas goes on the wire once. The Responses API
 * repeats it three times over: a stream's `*.done` carries the joined text,
 * `response.output_item.done` carries the finished item with its content, and
 * the terminal event carries the whole response with every item in it. The
 * codec empties each repeat: a closer's text field is `''`, a finished item's
 * streamed fields are `''` (a function call's `arguments`, a message part's
 * `text` or `refusal`, a reasoning item's summary and content text), and the
 * terminal response's `output` is `[]`. What the deltas could not carry stays:
 * a part's `annotations` and `logprobs`, a reasoning item's
 * `encrypted_content`, the response's `usage` and `status`. A subscriber that
 * wants the finished text folds the deltas it already received.
 *
 * `response.created`, `response.in_progress` and `response.queued` publish
 * nothing: they carry a response with no output yet. Every other event travels
 * whole as a plain publish, its fields as the row's headers, except that a
 * terminal event carries its `response` and `response.output_item.done` its
 * `item` as the message `data`. Nothing on the wire carries `sequence_number`.
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
 * An event's fields for the wire: everything but `sequence_number`.
 * @param event - The event.
 * @returns The fields.
 */
const fieldsFor = (event: object): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...event };
  delete fields.sequence_number;
  return fields;
};

/**
 * Rebuild an event from the headers a plain publish carried and the type the
 * builder matched. The spread headers carry a `type` of their own, since
 * encode spreads the whole event; the builder's is the one that picked the
 * row, so it is the one used.
 * @param body - The row body.
 * @param body.headers - The event's fields.
 * @param body.type - The type the builder matched.
 * @returns The event.
 */
const event = ({ headers, type }: DecodedRow): OpenAIEvent =>
  // CAST: wire trust boundary. The headers were written by this codec's encode
  // from the event itself, and the builder has already matched `type` to a row.
  ({ ...headers, type }) as OpenAIEvent;

/**
 * A decode that restores one text field from `data`.
 * @param field - The event field the text travelled as `data` for.
 * @returns The decode.
 */
const withText =
  (field: string) =>
  ({ data, headers, type }: DecodedRow): OpenAIEvent =>
    // CAST: as `event`, with one field restored from `data`.
    ({ ...headers, type, [field]: asString(data) }) as OpenAIEvent;

/**
 * A decode that restores one object field from `data`.
 * @param field - The event field the object travelled as `data` for.
 * @returns The decode.
 */
const withValue =
  (field: string) =>
  ({ data, headers, type }: DecodedRow): OpenAIEvent =>
    // CAST: as `event`; the value is the provider's own object and stays unconstrained.
    ({ ...headers, type, [field]: data }) as OpenAIEvent;

/**
 * The row of an event that travels whole in its headers.
 * @returns The row.
 */
const plain = <T extends OpenAIEvent['type']>(): Row<T> => ({
  encode: (e) => ({ headers: fieldsFor(e) }),
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
 * Content or summary parts with their `text` or `refusal` emptied.
 * @param parts - The parts, as the item carries them.
 * @returns The parts, emptied.
 */
const emptiedParts = (parts: unknown): unknown =>
  Array.isArray(parts)
    ? parts.map((part: unknown) => (isRecord(part) ? emptied(part, 'text', 'refusal') : part))
    : parts;

/**
 * A finished output item with the text its deltas streamed emptied: a function
 * call's `arguments`, a message part's `text` or `refusal`, and a reasoning
 * item's summary and content text. An item of any other type travels whole,
 * since nothing of it streamed as appends.
 * @param item - The finished item.
 * @returns The item, emptied.
 */
const withoutStreamedText = (item: unknown): unknown => {
  if (!isRecord(item)) return item;
  switch (item.type) {
    case 'function_call': {
      return emptied(item, 'arguments');
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
 * The row of a terminal event: its `response`, with `output` emptied, as the
 * message `data`.
 * @returns The row.
 */
const terminal = <T extends OpenAIEvent['type']>(): Row<T> => ({
  encode: (e) => {
    const { response, ...rest } = fieldsFor(e);
    return { data: withoutOutput(response), headers: rest };
  },
  decode: withValue('response'),
});

/**
 * The row of `response.output_item.done`: its `item`, with the streamed text
 * emptied, as the message `data`.
 * @returns The row.
 */
const finishedItem = <T extends OpenAIEvent['type']>(): Row<T> => ({
  encode: (e) => {
    const { item, ...rest } = fieldsFor(e);
    return { data: withoutStreamedText(item), headers: rest };
  },
  decode: withValue('item'),
});

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
 * The delta row of a stream: the text goes as `data`, the rest of the event
 * as fields, appended under the key. The first delta of a stream is the
 * publish that opens its message.
 * @param keyOf - The stream key of the delta.
 * @returns The row.
 */
const delta = <T extends OpenAIEvent['type']>(keyOf: (e: Record<string, unknown>) => string): Row<T> => ({
  encode: (e) => {
    const { delta: text, ...rest } = fieldsFor(e);
    return { data: text, headers: rest, append: keyOf(rest) };
  },
  decode: withText('delta'),
});

/**
 * The closer row of a stream: the event as a plain publish that ends the key,
 * with the field that repeats the streamed text emptied.
 * @param keyOf - The stream key of the closer.
 * @param field - The field carrying the joined text the deltas already streamed.
 * @returns The row.
 */
const closer = <T extends OpenAIEvent['type']>(
  keyOf: (e: Record<string, unknown>) => string,
  field: string,
): Row<T> => ({
  encode: (e) => {
    const fields = fieldsFor(e);
    return { headers: emptied(fields, field), ends: keyOf(fields) };
  },
  decode: event,
});

const contentKey = (fields: Record<string, unknown>): string =>
  contentSlot({ item_id: asString(fields.item_id), content_index: Number(fields.content_index) });
const summaryKey = (fields: Record<string, unknown>): string =>
  summarySlot({ item_id: asString(fields.item_id), summary_index: Number(fields.summary_index) });
const itemKey = (fields: Record<string, unknown>): string => asString(fields.item_id);

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
      // yet; the terminal events carry the response as `data`, its `output`
      // emptied because every item in it streamed.
      'response.created': silent(),
      'response.in_progress': silent(),
      'response.queued': silent(),
      'response.completed': terminal(),
      'response.incomplete': terminal(),
      'response.failed': terminal(),
      error: plain(),

      // Output items. A function call's arguments stream under its item id;
      // the finished item travels with its streamed text emptied.
      'response.output_item.added': plain(),
      'response.output_item.done': finishedItem(),
      'response.function_call_arguments.delta': delta(itemKey),
      'response.function_call_arguments.done': closer(itemKey, 'arguments'),

      // Content parts: output text, refusal and reasoning text share the key.
      'response.content_part.added': plain(),
      'response.content_part.done': plain(),
      'response.output_text.delta': delta(contentKey),
      'response.output_text.done': closer(contentKey, 'text'),
      'response.refusal.delta': delta(contentKey),
      'response.refusal.done': closer(contentKey, 'refusal'),
      'response.reasoning_text.delta': delta(contentKey),
      'response.reasoning_text.done': closer(contentKey, 'text'),
      'response.output_text.annotation.added': plain(),

      // Reasoning summaries.
      'response.reasoning_summary_part.added': plain(),
      'response.reasoning_summary_part.done': plain(),
      'response.reasoning_summary_text.delta': delta(summaryKey),
      'response.reasoning_summary_text.done': closer(summaryKey, 'text'),

      // Hosted tools and other modalities travel whole, one message per event.
      'response.audio.delta': plain(),
      'response.audio.done': plain(),
      'response.audio.transcript.delta': plain(),
      'response.audio.transcript.done': plain(),
      'response.code_interpreter_call_code.delta': plain(),
      'response.code_interpreter_call_code.done': plain(),
      'response.code_interpreter_call.completed': plain(),
      'response.code_interpreter_call.in_progress': plain(),
      'response.code_interpreter_call.interpreting': plain(),
      'response.custom_tool_call_input.delta': plain(),
      'response.custom_tool_call_input.done': plain(),
      'response.file_search_call.completed': plain(),
      'response.file_search_call.in_progress': plain(),
      'response.file_search_call.searching': plain(),
      'response.image_generation_call.completed': plain(),
      'response.image_generation_call.generating': plain(),
      'response.image_generation_call.in_progress': plain(),
      'response.image_generation_call.partial_image': plain(),
      'response.mcp_call_arguments.delta': plain(),
      'response.mcp_call_arguments.done': plain(),
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
