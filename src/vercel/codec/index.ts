/**
 * The Vercel AI SDK codec: one row per `UIMessageChunk` type, plus the
 * `user-message` a client publishes to start a turn.
 *
 * Three chunk families stream, and in each the deltas alone share a message.
 * A `text-*` or `reasoning-*` start chunk is a plain publish; each delta
 * appends its text as the message `data` under the stream id, and the first
 * delta is the publish that opens that message; the end chunk is a plain
 * publish that ends the key. Ably's append replaces the stored `extras`, so
 * the message the deltas share reads back from history under the delta type
 * with the joined text as its `data`, and the start and end chunks keep their
 * own messages: history and a late joiner decode the same chunk sequence the
 * agent produced, with the deltas joined. `tool-input-*` streams the same way
 * keyed by the tool call id; its closer, `tool-input-available`, is the same
 * plain publish, and the SDK emits it straight from a `tool-call` when a
 * provider does not stream tool input, so it ends the key when there is one.
 *
 * Every other chunk travels whole as a plain publish, its fields as the row's
 * headers, with two exceptions where the content is the message `data`: a
 * `tool-output-available` carries its `output` there, and a `data-*` part its
 * `data`. A transient data part is published ephemeral, so it reaches
 * subscribers and stays out of history.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { Codec, DecodedRow, EncodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { VercelEvent } from './events.js';

/** The value every codec built here stamps as its `adapterTag`. */
const ADAPTER_TAG = 'vercel-ai-sdk-ui-message';

type Row<T extends VercelEvent['type']> = EventRow<VercelEvent, T>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rebuild a chunk from the headers a plain publish carried and the type the
 * builder matched. The spread headers carry a `type` of their own, since
 * encode spreads the whole chunk; the builder's is the one that picked the row,
 * so it is the one used.
 * @param body - The row body.
 * @param body.headers - The chunk's fields.
 * @param body.type - The type the builder matched.
 * @returns The chunk.
 */
const chunk = ({ headers, type }: DecodedRow): VercelEvent =>
  // CAST: wire trust boundary. The headers were written by this codec's encode
  // from the chunk itself, and the builder has already matched `type` to a row.
  ({ ...headers, type }) as VercelEvent;

/**
 * A decode that restores one text field from `data`.
 * @param field - The chunk field the text travelled as `data` for.
 * @returns The decode.
 */
const withText =
  (field: string) =>
  ({ data, headers, type }: DecodedRow): VercelEvent =>
    // CAST: as `chunk`, with one field restored from `data`.
    ({ ...headers, type, [field]: asString(data) }) as VercelEvent;

/**
 * A decode that restores one payload field from `data`.
 * @param field - The chunk field the payload travelled as `data` for.
 * @returns The decode.
 */
const withValue =
  (field: string) =>
  ({ data, headers, type }: DecodedRow): VercelEvent =>
    // CAST: as `chunk`; the payload is the application's own and stays unconstrained.
    ({ ...headers, type, [field]: data }) as VercelEvent;

/**
 * The row of a chunk that travels whole in its headers.
 * @returns The row.
 */
const plain = <T extends VercelEvent['type']>(): Row<T> => ({
  encode: (e) => ({ headers: { ...e } }),
  decode: chunk,
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
      // `data` under the key (the first one opening the message), and the end
      // is a plain publish that ends the key.
      'text-start': plain(),
      'text-delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, headers: rest, append: rest.id }),
        decode: withText('delta'),
      },
      'text-end': { encode: (e) => ({ headers: { ...e }, ends: e.id }), decode: chunk },
      'reasoning-start': plain(),
      'reasoning-delta': {
        encode: ({ delta, ...rest }) => ({ data: delta, headers: rest, append: rest.id }),
        decode: withText('delta'),
      },
      'reasoning-end': { encode: (e) => ({ headers: { ...e }, ends: e.id }), decode: chunk },
      'tool-input-start': plain(),
      'tool-input-delta': {
        encode: ({ inputTextDelta, ...rest }) => ({ data: inputTextDelta, headers: rest, append: rest.toolCallId }),
        decode: withText('inputTextDelta'),
      },
      'tool-input-available': {
        // The SDK emits this with no start when a provider does not stream
        // tool input; it ends the key when one is live.
        encode: (e) => ({ headers: { ...e }, ends: e.toolCallId }),
        decode: chunk,
      },
      'tool-input-error': {
        encode: (e) => ({ headers: { ...e }, ends: e.toolCallId }),
        decode: chunk,
      },

      // Content as the message data.
      'tool-output-available': {
        encode: ({ output, ...rest }) => ({ data: output, headers: rest }),
        decode: withValue('output'),
      },
      'data-*': {
        encode: ({ data, ...rest }) => {
          const row: EncodedRow = { data, headers: rest };
          return rest.transient === true ? { ...row, ephemeral: true } : row;
        },
        decode: withValue('data'),
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
