/**
 * The OpenAI Responses codec over a real Ably channel.
 *
 * An agent pipes the two responses of a tool-calling turn, a client publishes
 * the function call's output as input, and a subscriber decodes every event in
 * order. The platform is what makes these worth running: the argument and text
 * streams are appends, and history returns each stream's deltas as one message
 * with the text joined.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';

import { channelAgent, createTransport, type Transport } from '../../../src/index.js';
import { createOpenAICodec, openai, type OpenAIEvent } from '../../../src/openai/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { decodedOf, textResponse, toolCallResponse } from '../../openai/codec/fixtures.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const channelFor = (client: Ably.Realtime, name: string): Ably.RealtimeChannel =>
  client.channels.get(name, { params: { agent: channelAgent(openai) } });

const transportOn = (name: string): Transport<OpenAIEvent> =>
  createTransport({ channel: channelFor(ablyRealtimeClient(), name), codec: createOpenAICodec() });

/**
 * A transport with the channel it reads, for a subscriber that waits for the attach.
 * @param name - The channel name.
 * @returns The transport and its channel.
 */
const readerOn = (name: string): { transport: Transport<OpenAIEvent>; channel: Ably.RealtimeChannel } => {
  const channel = channelFor(ablyRealtimeClient(), name);
  return { transport: createTransport({ channel, codec: createOpenAICodec() }), channel };
};

const completions = (deliveries: { event?: OpenAIEvent }[]): number =>
  deliveries.filter((d) => d.event?.type === 'response.completed').length;

describe('OpenAI codec over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a tool call, its output as input, and the answer, event for event', async () => {
    const name = uniqueChannelName('openai');
    const agent = transportOn(name);
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<OpenAIEvent>();
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    const first = await agent.pipe(streamOf(...toolCallResponse));
    await recorder.waitFor((d) => completions(d) === 1);

    const items: Responses.ResponseInputItem[] = [
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
    ];
    const sent = await client.send({ type: 'input', items });
    const second = await agent.pipe(streamOf(...textResponse));
    await recorder.waitFor((d) => completions(d) === 2);

    // Each Response's completion is its last publish, so its serial is the pipe's.
    const completed = recorder.deliveries.filter((d) => d.event?.type === 'response.completed');
    expect([first.serial, second.serial]).toEqual(completed.map((d) => d.message.serial));
    expect(recorder.events()).toStrictEqual([
      ...decodedOf(toolCallResponse),
      { type: 'input', items },
      ...decodedOf(textResponse),
    ]);
    const inputDelivery = recorder.deliveries.find((d) => d.event?.type === 'input');
    expect(inputDelivery?.message.serial).toBe(sent.serial);

    // The raw shape: an event's fields travel under extras.headers with no
    // sequence number. Ably admits only a flat map of primitives there, so an
    // array goes as JSON text and is listed under extras.ai.json beside the
    // type, and the transport's stream marker beside both on the deltas'
    // message.
    const delta = recorder.deliveries.find((d) => d.event?.type === 'response.output_text.delta');
    expect(delta?.message.data).toBe('It is 21°C');
    expect(delta?.message.extras).toEqual({
      ai: { type: 'response.output_text.delta', json: ['logprobs'], stream: true },
      headers: {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        logprobs: '[]',
      },
    });
  });

  it('reads a finished response from history as the events the agent produced, with the text deltas joined', async () => {
    const name = uniqueChannelName('openai');
    await transportOn(name).pipe(streamOf(...textResponse));

    // Every event reads back as itself except the text deltas, which share
    // one message and come back as one delta carrying the joined text.
    const history = await drainHistory(transportOn(name));
    const expected = decodedOf(textResponse);
    expect(history.map((d) => d.event)).toStrictEqual([
      expected[0],
      expected[1],
      { ...expected[2], delta: 'It is 21°C in London.' },
      ...expected.slice(4),
    ]);
    expect(history[2]?.message.data).toBe('It is 21°C in London.');
  });
});
