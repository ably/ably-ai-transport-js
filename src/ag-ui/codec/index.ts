/**
 * The AG-UI codec: one row per AG-UI event type.
 *
 * Three event types stream. `TEXT_MESSAGE_CONTENT` appends under
 * `text:{messageId}`, `TOOL_CALL_ARGS` under `tool:{toolCallId}` and
 * `REASONING_MESSAGE_CONTENT` under `reasoning:{messageId}`. Each carries its
 * `delta` as the message `data` and the rest of the event as `fields`; the
 * first delta publishes the message, the rest append to it, and the matching
 * `*_END` is a plain publish that ends the key. The prefixes keep the streams
 * that share one id apart: a text message and a reasoning message can share a
 * `messageId`.
 *
 * Ably's append replaces the stored `extras` with the extras of the last
 * append. So when history returns the message the deltas built, it carries the
 * last delta's fields and the whole text as its `data`. A subscriber that
 * reads history, or that joins late, decodes one delta event carrying all of
 * the text, without the earlier deltas' `timestamp`, `metadata` and
 * `rawEvent`.
 *
 * The `*_CHUNK` events are plain publishes, one message per chunk, and the
 * codec does not append to them. A chunk stream does not have an end event to
 * settle its appends before the messages after it, and Ably can deliver a
 * publish ahead of an append it still holds, so an appended chunk could reach
 * a subscriber after the chunk or `RUN_FINISHED` that followed it. `transformChunks` in
 * `@ag-ui/client` reads chunks in order, and would close or refuse the
 * stream. An agent that wants a stream compacted into one message can emit
 * the START, CONTENT and END events instead.
 *
 * The codec does not publish `MESSAGES_SNAPSHOT`. It repeats the whole
 * conversation and grows with every run past the Ably message size limit, and
 * a client loads its conversation from the application's store and joins the
 * channel at a run boundary instead. An inbound one does not decode to an
 * event, the same as a foreign message, because AG-UI's reducer treats a
 * snapshot as the complete message list and would drop every message the
 * snapshot leaves out.
 *
 * Every other event is a plain publish that the codec does not append to, so
 * it travels whole as the message `data`, an object, with every field it
 * carries. The codec does not check sizes, so an event larger than the Ably
 * message size limit fails its publish. No row writes Ably `headers`; a caller
 * that wants the `runId` on every message can pass it in the `pipe` headers.
 */

import * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/core';

import type { Codec, DecodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';

/**
 * The type of every AG-UI event, as plain strings. AG-UI declares its types as
 * a string enum, and the template literal widens each member to the string it
 * holds. The row table's keys are those strings.
 */
type AGUIEventType = `${AGUI.Event['type']}`;

/** The codec's id. */
const CODEC_ID = 'ag-ui-events';

type Row<T extends AGUIEventType> = EventRow<AGUI.Event, T>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Rebuild an event from the body a plain publish carried and the type the
 * builder matched. The body carries a `type` of its own, since encode sends
 * the whole event. The decode uses the type the builder matched, since that
 * type picked the row.
 * @param body - The row body.
 * @param body.data - The event, as the message body.
 * @param body.type - The type the builder matched.
 * @returns The event.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when the body is not an object.
 */
const event = ({ data, type }: DecodedRow): AGUI.Event => {
  if (!isRecord(data)) {
    throw new Ably.ErrorInfo(`unable to decode ${type}; data is not an object`, ErrorCode.InvalidArgument, 400);
  }
  // CAST: trust boundary of what was received on the wire. data is the event's own fields, and the entire record is an AG-UI event
  return { ...data, type } as AGUI.Event;
};

/**
 * The decode every delta row shares: the text comes back from `data`, the rest
 * of the event from `fields`. Every streaming event carries its text in `delta`.
 * @param body - The row body.
 * @param body.data - The delta's text, as the appended message body.
 * @param body.fields - The event's other fields, as encode wrote them.
 * @param body.type - The type the builder matched.
 * @returns The event.
 */
const deltaEvent = ({ data, fields, type }: DecodedRow): AGUI.Event =>
  // CAST: trust boundary of what was received on the wire. delta is string data, and the entire record is an AG-UI event
  ({ ...fields, type, delta: asString(data) }) as AGUI.Event;

/**
 * The row of an event that travels whole as the message body.
 * @returns The row.
 */
const plain = <T extends AGUIEventType>(): Row<T> => ({
  encode: (e) => ({ data: e }),
  decode: event,
});

const textKey = (messageId: string): string => `text:${messageId}`;
const toolKey = (toolCallId: string): string => `tool:${toolCallId}`;
const reasoningKey = (messageId: string): string => `reasoning:${messageId}`;

/**
 * Build the AG-UI codec.
 * @returns The codec.
 */
export const createAGUICodec = (): Codec<AGUI.Event> =>
  defineCodec({
    id: CODEC_ID,
    typeOf: (e: AGUI.Event): AGUIEventType => e.type,
    events: {
      // The run lifecycle.
      RUN_STARTED: plain(),
      RUN_FINISHED: plain(),
      RUN_ERROR: plain(),
      STEP_STARTED: plain(),
      STEP_FINISHED: plain(),
      SUBAGENT_STARTED: plain(),
      SUBAGENT_FINISHED: plain(),
      SUBAGENT_ERROR: plain(),

      // Text messages. A delta carries its text as `data` and the rest of the
      // event as `fields`, since an append grows `data` and does not carry
      // anything else; the end event is published whole and ends the key.
      TEXT_MESSAGE_START: plain(),
      TEXT_MESSAGE_CONTENT: {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: textKey(rest.messageId) }),
        decode: deltaEvent,
      },
      TEXT_MESSAGE_END: {
        encode: (e) => ({ data: e, ends: textKey(e.messageId) }),
        decode: event,
      },
      TEXT_MESSAGE_CHUNK: plain(),

      // Tool calls, keyed by the call id.
      TOOL_CALL_START: plain(),
      TOOL_CALL_ARGS: {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: toolKey(rest.toolCallId) }),
        decode: deltaEvent,
      },
      TOOL_CALL_END: {
        encode: (e) => ({ data: e, ends: toolKey(e.toolCallId) }),
        decode: event,
      },
      TOOL_CALL_CHUNK: plain(),
      TOOL_CALL_RESULT: plain(),

      // Reasoning. REASONING_START and REASONING_END open and close a span
      // that can hold several reasoning messages; each message streams under
      // its id.
      REASONING_START: plain(),
      REASONING_MESSAGE_START: plain(),
      REASONING_MESSAGE_CONTENT: {
        encode: ({ delta, ...rest }) => ({ data: delta, fields: rest, append: reasoningKey(rest.messageId) }),
        decode: deltaEvent,
      },
      REASONING_MESSAGE_END: {
        encode: (e) => ({ data: e, ends: reasoningKey(e.messageId) }),
        decode: event,
      },
      REASONING_MESSAGE_CHUNK: plain(),
      REASONING_END: plain(),
      REASONING_ENCRYPTED_VALUE: plain(),

      // State and activity travel whole; each delta is a JSON Patch against a
      // document the client already holds.
      STATE_SNAPSHOT: plain(),
      STATE_DELTA: plain(),
      ACTIVITY_SNAPSHOT: plain(),
      ACTIVITY_DELTA: plain(),

      // The whole conversation: the codec does not publish it, and does not
      // decode it to an event.
      MESSAGES_SNAPSHOT: {
        // eslint-disable-next-line unicorn/no-useless-undefined -- a row that does not publish returns undefined
        encode: () => undefined,
        // eslint-disable-next-line unicorn/no-useless-undefined -- a row that does not decode to an event returns undefined
        decode: () => undefined,
      },

      CUSTOM: plain(),
      RAW: plain(),
    },
  });

/** The AG-UI codec. */
export const agui: Codec<AGUI.Event> = createAGUICodec();
