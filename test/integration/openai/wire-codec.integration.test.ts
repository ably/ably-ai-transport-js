/**
 * The OpenAI Responses codec over a real Ably channel.
 *
 * An agent pipes the two responses of a tool-calling turn, a client publishes
 * the function call's output as input, and a subscriber decodes every event in
 * order. The platform is what makes these worth running: the argument and text
 * streams are appends, and history returns each stream's deltas as one message
 * with the text joined.
 */

import type { Responses } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdaptor } from '../../../src/index.js';
import { openaiAdaptor, openaiDecoder, type OpenAIEvent } from '../../../src/openai/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients, pubsubClient } from '../../helper/pubsub-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { at, decodedOf, textResponse, toolCallResponse } from '../../openai/codec/fixtures.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const adaptorOn = (name: string): AgentAdaptor<OpenAIEvent> => openaiAdaptor(pubsubClient().channels.get(name));

const completions = (deliveries: { event?: OpenAIEvent }[]): number =>
  deliveries.filter((d) => d.event?.type === 'response.completed').length;

describe('OpenAI codec over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('pipes a response through openaiAdaptor that openaiDecoder decodes event for event', async () => {
    const name = uniqueChannelName('openai');
    const clientChannel = pubsubClient().channels.get(name);
    const decoder = openaiDecoder();
    const recorder = createDeliveryRecorder<OpenAIEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    await openaiAdaptor(pubsubClient().channels.get(name)).pipe(streamOf(...textResponse));
    await recorder.waitFor((d) => completions(d) === 1);

    expect(recorder.events()).toStrictEqual(decodedOf(textResponse));
  });

  it('streams a tool call, its output as input, and the answer, event for event', async () => {
    const name = uniqueChannelName('openai');
    const agent = adaptorOn(name);
    const clientChannel = pubsubClient().channels.get(name);
    const clientDecoder = openaiDecoder();
    const recorder = createDeliveryRecorder<OpenAIEvent>();
    clientDecoder.onEvent(recorder.record);
    await clientChannel.subscribe(clientDecoder.receive);

    const first = await agent.pipe(streamOf(...toolCallResponse));
    await recorder.waitFor((d) => completions(d) === 1);

    const items: Responses.ResponseInputItem[] = [
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":21}' },
    ];
    const sent = await openaiAdaptor(clientChannel).send({ type: 'input', items });
    const second = await agent.pipe(streamOf(...textResponse));
    await recorder.waitFor((d) => completions(d) === 2);

    // Each Response's completion is its last publish, so its serial is the pipe's.
    const completed = recorder.deliveries.filter((d) => d.event?.type === 'response.completed');
    expect([first.lastPublishSerial, second.lastPublishSerial]).toEqual(completed.map((d) => d.message.serial));
    expect(recorder.events()).toStrictEqual([
      ...decodedOf(toolCallResponse),
      { type: 'input', items },
      ...decodedOf(textResponse),
    ]);
    const inputDelivery = recorder.deliveries.find((d) => d.event?.type === 'input');
    expect(inputDelivery?.message.serial).toBe(sent.serial);

    // The raw shape: a plain publish carries the whole event as the message
    // body; a delta carries its text as the body and the rest of the event
    // under extras.ai.fields, since an append grows the body and carries
    // nothing else. A nested value travels as it is, so the logprobs array
    // reads back as an array, with the adaptor's stream marker beside the
    // type on the deltas' message and nothing under extras.headers.
    const added = recorder.deliveries.find((d) => d.event?.type === 'response.output_item.added');
    expect(added?.message.data).toEqual(at(toolCallResponse, 1));
    expect(added?.message.extras).toEqual({ ai: { codec: 'openai-responses', type: 'response.output_item.added' } });
    const delta = recorder.deliveries.find((d) => d.event?.type === 'response.output_text.delta');
    expect(delta?.message.data).toBe('It is 21°C');
    expect(delta?.message.extras).toEqual({
      ai: {
        codec: 'openai-responses',
        type: 'response.output_text.delta',
        stream: true,
        fields: {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          logprobs: [],
          sequence_number: 3,
        },
      },
    });
  });

  it('reads a finished response from history as the events the agent produced, with the text deltas joined', async () => {
    const name = uniqueChannelName('openai');
    await adaptorOn(name).pipe(streamOf(...textResponse));

    // Every event reads back as itself except the text deltas, which share
    // one message and come back as one delta carrying the joined text under
    // the last delta's fields, since an append replaces the stored extras.
    const history = await drainHistory(pubsubClient().channels.get(name), openaiDecoder());
    const expected = decodedOf(textResponse);
    expect(history.map((d) => d.event)).toStrictEqual([
      expected[0],
      expected[1],
      { ...expected[3], delta: 'It is 21°C in London.' },
      ...expected.slice(4),
    ]);
    expect(history[2]?.message.data).toBe('It is 21°C in London.');
  });

  it('writes a response event by event through two writers, the second adopting the text the first stopped in', async () => {
    const name = uniqueChannelName('openai');
    const clientChannel = pubsubClient().channels.get(name);
    const decoder = openaiDecoder();
    const recorder = createDeliveryRecorder<OpenAIEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    // The first writer stops after the text's first delta.
    const agent = adaptorOn(name);
    const first = agent.newWriter();
    for (const event of textResponse.slice(0, 4)) first.write(event);
    const { handoff } = await first.close();
    const second = agent.adoptWriter(handoff);
    for (const event of textResponse.slice(4)) second.write(event);
    await second.close();
    await recorder.waitFor((d) => completions(d) === 1);

    const expected = decodedOf(textResponse);
    expect(recorder.events()).toStrictEqual(expected);

    // Both writers' text deltas land on one message, so history holds the
    // text as one delta carrying all of it, and the other events as they were.
    const isDelta = (e: OpenAIEvent | undefined): boolean => e?.type === 'response.output_text.delta';
    const deltas = recorder.deliveries.filter((d) => isDelta(d.event));
    expect(deltas.length).toBeGreaterThan(1);
    expect(new Set(deltas.map((d) => d.message.serial)).size).toBe(1);
    const history = await drainHistory(pubsubClient().channels.get(name), openaiDecoder());
    const stored = history.map((d) => d.event);
    expect(stored.filter((e) => isDelta(e))).toHaveLength(1);
    expect(stored.filter((e) => !isDelta(e))).toStrictEqual(expected.filter((e) => !isDelta(e)));
  });
});
