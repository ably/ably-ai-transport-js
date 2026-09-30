/**
 * The AG-UI codec over a real Ably channel.
 *
 * A client publishes a run's input, an agent pipes the run, and a subscriber
 * decodes every event in order and folds them with AG-UI's own reducer. The
 * platform is what makes these worth running: the argument and text streams
 * are appends, and history returns each stream's deltas as one message with
 * the text joined, which the reducer must still accept.
 */

import { EventType } from '@ag-ui/core';
import type * as Ably from 'ably';
import { afterEach, describe, expect, it } from 'vitest';

import { agui, type AGUIEvent, type AGUIRunInput, createAGUICodec } from '../../../src/ag-ui/index.js';
import { channelAgent, createTransport, type Transport } from '../../../src/index.js';
import {
  chunkRun,
  decodedOf,
  history,
  messagesSnapshot,
  reasoningRun,
  runInput,
  textRun,
  toolRun,
} from '../../ag-ui/codec/fixtures.js';
import { foldWithAGUIReducer } from '../../helper/ag-ui-fold.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const channelFor = (client: Ably.Realtime, name: string): Ably.RealtimeChannel =>
  client.channels.get(name, { params: { agent: channelAgent(agui) } });

const transportOn = (name: string): Transport<AGUIEvent> =>
  createTransport({ channel: channelFor(ablyRealtimeClient(), name), codec: createAGUICodec() });

/**
 * A transport with the channel it reads, for a subscriber that waits for the attach.
 * @param name - The channel name.
 * @returns The transport and its channel.
 */
const readerOn = (name: string): { transport: Transport<AGUIEvent>; channel: Ably.RealtimeChannel } => {
  const channel = channelFor(ablyRealtimeClient(), name);
  return { transport: createTransport({ channel, codec: createAGUICodec() }), channel };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The Ably fields of one message a test asserts, with its serials labelled. */
interface WireMessage {
  action: string | undefined;
  serial: string | undefined;
  name: string | undefined;
  data: unknown;
  extras: unknown;
}

/**
 * The Ably messages a subscriber received, as the fields a test asserts. Each
 * serial is replaced by a label in the order it first appears (`s1`, `s2`, …),
 * the serial under `extras.ai.ends` included, so the assertion states which
 * messages share a serial and which serial an end names, without the values
 * the platform allocates.
 * @param messages - The messages, in the order they were received or stored.
 * @returns The labelled fields.
 */
const wireOf = (messages: Ably.InboundMessage[]): WireMessage[] => {
  const labels = new Map<string, string>();
  const label = (serial: string): string => {
    const known = labels.get(serial);
    if (known !== undefined) return known;
    const next = `s${String(labels.size + 1)}`;
    labels.set(serial, next);
    return next;
  };
  return messages.map((m) => {
    const extras: unknown = m.extras;
    const serial = m.serial === undefined ? undefined : label(m.serial);
    const labelled =
      isRecord(extras) && isRecord(extras.ai) && typeof extras.ai.ends === 'string'
        ? { ...extras, ai: { ...extras.ai, ends: label(extras.ai.ends) } }
        : extras;
    return { action: m.action, serial, name: m.name, data: m.data as unknown, extras: labelled };
  });
};

const finished = (deliveries: { event?: AGUIEvent }[]): number =>
  deliveries.filter((d) => d.event?.type === EventType.RUN_FINISHED).length;

describe('AG-UI codec over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a run’s input and a tool-calling run, event for event, and folds them with AG-UI’s reducer', async () => {
    const name = uniqueChannelName('ag-ui');
    const agent = transportOn(name);
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<AGUIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    const input: AGUIRunInput = { type: 'run-input', input: { ...runInput, runId: 'r2', messages: [] } };
    const sent = await client.send(input);
    const piped = await agent.pipe(streamOf(...toolRun), { headers: { runId: 'r2' } });
    await recorder.waitFor((d) => finished(d) === 1);

    expect(recorder.events()).toStrictEqual([input, ...decodedOf(toolRun)]);
    const [inputDelivery, ...run] = recorder.deliveries;
    expect(inputDelivery?.message.serial).toBe(sent.serial);
    expect(run.at(-1)?.message.serial).toBe(piped.serial);
    // Live, the argument deltas share one message: the first creates it and
    // the second appends its fragment on the same serial. The start, the end
    // and the result are messages of their own, the end naming the serial it
    // ends, and every message the pipe wrote carries the caller's header.
    expect(wireOf(recorder.deliveries.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: {
          threadId: 'th1',
          runId: 'r2',
          messages: [],
          tools: [{ name: 'weather', description: 'The weather in a city' }],
          context: [{ description: 'units', value: 'metric' }],
          state: { step: 0 },
        },
        extras: { ai: { type: 'run-input' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'RUN_STARTED', threadId: 'th1', runId: 'r2' },
        extras: { ai: { type: 'RUN_STARTED' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's3',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'weather', parentMessageId: 'm2' },
        extras: { ai: { type: 'TOOL_CALL_START' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's4',
        name: 'ag-ui',
        data: '{"city":',
        extras: {
          ai: { type: 'TOOL_CALL_ARGS', stream: true, fields: { type: 'TOOL_CALL_ARGS', toolCallId: 't1' } },
          headers: { runId: 'r2' },
        },
      },
      {
        action: 'message.append',
        serial: 's4',
        name: 'ag-ui',
        data: '"London"}',
        extras: {
          ai: { type: 'TOOL_CALL_ARGS', stream: true, fields: { type: 'TOOL_CALL_ARGS', toolCallId: 't1' } },
          headers: { runId: 'r2' },
        },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_END', toolCallId: 't1' },
        extras: { ai: { type: 'TOOL_CALL_END', ends: 's4' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's6',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_RESULT', messageId: 'tm1', toolCallId: 't1', content: '{"temp":21}', role: 'tool' },
        extras: { ai: { type: 'TOOL_CALL_RESULT' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's7',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r2' },
        extras: { ai: { type: 'RUN_FINISHED' }, headers: { runId: 'r2' } },
      },
    ]);

    // History stores the argument message once, with the fragments joined,
    // as the update the appends made of it.
    const stored = await drainHistory(transportOn(name));
    expect(wireOf(stored.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: {
          threadId: 'th1',
          runId: 'r2',
          messages: [],
          tools: [{ name: 'weather', description: 'The weather in a city' }],
          context: [{ description: 'units', value: 'metric' }],
          state: { step: 0 },
        },
        extras: { ai: { type: 'run-input' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'RUN_STARTED', threadId: 'th1', runId: 'r2' },
        extras: { ai: { type: 'RUN_STARTED' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's3',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'weather', parentMessageId: 'm2' },
        extras: { ai: { type: 'TOOL_CALL_START' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.update',
        serial: 's4',
        name: 'ag-ui',
        data: '{"city":"London"}',
        extras: {
          ai: { type: 'TOOL_CALL_ARGS', stream: true, fields: { type: 'TOOL_CALL_ARGS', toolCallId: 't1' } },
          headers: { runId: 'r2' },
        },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_END', toolCallId: 't1' },
        extras: { ai: { type: 'TOOL_CALL_END', ends: 's4' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's6',
        name: 'ag-ui',
        data: { type: 'TOOL_CALL_RESULT', messageId: 'tm1', toolCallId: 't1', content: '{"temp":21}', role: 'tool' },
        extras: { ai: { type: 'TOOL_CALL_RESULT' }, headers: { runId: 'r2' } },
      },
      {
        action: 'message.create',
        serial: 's7',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r2' },
        extras: { ai: { type: 'RUN_FINISHED' }, headers: { runId: 'r2' } },
      },
    ]);

    const messages = await foldWithAGUIReducer(recorder.events(), history);
    expect(messages.slice(history.length)).toStrictEqual([
      {
        id: 'm2',
        role: 'assistant',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'weather', arguments: '{"city":"London"}' } }],
      },
      { id: 'tm1', role: 'tool', toolCallId: 't1', content: '{"temp":21}' },
    ]);
  });

  it('reads a finished run from history with the deltas joined, and folds it to the messages a live subscriber built', async () => {
    const name = uniqueChannelName('ag-ui');
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<AGUIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');
    await transportOn(name).pipe(streamOf(...textRun));
    await recorder.waitFor((d) => finished(d) === 1);

    // Live, the three text deltas share one message: the first creates it
    // and the other two append their fragments on the same serial, each with
    // its own fields. The run's start carries its input with the messages
    // emptied, and the end names the serial it ends.
    expect(wireOf(recorder.deliveries.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: {
          type: 'RUN_STARTED',
          threadId: 'th1',
          runId: 'r1',
          input: {
            threadId: 'th1',
            runId: 'r1',
            messages: [],
            tools: [{ name: 'weather', description: 'The weather in a city' }],
            context: [{ description: 'units', value: 'metric' }],
            state: { step: 0 },
          },
        },
        extras: { ai: { type: 'RUN_STARTED' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        extras: { ai: { type: 'TEXT_MESSAGE_START' } },
      },
      {
        action: 'message.create',
        serial: 's3',
        name: 'ag-ui',
        data: 'It is ',
        extras: {
          ai: {
            type: 'TEXT_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', timestamp: 1 },
          },
        },
      },
      {
        action: 'message.append',
        serial: 's3',
        name: 'ag-ui',
        data: '21°C in ',
        extras: {
          ai: {
            type: 'TEXT_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', timestamp: 2 },
          },
        },
      },
      {
        action: 'message.append',
        serial: 's3',
        name: 'ag-ui',
        data: 'London.',
        extras: {
          ai: {
            type: 'TEXT_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', timestamp: 3 },
          },
        },
      },
      {
        action: 'message.create',
        serial: 's4',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm1', metadata: { model: 'm-1' } },
        extras: { ai: { type: 'TEXT_MESSAGE_END', ends: 's3' } },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r1' },
        extras: { ai: { type: 'RUN_FINISHED' } },
      },
    ]);

    // History stores the text message once, as the update the appends made of
    // it: its data is the three fragments joined, and its extras are the last
    // append's, since an append replaces them. That message decodes to one
    // delta carrying the whole text.
    const stored = await drainHistory(transportOn(name));
    expect(wireOf(stored.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: {
          type: 'RUN_STARTED',
          threadId: 'th1',
          runId: 'r1',
          input: {
            threadId: 'th1',
            runId: 'r1',
            messages: [],
            tools: [{ name: 'weather', description: 'The weather in a city' }],
            context: [{ description: 'units', value: 'metric' }],
            state: { step: 0 },
          },
        },
        extras: { ai: { type: 'RUN_STARTED' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        extras: { ai: { type: 'TEXT_MESSAGE_START' } },
      },
      {
        action: 'message.update',
        serial: 's3',
        name: 'ag-ui',
        data: 'It is 21°C in London.',
        extras: {
          ai: {
            type: 'TEXT_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', timestamp: 3 },
          },
        },
      },
      {
        action: 'message.create',
        serial: 's4',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm1', metadata: { model: 'm-1' } },
        extras: { ai: { type: 'TEXT_MESSAGE_END', ends: 's3' } },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r1' },
        extras: { ai: { type: 'RUN_FINISHED' } },
      },
    ]);
    expect(stored.map((d) => d.event)).toStrictEqual([
      ...decodedOf(textRun).slice(0, 2),
      { ...textRun[4], delta: 'It is 21°C in London.' },
      ...textRun.slice(5),
    ]);

    const live = await foldWithAGUIReducer(recorder.events(), history);
    const fromHistory = await foldWithAGUIReducer(
      stored.flatMap((d) => (d.event === undefined ? [] : [d.event])),
      history,
    );
    expect(fromHistory).toStrictEqual(live);
    // The end event travels whole, so the metadata it carries reaches the message.
    expect(live.at(-1)).toStrictEqual({
      id: 'm1',
      role: 'assistant',
      content: 'It is 21°C in London.',
      metadata: { model: 'm-1' },
    });
  });

  it('streams a reasoning message and a text message under one id as two appended messages, live and from history', async () => {
    const name = uniqueChannelName('ag-ui');
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<AGUIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');
    await transportOn(name).pipe(streamOf(...reasoningRun));
    await recorder.waitFor((d) => finished(d) === 1);

    expect(recorder.events()).toStrictEqual(reasoningRun);

    // Live, the reasoning deltas and the text deltas interleave, and each
    // stream appends to its own message: the prefixes in the stream keys keep
    // one messageId's two streams on two serials.
    expect(wireOf(recorder.deliveries.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: { type: 'RUN_STARTED', threadId: 'th1', runId: 'r3' },
        extras: { ai: { type: 'RUN_STARTED' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'REASONING_START', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_START' } },
      },
      {
        action: 'message.create',
        serial: 's3',
        name: 'ag-ui',
        data: { type: 'REASONING_MESSAGE_START', messageId: 'm3', role: 'reasoning' },
        extras: { ai: { type: 'REASONING_MESSAGE_START' } },
      },
      {
        action: 'message.create',
        serial: 's4',
        name: 'ag-ui',
        data: 'The user ',
        extras: {
          ai: {
            type: 'REASONING_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm3' },
          },
        },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_START', messageId: 'm3' },
        extras: { ai: { type: 'TEXT_MESSAGE_START' } },
      },
      {
        action: 'message.create',
        serial: 's6',
        name: 'ag-ui',
        data: 'Let me ',
        extras: {
          ai: { type: 'TEXT_MESSAGE_CONTENT', stream: true, fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm3' } },
        },
      },
      {
        action: 'message.append',
        serial: 's4',
        name: 'ag-ui',
        data: 'wants weather.',
        extras: {
          ai: {
            type: 'REASONING_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm3' },
          },
        },
      },
      {
        action: 'message.append',
        serial: 's6',
        name: 'ag-ui',
        data: 'check.',
        extras: {
          ai: { type: 'TEXT_MESSAGE_CONTENT', stream: true, fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm3' } },
        },
      },
      {
        action: 'message.create',
        serial: 's7',
        name: 'ag-ui',
        data: { type: 'REASONING_MESSAGE_END', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_MESSAGE_END', ends: 's4' } },
      },
      {
        action: 'message.create',
        serial: 's8',
        name: 'ag-ui',
        data: { type: 'REASONING_END', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_END' } },
      },
      {
        action: 'message.create',
        serial: 's9',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm3' },
        extras: { ai: { type: 'TEXT_MESSAGE_END', ends: 's6' } },
      },
      {
        action: 'message.create',
        serial: 's10',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r3' },
        extras: { ai: { type: 'RUN_FINISHED' } },
      },
    ]);

    // History stores each stream's message once, in the order the stream
    // opened, as the update its appends made of it, with its own fragments
    // joined.
    const stored = await drainHistory(transportOn(name));
    expect(wireOf(stored.map((d) => d.message))).toStrictEqual([
      {
        action: 'message.create',
        serial: 's1',
        name: 'ag-ui',
        data: { type: 'RUN_STARTED', threadId: 'th1', runId: 'r3' },
        extras: { ai: { type: 'RUN_STARTED' } },
      },
      {
        action: 'message.create',
        serial: 's2',
        name: 'ag-ui',
        data: { type: 'REASONING_START', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_START' } },
      },
      {
        action: 'message.create',
        serial: 's3',
        name: 'ag-ui',
        data: { type: 'REASONING_MESSAGE_START', messageId: 'm3', role: 'reasoning' },
        extras: { ai: { type: 'REASONING_MESSAGE_START' } },
      },
      {
        action: 'message.update',
        serial: 's4',
        name: 'ag-ui',
        data: 'The user wants weather.',
        extras: {
          ai: {
            type: 'REASONING_MESSAGE_CONTENT',
            stream: true,
            fields: { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm3' },
          },
        },
      },
      {
        action: 'message.create',
        serial: 's5',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_START', messageId: 'm3' },
        extras: { ai: { type: 'TEXT_MESSAGE_START' } },
      },
      {
        action: 'message.update',
        serial: 's6',
        name: 'ag-ui',
        data: 'Let me check.',
        extras: {
          ai: { type: 'TEXT_MESSAGE_CONTENT', stream: true, fields: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm3' } },
        },
      },
      {
        action: 'message.create',
        serial: 's7',
        name: 'ag-ui',
        data: { type: 'REASONING_MESSAGE_END', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_MESSAGE_END', ends: 's4' } },
      },
      {
        action: 'message.create',
        serial: 's8',
        name: 'ag-ui',
        data: { type: 'REASONING_END', messageId: 'm3' },
        extras: { ai: { type: 'REASONING_END' } },
      },
      {
        action: 'message.create',
        serial: 's9',
        name: 'ag-ui',
        data: { type: 'TEXT_MESSAGE_END', messageId: 'm3' },
        extras: { ai: { type: 'TEXT_MESSAGE_END', ends: 's6' } },
      },
      {
        action: 'message.create',
        serial: 's10',
        name: 'ag-ui',
        data: { type: 'RUN_FINISHED', threadId: 'th1', runId: 'r3' },
        extras: { ai: { type: 'RUN_FINISHED' } },
      },
    ]);
  });

  it('reads a chunk stream from history one message per chunk, and folds it to the messages a live subscriber built', async () => {
    const name = uniqueChannelName('ag-ui');
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<AGUIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');
    await transportOn(name).pipe(streamOf(...chunkRun));
    await recorder.waitFor((d) => finished(d) === 1);

    const stored = await drainHistory(transportOn(name));
    const live = await foldWithAGUIReducer(recorder.events(), history);
    const fromHistory = await foldWithAGUIReducer(
      stored.flatMap((d) => (d.event === undefined ? [] : [d.event])),
      history,
    );
    expect(fromHistory).toStrictEqual(live);
    expect(live.slice(history.length)).toStrictEqual([
      {
        id: 'm4',
        role: 'assistant',
        toolCalls: [{ id: 't2', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
      },
      { id: 'm5', role: 'assistant', content: 'Paris is sunny.' },
    ]);
  });

  it('puts nothing on the channel for a messages snapshot', async () => {
    const name = uniqueChannelName('ag-ui');
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<AGUIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    const run = [...textRun.slice(0, -1), messagesSnapshot, ...textRun.slice(-1)];
    await transportOn(name).pipe(streamOf(...run));
    await recorder.waitFor((d) => finished(d) === 1);

    expect(recorder.deliveries.map((d) => d.event)).toStrictEqual(decodedOf(run));
  });
});
