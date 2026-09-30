import { EventType } from '@ag-ui/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { agui, type AGUIEvent, createAGUICodec } from '../../../src/ag-ui/index.js';
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
const wireOf = (codec: Codec<AGUIEvent>, events: AGUIEvent[]): Record<string, unknown>[] =>
  encodeAll(codec, events).map(({ message, ...ops }) => ({ data: message.data as unknown, ...ops }));

/** A provider event, as an AG-UI adapter attaches it to the event it translated. */
const providerEvent = { type: 'response.output_text.delta', delta: 'It is ' };

/**
 * A run with the provider event attached to every AG-UI event in it.
 * @param events - The run's events.
 * @returns The events, each with a `rawEvent`.
 */
const withRawEvents = (events: AGUIEvent[]): AGUIEvent[] =>
  events.map((e) => (e.type === 'run-input' ? e : { ...e, rawEvent: providerEvent }));

const everyRun = [textRun, toolRun, reasoningRun, chunkRun, wholeEvents];

describe('the AG-UI codec', () => {
  let codec: Codec<AGUIEvent>;

  beforeEach(() => {
    codec = createAGUICodec();
  });

  describe('encode', () => {
    it('appends a text message’s deltas under its id and publishes the rest whole', () => {
      expect(wireOf(codec, textRun)).toEqual([
        { data: decodedOf(textRun)[0] },
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
        name: 'ag-ui',
        data: 'It is ',
        extras: {
          ai: {
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
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm1', metadata: { model: 'm-1' } },
        extras: { ai: { type: 'TEXT_MESSAGE_END' } },
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

    it('empties the messages a run’s start repeats and keeps the rest of its input', () => {
      const [started] = codec.encode(at(textRun, 0));
      expect(started?.message.data).toEqual({
        type: 'RUN_STARTED',
        threadId: 'th1',
        runId: 'r1',
        input: { ...runInput, messages: [] },
      });
      // The agent's own event is left as it was.
      expect(runInput.messages).toHaveLength(3);
      const [bare] = codec.encode(at(toolRun, 0));
      expect(bare?.message.data).toEqual(at(toolRun, 0));
    });

    it('encodes an event with a rawEvent exactly as the same event without one', () => {
      for (const run of everyRun) {
        expect(encodeAll(codec, withRawEvents(run))).toStrictEqual(encodeAll(codec, run));
      }
      // The agent's own events keep their rawEvent.
      expect(withRawEvents(textRun)[2]).toHaveProperty('rawEvent', providerEvent);
    });

    it('publishes every chunk whole, and does not append to it', () => {
      const chunks: AGUIEvent[] = [
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

    it('carries the run input as the body', () => {
      const [sent] = codec.encode({ type: 'run-input', input: runInput });
      expect(sent?.message).toEqual({ name: 'ag-ui', data: runInput, extras: { ai: { type: 'run-input' } } });
    });

    it('throws for an event type with no row', () => {
      // CAST: an event of a type AG-UI does not declare, as a newer release would send.
      const rogue = { type: 'THINKING_START' } as unknown as AGUIEvent;
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
          message: { name: 'ag-ui', data: messagesSnapshot, extras: { ai: { type: 'MESSAGES_SNAPSHOT' } } },
        },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });

    it('throws for a plain publish whose body is not an object', () => {
      const [delivery] = deliveriesOf([
        { message: { name: 'ag-ui', data: 'nope', extras: { ai: { type: 'TOOL_CALL_START' } } } },
      ]);
      if (delivery === undefined) throw new Error('fixture');
      expect(() => codec.decode(delivery)).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to decode TOOL_CALL_START; data is not an object',
      });
    });

    it('round-trips the run input', () => {
      const input: AGUIEvent = { type: 'run-input', input: runInput };
      expect(roundTrip(codec, [input])).toStrictEqual([input]);
    });

    it('throws for run input that is not a run agent input', () => {
      const malformed: unknown[] = [
        'nope',
        { threadId: 'th1', runId: 'r1', tools: [], context: [] },
        { threadId: 'th1', messages: [], tools: [], context: [] },
        { threadId: 'th1', runId: 'r1', messages: [], context: [] },
        { threadId: 'th1', runId: 'r1', messages: [], tools: [] },
      ];
      for (const data of malformed) {
        const [delivery] = deliveriesOf([{ message: { name: 'ag-ui', data, extras: { ai: { type: 'run-input' } } } }]);
        if (delivery === undefined) throw new Error('fixture');
        expect(() => createAGUICodec().decode(delivery)).toThrowErrorInfo({
          code: ErrorCode.InvalidArgument,
          message: 'unable to decode run-input; data is not a run agent input',
        });
      }
    });

    it('does not return an event for a message that is not the codec’s', () => {
      const [delivery] = deliveriesOf([{ message: { name: 'chat', data: 'hello', extras: { headers: {} } } }]);
      if (delivery === undefined) throw new Error('fixture');
      expect(codec.decode(delivery)).toEqual([]);
    });
  });

  it('exports a prebuilt codec carrying the adapter tag', () => {
    expect(agui.adapterTag).toBe('ag-ui-events');
    expect(Object.keys(agui).toSorted()).toEqual(['adapterTag', 'decode', 'encode']);
  });
});
