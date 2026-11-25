import type * as Ably from '@ably/pubsub-core';
import type * as AGUI from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { agui, createAGUICodec } from '../../../src/ag-ui/codec/index.js';
import { agUiDecoder } from '../../../src/ag-ui/index.js';
import type { Codec } from '../../../src/core/codec/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { foldWithAGUIReducer } from '../../helper/ag-ui-fold.js';
import { deliveriesOf, encodeAll, historyOf, roundTrip } from '../../helper/wire.js';
import {
  at,
  chunkRun,
  decodedOf,
  history,
  messagesSnapshot,
  prompt,
  reasoningRun,
  runInput,
  textRun,
  toolRun,
  wholeEvents,
} from './fixtures.js';

/**
 * The body and routing of each encoded message, without the rest of the message.
 * @param codec - The codec.
 * @param events - The events.
 * @returns One entry per encoded message.
 */
const wireOf = (codec: Codec<AGUI.Event>, events: AGUI.Event[]): Record<string, unknown>[] =>
  encodeAll(codec, events).map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }));

/** A provider event, as an AG-UI adapter attaches it to the event it translated. */
const providerEvent = { type: 'response.output_text.delta', delta: 'It is ' };

/**
 * A run with the provider event attached to every AG-UI event in it.
 * @param events - The run's events.
 * @returns The events, each with a `rawEvent`.
 */
const withRawEvents = (events: AGUI.Event[]): AGUI.Event[] => events.map((e) => ({ ...e, rawEvent: providerEvent }));

const everyRun = [textRun, toolRun, reasoningRun, chunkRun, wholeEvents];

/**
 * A run's start whose input carries only the prompt that started the run, and
 * one whose input repeats the whole conversation.
 */
const runStarts: AGUI.Event[] = [
  at(textRun, 0),
  { type: EventType.RUN_STARTED, threadId: 'th1', runId: 'r1', input: { ...runInput, messages: [...history, prompt] } },
];

describe('the AG-UI codec', () => {
  let codec: Codec<AGUI.Event>;

  beforeEach(() => {
    codec = createAGUICodec();
  });

  describe('encode', () => {
    it('appends a text message’s deltas under its id and publishes the rest whole', () => {
      expect(wireOf(codec, textRun)).toEqual([
        { data: at(textRun, 0) },
        { data: at(textRun, 1) },
        { data: 'It is ', append: 'text:m1' },
        { data: '21°C in ', append: 'text:m1' },
        { data: 'London.', append: 'text:m1' },
        { data: at(textRun, 5), ends: 'text:m1' },
        { data: at(textRun, 6) },
      ]);
    });

    it('carries a delta’s text as the body and the rest of the event under extras.ai.fields', () => {
      const [delta] = codec.encode(at(textRun, 2));
      expect(delta?.message).toEqual({
        name: 'ai',
        data: 'It is ',
        extras: {
          ai: {
            codec: 'ag-ui-events',
            type: 'TEXT_MESSAGE_CONTENT',
            fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', timestamp: 1 },
          },
        },
      });
    });

    it('publishes an end whole, metadata included, and ends its key', () => {
      const [end] = codec.encode(at(textRun, 5));
      expect(end?.ends).toBe('text:m1');
      expect(end?.message).toEqual({
        name: 'ai',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm1', metadata: { model: 'm-1' } },
        extras: { ai: { codec: 'ag-ui-events', type: 'TEXT_MESSAGE_END' } },
      });
    });

    it('appends a tool call’s arguments under its call id', () => {
      expect(wireOf(codec, toolRun)).toEqual([
        { data: at(toolRun, 0) },
        { data: at(toolRun, 1) },
        { data: '{"city":', append: 'tool:t1' },
        { data: '"London"}', append: 'tool:t1' },
        { data: at(toolRun, 4), ends: 'tool:t1' },
        { data: at(toolRun, 5) },
        { data: at(toolRun, 6) },
      ]);
    });

    it('keeps a reasoning stream and a text stream under one id apart', () => {
      const keys = encodeAll(codec, reasoningRun).map((m) => m.append ?? m.ends);
      expect(keys).toEqual([
        undefined,
        undefined,
        undefined,
        'reasoning:m3',
        undefined,
        'text:m3',
        'reasoning:m3',
        'text:m3',
        'reasoning:m3',
        undefined,
        'text:m3',
        undefined,
      ]);
    });

    it('does not publish a messages snapshot', () => {
      expect(codec.encode(messagesSnapshot)).toEqual([]);
    });

    it('publishes a run’s start whole, with the messages on its input', () => {
      for (const started of runStarts) {
        const [encoded] = codec.encode(started);
        expect(encoded?.message).toEqual({
          name: 'ai',
          data: started,
          extras: { ai: { codec: 'ag-ui-events', type: 'RUN_STARTED' } },
        });
      }
    });

    it('encodes an event with a rawEvent exactly as the same event without one', () => {
      for (const run of everyRun) {
        expect(encodeAll(codec, withRawEvents(run))).toStrictEqual(encodeAll(codec, run));
      }
      // The agent's own events keep their rawEvent.
      expect(withRawEvents(textRun)[2]).toHaveProperty('rawEvent', providerEvent);
    });

    it('publishes every chunk whole, and does not append to it', () => {
      const chunks: AGUI.Event[] = [
        ...chunkRun,
        { type: EventType.TEXT_MESSAGE_CHUNK, delta: 'no id' },
        { type: EventType.TOOL_CALL_CHUNK, delta: 'no id' },
        { type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'm7', delta: 'hmm' },
      ];
      expect(wireOf(codec, chunks)).toEqual(chunks.map((e) => ({ data: e })));
    });

    it('publishes every other event whole, and does not append to it', () => {
      expect(wireOf(codec, wholeEvents)).toEqual(wholeEvents.map((e) => ({ data: e })));
    });

    it('throws for an event type with no row', () => {
      // CAST: an event of a type AG-UI does not declare, as a newer release would send.
      const rogue = { type: 'THINKING_START' } as unknown as AGUI.Event;
      expect(() => codec.encode(rogue)).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('decode', () => {
    it('round-trips every run event for event, with the snapshot left out', () => {
      // A fresh codec per run: the simulated wire reuses its serials, which a
      // decoder table that has seen them would drop as replays.
      for (const run of [textRun, toolRun, reasoningRun, chunkRun, [...wholeEvents, messagesSnapshot]]) {
        expect(roundTrip(createAGUICodec(), run)).toStrictEqual(decodedOf(run));
      }
    });

    it('round-trips a run’s start with the messages on its input', () => {
      for (const started of runStarts) {
        expect(roundTrip(createAGUICodec(), [started])).toStrictEqual([started]);
      }
    });

    it('round-trips every run event without its rawEvent', () => {
      for (const run of everyRun) {
        expect(roundTrip(createAGUICodec(), withRawEvents(run))).toStrictEqual(decodedOf(run));
      }
    });

    it('decodes history as the sequence the agent produced, with the text deltas joined', () => {
      const decoded = historyOf(encodeAll(codec, textRun)).flatMap((m) => codec.decode(m));
      // The message the deltas share keeps the last append's fields, so the
      // joined delta reads back with the last delta's timestamp.
      expect(decoded).toStrictEqual([
        ...decodedOf(textRun).slice(0, 2),
        { ...at(textRun, 4), delta: 'It is 21°C in London.' },
        ...textRun.slice(5),
      ]);
    });

    it('decodes a chunk stream from history one chunk per message, as the agent produced it', () => {
      const decoded = historyOf(encodeAll(codec, chunkRun)).flatMap((m) => codec.decode(m));
      expect(decoded).toStrictEqual(chunkRun);
    });

    it('decodes a reasoning stream and a text stream under one id from history as two joined deltas', () => {
      const decoded = historyOf(encodeAll(codec, reasoningRun)).flatMap((m) => codec.decode(m));
      expect(decoded.filter((e) => e.type.endsWith('_CONTENT'))).toStrictEqual([
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm3', delta: 'The user wants weather.' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm3', delta: 'Let me check.' },
      ]);
    });

    it('merges live deliveries and history with AG-UI’s reducer into the same messages', async () => {
      // Not the reasoning run: AG-UI's reducer keys its messages by id, so a
      // reasoning message and a text message that share one merge into one.
      for (const run of [textRun, toolRun, chunkRun]) {
        const live = await foldWithAGUIReducer(roundTrip(createAGUICodec(), run), history);
        const reader = createAGUICodec();
        const stored = historyOf(encodeAll(createAGUICodec(), run)).flatMap((m) => reader.decode(m));
        expect(await foldWithAGUIReducer(stored, history)).toStrictEqual(live);
        expect(live.length).toBeGreaterThan(history.length);
      }
    });

    it('decodes a late joiner’s full-content update to one delta carrying the text so far', () => {
      const deliveries = deliveriesOf(encodeAll(codec, textRun.slice(0, 4)));
      const first = deliveries[2];
      const second = deliveries[3];
      if (first === undefined || second === undefined) throw new Error('fixture');
      // The first delta opened the message the second appends to; the update
      // the joiner receives is on that message.
      expect(second.serial).toBe(first.serial);
      const update = { ...second, action: 'message.update', data: 'It is 21°C in ' };
      // CAST: a fixture inbound message.
      expect(codec.decode(update as typeof second)).toEqual([{ ...at(textRun, 3), delta: 'It is 21°C in ' }]);
    });

    it('does not return an event for a messages snapshot another publisher sent', () => {
      const [delivery] = deliveriesOf([
        {
          message: {
            name: 'ai',
            data: messagesSnapshot,
            extras: { ai: { codec: 'ag-ui-events', type: 'MESSAGES_SNAPSHOT' } },
          },
        },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });

    it('throws for a plain publish whose body is not an object', () => {
      const [delivery] = deliveriesOf([
        { message: { name: 'ai', data: 'nope', extras: { ai: { codec: 'ag-ui-events', type: 'TOOL_CALL_START' } } } },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode TOOL_CALL_START; data is not an object',
      });
    });

    it('delivers a run-input message with no event, and reports it on onError', () => {
      // AG-UI defines no run-input event, so the codec has no row for one, and
      // a run-input message on the channel decodes to nothing.
      const decoder = agUiDecoder();
      const errors: Ably.ErrorInfo[] = [];
      decoder.onError((error) => {
        errors.push(error);
      });
      const [message] = deliveriesOf([
        { message: { name: 'ai', data: runInput, extras: { ai: { codec: 'ag-ui-events', type: 'run-input' } } } },
      ]);
      if (message === undefined) throw new Error('fixture');

      expect(decoder.decode(message)).toStrictEqual([{ event: undefined, message }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfo({
        code: ErrorCode.SessionMessageProcessingFailed,
        cause: { code: ErrorCode.InvalidArgument, message: "unable to decode message; no row for type 'run-input'" },
      });
    });

    it('does not return an event for a message that is not the codec’s', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'chat', data: 'hello', extras: { headers: {} } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });
  });

  it('builds a codec carrying its id and name and nothing else beside encode and decode', () => {
    expect(agui.id).toBe('ag-ui-events');
    expect(Object.keys(agui).toSorted()).toEqual(['decode', 'encode', 'id', 'name']);
  });
});
