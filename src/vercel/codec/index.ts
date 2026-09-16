/**
 * The Vercel AI SDK codec: one row per `UIMessageChunk` type, plus the
 * `user-message` a client publishes to start a turn.
 *
 * Three chunk types stream: `text-delta`, `reasoning-delta` and
 * `tool-input-delta`. Their deltas are appended to a single message: each
 * delta carries its text as the message `data` and the rest of the chunk as
 * headers, the first delta publishes the message under the stream id or tool
 * call id, and the rest append to it. The start chunk before them and the
 * end chunk after them are plain publishes of their own, and the end chunk
 * ends the key. `tool-input-available` is the closer of a tool input stream;
 * the SDK emits it straight from a `tool-call` when a provider does not
 * stream tool input, so it ends the key when there is one.
 *
 * Ably's append replaces the stored `extras` with the extras from the last
 * append operation. So when history returns the message the deltas built, it
 * carries the last delta's headers and the whole text as its `data`, and a
 * subscriber that reads history, or that joins late, decodes one delta
 * carrying all of the text where a live subscriber decoded many.
 *
 * Every other chunk is a plain publish that nothing appends to, so it travels
 * whole as the message `data`, an object, with no headers. A `user-message`
 * carries the `UIMessage` a client publishes. A transient `data-*` part is
 * published ephemeral, so it reaches subscribers and stays out of history.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { Codec, DecodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { VercelEvent } from './events.js';

/** The value every codec built here stamps as its `adapterTag`. */
const ADAPTER_TAG = 'vercel-ai-sdk-ui-message';

type Row<T extends VercelEvent['type']> = EventRow<VercelEvent, T>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rebuild an event from the body a plain publish carried and the type the
 * builder matched. The body carries a `type` of its own, since encode sends
 * the whole chunk; the builder's is the one that picked the row, so it is the
 * one used.
 * @param body - The row body.
 * @param body.data - The chunk, as the message body.
 * @param body.type - The type the builder matched.
 * @returns The event.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the body is not an object.
 */
const event = ({ data, type }: DecodedRow): VercelEvent => {
  if (!isRecord(data)) {
    throw new Ably.ErrorInfo(`unable to decode ${type}; data is not an object`, ErrorCode.InvalidArgument, 400);
  }
  // CAST: trust boundary of what was received on the wire. data is the chunk's own fields, and entire record is VercelEvent
  return { ...data, type } as VercelEvent;
};

/**
 * The row of a chunk that travels whole as the message body.
 * @returns The row.
 */
const plain = <T extends VercelEvent['type']>(): Row<T> => ({
  encode: (e) => ({ data: e }),
  decode: event,
});

/**
 * Whether `data` is a `UIMessage`: the checks a reducer relies on before it
 * reads anything else.
 * @param data - The delivered `data`.
 * @returns True when the shape is a message.
 */
const isUIMessage = (data: unknown): data is AI.UIMessage =>
  isRecord(data) && typeof data.id === 'string' && typeof data.role === 'string' && Array.isArray(data.parts);

/**
 * Build the Vercel codec, typed for a consumer's `UIMessage` generic
 * parameters. Each call builds a fresh codec with its own decoder table.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the user message's tool parts.
 * @returns The codec.
 */
export const createVercelCodec = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(): Codec<VercelEvent<TMetadata, TDataParts, TTools>> => {
  const codec = defineCodec({
    name: 'ai',
    adapterTag: ADAPTER_TAG,
    typeOf: (e: VercelEvent) => e.type,
    events: {
      // Streams: the start is a plain publish, each delta appends its text as
      // `data` under the key with the rest of the chunk as headers (the first
      // one opening the message), and the end is a plain publish that ends
      // the key.
      'text-start': plain(),
      'text-delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, headers: rest, append: rest.id }),
        // CAST: trust boundary of what was received on the wire. delta is string data, and entire record is VercelEvent
        decode: ({ data, headers, type }) => ({ ...headers, type, delta: asString(data) }) as VercelEvent,
      },
      'text-end': {
        encode: (e) => ({ data: e, ends: e.id }),
        decode: event,
      },
      'reasoning-start': plain(),
      'reasoning-delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, headers: rest, append: rest.id }),
        // CAST: trust boundary of what was received on the wire. delta is string data, and entire record is VercelEvent
        decode: ({ data, headers, type }) => ({ ...headers, type, delta: asString(data) }) as VercelEvent,
      },
      'reasoning-end': {
        encode: (e) => ({ data: e, ends: e.id }),
        decode: event,
      },
      'tool-input-start': plain(),
      'tool-input-delta': {
        encode: ({ inputTextDelta, ...rest }) => ({ data: inputTextDelta, headers: rest, append: rest.toolCallId }),
        // CAST: trust boundary of what was received on the wire. inputTextDelta is string data, and entire record is VercelEvent
        decode: ({ data, headers, type }) => ({ ...headers, type, inputTextDelta: asString(data) }) as VercelEvent,
      },
      'tool-input-available': {
        // The SDK emits this with no start when a provider does not stream
        // tool input; it ends the key when one is live.
        encode: (e) => ({ data: e, ends: e.toolCallId }),
        decode: event,
      },
      'tool-input-error': {
        encode: (e) => ({ data: e, ends: e.toolCallId }),
        decode: event,
      },

      // A data part travels whole like any other chunk; a transient one is
      // published ephemeral.
      'tool-output-available': plain(),
      'data-*': {
        encode: (e) => (e.transient === true ? { data: e, ephemeral: true } : { data: e }),
        decode: event,
      },
      'user-message': {
        encode: (e) => ({ data: e.message }),
        decode: (m) => {
          const data: unknown = m.data;
          if (!isUIMessage(data)) {
            throw new Ably.ErrorInfo(
              'unable to decode user-message; data is not a UIMessage',
              ErrorCode.InvalidArgument,
              400,
            );
          }
          return { type: 'user-message', message: data };
        },
      },

      // Everything else travels whole.
      start: plain(),
      'start-step': plain(),
      'finish-step': plain(),
      'reset-step': plain(),
      finish: plain(),
      abort: plain(),
      error: plain(),
      'message-metadata': plain(),
      file: plain(),
      'reasoning-file': plain(),
      'source-url': plain(),
      'source-document': plain(),
      custom: plain(),
      'tool-output-error': plain(),
      'tool-output-denied': plain(),
      'tool-approval-request': plain(),
      'tool-approval-response': plain(),
    },
  });
  // CAST: the rows encode and decode identically for every instantiation of
  // the UIMessage generics, which refine `messageMetadata`, data parts and
  // tool parts at the type level only, so one codec value serves them all.
  return codec as Codec<VercelEvent<TMetadata, TDataParts, TTools>>;
};

/** The Vercel codec at the SDK's default `UIMessage` types, with one decoder table shared by every transport that uses it. */
export const vercel: Codec<VercelEvent> = createVercelCodec();
