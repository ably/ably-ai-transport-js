/**
 * The Vercel codec over a real Ably channel.
 *
 * An agent pipes the chunk stream `toUIMessageStream` gives it, a client
 * publishes a `user-message`, and a subscriber folds what it decodes with the
 * AI SDK's own reducer. The platform is what makes these worth running: the
 * text and tool-input streams are appends, history returns each stream's
 * deltas as one message with the text joined, and the ephemeral flag on a
 * transient data part is echoed on delivery.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { channelAgent, createTransport, type Transport } from '../../../src/index.js';
import { createVercelCodec, vercel, type VercelEvent } from '../../../src/vercel/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const channelFor = (client: Ably.Realtime, name: string): Ably.RealtimeChannel =>
  client.channels.get(name, { params: { agent: channelAgent(vercel) } });

const transportOn = (name: string): Transport<VercelEvent> =>
  createTransport({ channel: channelFor(ablyRealtimeClient(), name), codec: createVercelCodec() });

/**
 * A transport with the channel it reads, for a subscriber that waits for the attach.
 * @param name - The channel name.
 * @returns The transport and its channel.
 */
const readerOn = (name: string): { transport: Transport<VercelEvent>; channel: Ably.RealtimeChannel } => {
  const channel = channelFor(ablyRealtimeClient(), name);
  return { transport: createTransport({ channel, codec: createVercelCodec() }), channel };
};

/** The stream `toUIMessageStream` gives for a turn that calls a tool, then answers. */
const turn: VercelEvent[] = [
  { type: 'start', messageId: 'msg_1' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'call_1', toolName: 'weather' },
  { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '{"city":' },
  { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '"London"}' },
  { type: 'tool-input-available', toolCallId: 'call_1', toolName: 'weather', input: { city: 'London' } },
  { type: 'tool-output-available', toolCallId: 'call_1', output: { temp: 21 } },
  { type: 'text-start', id: 'txt_1' },
  { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C' },
  { type: 'text-delta', id: 'txt_1', delta: ' in London.' },
  { type: 'text-end', id: 'txt_1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

const isChunk = (e: VercelEvent): e is AI.UIMessageChunk => e.type !== 'user-message';

const isFinish = (deliveries: { event?: VercelEvent }[]): boolean => deliveries.some((d) => d.event?.type === 'finish');

describe('Vercel codec over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a turn chunk for chunk, and the AI SDK’s reducer folds what a subscriber decodes', async () => {
    const name = uniqueChannelName('vercel');
    const agent = transportOn(name);
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<VercelEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    const result = await agent.pipe(streamOf(...turn));
    await recorder.waitFor(isFinish);

    // The finish chunk is the last publish, so its serial is the pipe's.
    expect(result.serial).toBe(recorder.deliveries.at(-1)?.message.serial);
    expect(recorder.events()).toStrictEqual(turn);

    // The raw shape: a chunk's fields travel under extras.headers, which Ably
    // admits only as a flat map of primitives, so a nested one goes as JSON
    // text and is listed under extras.ai.json beside the type. The transport's
    // own fields sit beside them: the closer names the serial of the tool
    // input's message, and the deltas' message carries the stream marker.
    const toolInput = recorder.deliveries.find((d) => d.event?.type === 'tool-input-delta');
    const available = recorder.deliveries.find((d) => d.event?.type === 'tool-input-available');
    expect(available?.message.extras).toEqual({
      ai: { type: 'tool-input-available', json: ['input'], ends: toolInput?.message.serial },
      headers: {
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'weather',
        input: '{"city":"London"}',
      },
    });
    const delta = recorder.deliveries.find((d) => d.event?.type === 'text-delta');
    expect(delta?.message.data).toBe('It is 21°C');
    expect(delta?.message.extras).toEqual({
      ai: { type: 'text-delta', stream: true },
      headers: { type: 'text-delta', id: 'txt_1' },
    });

    const message = await foldWithProviderReducer(recorder.events().filter(isChunk));
    const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('It is 21°C in London.');
    const toolPart = message?.parts.find((p) => p.type === 'tool-weather');
    expect(toolPart).toMatchObject({ state: 'output-available', input: { city: 'London' }, output: { temp: 21 } });
  });

  it('publishes a user message a subscriber decodes whole, under the serial send returns', async () => {
    const name = uniqueChannelName('vercel');
    const client = transportOn(name);
    const { transport: agent, channel: agentChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<VercelEvent>();
    agent.subscribe(recorder.record);
    await agentChannel.whenState('attached');

    const message: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is the weather?' }] };
    const sent = await client.send({ type: 'user-message', message });
    await recorder.waitFor((d) => d.length === 1);

    expect(recorder.events()).toStrictEqual([{ type: 'user-message', message }]);
    expect(recorder.deliveries[0]?.message.serial).toBe(sent.serial);
  });

  it('reads a finished turn from history as the chunks the agent produced, with each stream’s deltas joined', async () => {
    const name = uniqueChannelName('vercel');
    const agent = transportOn(name);
    await agent.pipe(streamOf(...turn));

    const reader = transportOn(name);
    const history = await drainHistory(reader);

    // Every chunk reads back as itself except a stream's deltas, which share
    // one message and come back as one delta carrying the joined text. The
    // AI SDK's reducer folds this sequence as it folds the live one.
    expect(history.map((d) => d.event)).toStrictEqual([
      { type: 'start', messageId: 'msg_1' },
      { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'call_1', toolName: 'weather' },
      { type: 'tool-input-delta', toolCallId: 'call_1', inputTextDelta: '{"city":"London"}' },
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: 'weather', input: { city: 'London' } },
      { type: 'tool-output-available', toolCallId: 'call_1', output: { temp: 21 } },
      { type: 'text-start', id: 'txt_1' },
      { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C in London.' },
      { type: 'text-end', id: 'txt_1' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const message = await foldWithProviderReducer(
      history.map((d) => d.event).filter((e) => e !== undefined && isChunk(e)),
    );
    const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('It is 21°C in London.');
  });

  it('delivers a transient data part live, flagged ephemeral on the wire', async () => {
    const name = uniqueChannelName('vercel');
    const agent = transportOn(name);
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<VercelEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    await agent.pipe(
      streamOf<VercelEvent>(
        { type: 'data-progress', data: { percent: 50 }, transient: true },
        { type: 'data-result', id: 'r1', data: { answer: 42 } },
      ),
    );
    await recorder.waitFor((d) => d.length === 2);
    expect(recorder.events()).toStrictEqual([
      { type: 'data-progress', data: { percent: 50 }, transient: true },
      { type: 'data-result', id: 'r1', data: { answer: 42 } },
    ]);
    expect(recorder.deliveries[0]?.message.extras).toMatchObject({ ephemeral: true });
    expect(recorder.deliveries[1]?.message.extras).not.toHaveProperty('ephemeral');
  });
});
