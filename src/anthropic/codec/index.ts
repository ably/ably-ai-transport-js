/**
 * The Anthropic Messages codec: one row per stream event type, plus the
 * `input` a client publishes.
 *
 * Text, thinking and tool input deltas append to one message per content
 * block, keyed by the block's index, and `content_block_stop` ends the key.
 * Signature and citation deltas are messages of their own: the SDK's reducer
 * sets a signature and collects citations rather than joining text, and puts
 * both on their block whatever order they arrive in.
 *
 * The SDK yields `message_start` with the message it keeps adding blocks to,
 * so the codec sends its `content` as `[]`, as the API did.
 */

import * as Ably from '@ably/pubsub-core';
import type * as Anthropic from '@anthropic-ai/sdk/resources/messages';

import type { Codec, DecodedRow, EncodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { AnthropicEvent } from './events.js';

/** The codec's id. */
const CODEC_ID = 'anthropic-messages';

type Row<T extends AnthropicEvent['type']> = EventRow<AnthropicEvent, T>;

/** The field each streaming delta type carries its text in. */
const TEXT_FIELDS = new Map<string, string>([
  ['text_delta', 'text'],
  ['thinking_delta', 'thinking'],
  ['input_json_delta', 'partial_json'],
]);

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
const event = ({ data, type }: DecodedRow): AnthropicEvent => {
  if (!isRecord(data)) {
    throw new Ably.ErrorInfo(`unable to decode ${type}; data is not an object`, ErrorCode.InvalidArgument, 400);
  }

  // CAST: trust boundary of what was received on the wire. data is the
  // event's own fields, and the entire record is an AnthropicEvent.
  return { ...data, type } as AnthropicEvent;
};

/**
 * Rebuild a `content_block_delta`. A delta that travels whole carries the
 * event as an object; a streaming delta carries its text as `data`, and the
 * rest of the event, with the delta's type, as `fields`.
 * @param body - The row body.
 * @returns The event.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a streamed delta names a type that carries no text.
 */
const deltaEvent = (body: DecodedRow): AnthropicEvent => {
  if (isRecord(body.data)) return event(body);

  const delta = isRecord(body.fields.delta) ? body.fields.delta : {};
  const textField = typeof delta.type === 'string' ? TEXT_FIELDS.get(delta.type) : undefined;

  if (textField === undefined) {
    throw new Ably.ErrorInfo(
      `unable to decode ${body.type}; delta type ${String(delta.type)} does not stream text`,
      ErrorCode.InvalidArgument,
      400,
    );
  }

  // CAST: trust boundary of what was received on the wire. The text is
  // string data, and the entire record is an AnthropicEvent.
  return { ...body.fields, type: body.type, delta: { ...delta, [textField]: asString(body.data) } } as AnthropicEvent;
};

/**
 * The row of an event that travels whole as the message body.
 * @returns The row.
 */
const plain = <T extends AnthropicEvent['type']>(): Row<T> => ({
  encode: (e) => ({ data: e }),
  decode: event,
});

/**
 * Encode a `content_block_delta`: a text, thinking or tool input delta
 * appends its text under the block's key, and a signature or citation travels
 * whole.
 * @param e - The event.
 * @returns The row's output.
 * @throws {Ably.ErrorInfo} `InvalidArgument` for a delta type the codec does not know.
 */
const encodeDelta = (e: Anthropic.RawContentBlockDeltaEvent): EncodedRow => {
  const { delta, ...rest } = e;
  const streamed = (text: string): EncodedRow => ({
    data: text,
    fields: { ...rest, delta: { type: delta.type } },
    append: String(e.index),
  });

  switch (delta.type) {
    case 'text_delta': {
      return streamed(delta.text);
    }
    case 'thinking_delta': {
      return streamed(delta.thinking);
    }
    case 'input_json_delta': {
      return streamed(delta.partial_json);
    }
    case 'signature_delta':
    case 'citations_delta': {
      return { data: e };
    }
    default: {
      // A delta type the SDK added after the codec was written.
      const unknown: { type?: unknown } = delta satisfies never;
      throw new Ably.ErrorInfo(
        `unable to encode content_block_delta; no row for delta type '${String(unknown.type)}'`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
  }
};

/**
 * Whether `data` is a list of message params.
 * @param data - The delivered `data`.
 * @returns True when the shape is a list of messages.
 */
const isMessageParams = (data: unknown): data is Anthropic.MessageParam[] =>
  Array.isArray(data) && data.every((message: unknown) => isRecord(message));

/**
 * Build the Anthropic Messages codec.
 * @returns The codec.
 */
export const createAnthropicCodec = (): Codec<AnthropicEvent> =>
  defineCodec({
    id: CODEC_ID,
    typeOf: (e: AnthropicEvent) => e.type,
    events: {
      message_start: {
        encode: (e) => ({ data: { ...e, message: { ...e.message, content: [] } } }),
        decode: event,
      },
      message_delta: plain(),
      message_stop: plain(),

      content_block_start: plain(),
      content_block_delta: {
        encode: encodeDelta,
        decode: deltaEvent,
      },
      content_block_stop: {
        encode: (e) => ({ data: e, ends: String(e.index) }),
        decode: event,
      },

      // The codec's own event; see `AnthropicInput`.
      input: {
        encode: (e) => ({ data: e.messages }),
        decode: (m) => {
          const data: unknown = m.data;

          if (!isMessageParams(data)) {
            throw new Ably.ErrorInfo(
              'unable to decode input; data is not a list of messages',
              ErrorCode.InvalidArgument,
              400,
            );
          }

          return { type: 'input', messages: data };
        },
      },
    },
  });

/** The Anthropic Messages codec. */
export const anthropic: Codec<AnthropicEvent> = createAnthropicCodec();
