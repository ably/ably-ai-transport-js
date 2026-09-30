/**
 * The AG-UI codec: one row per AG-UI event type, plus the `run-input` a client
 * publishes.
 *
 * Three event types stream. `TEXT_MESSAGE_CONTENT` appends under
 * `text:{messageId}`, `TOOL_CALL_ARGS` under `tool:{toolCallId}` and
 * `REASONING_MESSAGE_CONTENT` under `reasoning:{messageId}`. Each carries its
 * `delta` as the message `data` and the rest of the event as `fields`; the
 * first delta publishes the message, the rest append to it, and the matching
 * `*_END` is a plain publish that ends the key. The prefixes keep apart the
 * streams one id can name: a text message and a reasoning message may share a
 * `messageId`.
 *
 * Ably's append replaces the stored `extras` with the extras of the last
 * append. So when history returns the message the deltas built, it carries the
 * last delta's fields and the whole text as its `data`: a subscriber that
 * reads history, or that joins late, decodes one delta event carrying all of
 * the text where a live subscriber decoded many, and the earlier deltas'
 * `timestamp`, `rawEvent` and `metadata` are not in it.
 *
 * The `*_CHUNK` events are plain publishes, one message per chunk, and
 * nothing appends to them. A chunk stream has no end event to settle its
 * appends before the messages after it, and Ably can deliver a publish ahead
 * of an append it still holds, so an appended chunk could reach a subscriber
 * after the chunk or `RUN_FINISHED` that followed it. `transformChunks` in
 * `@ag-ui/client` reads chunks in order, and would close or refuse the
 * stream. An agent that wants a stream compacted into one message emits the
 * START, CONTENT and END events instead.
 *
 * Two events repeat the whole conversation, and neither crosses the wire whole.
 * `MESSAGES_SNAPSHOT` publishes nothing: it grows with every run past the
 * Ably message size limit, and a client loads its conversation from the
 * application's store and joins the channel at a run boundary instead. An
 * inbound one decodes to no event, as a foreign message does, because AG-UI's
 * reducer treats a snapshot as the complete message list and would drop the
 * rest. `RUN_STARTED` travels with `input.messages` emptied, for the same
 * reason, and keeps the rest of its input.
 *
 * Every other event is a plain publish that nothing appends to, so it travels
 * whole as the message `data`, an object, with every field it carries. The
 * codec checks no sizes: an event larger than the Ably message size limit
 * fails its publish. No row writes Ably `headers`; a caller that wants the
 * `runId` on every message passes it in the `pipe` headers.
 */

import * as Ably from 'ably';

import type { Codec, DecodedRow, EventRow } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { ErrorCode } from '../../errors.js';
import type { AGUIEvent, AGUIEventType, AGUIRunInput } from './events.js';

/** The value the codec stamps as its `adapterTag`. */
const ADAPTER_TAG = 'ag-ui-events';

type Row<T extends AGUIEventType> = EventRow<AGUIEvent, T>;

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
const event = ({ data, type }: DecodedRow): AGUIEvent => {
  if (!isRecord(data)) {
    throw new Ably.ErrorInfo(`unable to decode ${type}; data is not an object`, ErrorCode.InvalidArgument, 400);
  }
  // CAST: trust boundary of what was received on the wire. data is the event's own fields, and entire record is AGUIEvent
  return { ...data, type } as AGUIEvent;
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
const deltaEvent = ({ data, fields, type }: DecodedRow): AGUIEvent =>
  // CAST: trust boundary of what was received on the wire. delta is string data, and entire record is AGUIEvent
  ({ ...fields, type, delta: asString(data) }) as AGUIEvent;

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
 * Whether `data` has the fields a `RunAgentInput` requires: `threadId` and
 * `runId` as strings, and `messages`, `tools` and `context` as arrays. It
 * does not check the entries inside the arrays.
 * @param data - The delivered `data`.
 * @returns True when the shape is a run's input.
 */
const isRunAgentInput = (data: unknown): data is AGUIRunInput['input'] =>
  isRecord(data) &&
  typeof data.threadId === 'string' &&
  typeof data.runId === 'string' &&
  Array.isArray(data.messages) &&
  Array.isArray(data.tools) &&
  Array.isArray(data.context);

/**
 * Build the AG-UI codec. Each call builds a fresh codec with its own decoder
 * table.
 * @returns The codec.
 */
export const createAGUICodec = (): Codec<AGUIEvent> =>
  defineCodec({
    name: 'ag-ui',
    adapterTag: ADAPTER_TAG,
    typeOf: (e: AGUIEvent): AGUIEventType => e.type,
    events: {
      // The run lifecycle. RUN_STARTED's input repeats the conversation, so
      // it travels with its messages emptied.
      RUN_STARTED: {
        encode: (e) => ({ data: e.input === undefined ? e : { ...e, input: { ...e.input, messages: [] } } }),
        decode: event,
      },
      RUN_FINISHED: plain(),
      RUN_ERROR: plain(),
      STEP_STARTED: plain(),
      STEP_FINISHED: plain(),
      SUBAGENT_STARTED: plain(),
      SUBAGENT_FINISHED: plain(),
      SUBAGENT_ERROR: plain(),

      // Text messages. A delta carries its text as `data` and the rest of the
      // event as `fields`, since an append grows `data` and carries nothing
      // else; the end publishes whole and ends the key.
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

      // Reasoning. REASONING_START and REASONING_END bracket a span that can
      // hold several reasoning messages; each message streams under its id.
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

      // The whole conversation: never published, and nothing on decode.
      MESSAGES_SNAPSHOT: {
        // eslint-disable-next-line unicorn/no-useless-undefined -- a row that publishes nothing returns undefined
        encode: () => undefined,
        // eslint-disable-next-line unicorn/no-useless-undefined -- a row that decodes to nothing returns undefined
        decode: () => undefined,
      },

      CUSTOM: plain(),
      RAW: plain(),

      // The codec's own event, not one of AG-UI's: the input a client
      // publishes to start a run. See `AGUIRunInput` in ./events.ts.
      'run-input': {
        encode: (e) => ({ data: e.input }),
        decode: (m) => {
          const data: unknown = m.data;
          if (!isRunAgentInput(data)) {
            throw new Ably.ErrorInfo(
              'unable to decode run-input; data is not a run agent input',
              ErrorCode.InvalidArgument,
              400,
            );
          }
          return { type: 'run-input', input: data };
        },
      },
    },
  });

/** The AG-UI codec, with one decoder table shared by every transport that uses it. */
export const agui: Codec<AGUIEvent> = createAGUICodec();
