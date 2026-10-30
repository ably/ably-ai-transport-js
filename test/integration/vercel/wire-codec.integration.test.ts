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

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdaptor } from '../../../src/index.js';
import { vercelAdaptor, vercelDecoder, type VercelEvent } from '../../../src/vercel/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const adaptorOn = (name: string): AgentAdaptor<VercelEvent> => vercelAdaptor(ablyRealtimeClient().channels.get(name));

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
  { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C', providerMetadata: { openai: { itemId: 'msg_1' } } },
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

  it('pipes a turn through vercelAdaptor that vercelDecoder decodes and the AI SDK’s reducer folds', async () => {
    const name = uniqueChannelName('vercel');
    const clientChannel = ablyRealtimeClient().channels.get(name);
    const decoder = vercelDecoder();
    const recorder = createDeliveryRecorder<VercelEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    await vercelAdaptor(ablyRealtimeClient().channels.get(name)).pipe(streamOf(...turn));
    await recorder.waitFor(isFinish);

    expect(recorder.events()).toStrictEqual(turn);
    const message = await foldWithProviderReducer(recorder.events().filter(isChunk));
    const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('It is 21°C in London.');
  });

  it('streams a turn chunk for chunk, and the AI SDK’s reducer folds what a subscriber decodes', async () => {
    const name = uniqueChannelName('vercel');
    const agent = adaptorOn(name);
    const clientChannel = ablyRealtimeClient().channels.get(name);
    const clientDecoder = vercelDecoder();
    const recorder = createDeliveryRecorder<VercelEvent>();
    clientDecoder.onEvent(recorder.record);
    await clientChannel.subscribe(clientDecoder.receive);

    const result = await agent.pipe(streamOf(...turn));
    await recorder.waitFor(isFinish);

    // The finish chunk is the last publish, so its serial is the pipe's.
    expect(result.serial).toBe(recorder.deliveries.at(-1)?.message.serial);
    expect(recorder.events()).toStrictEqual(turn);

    // The raw shape: a plain publish carries the whole chunk as the message
    // body, nested fields included, with only the type under extras.ai. A
    // delta carries its text as the body and the rest of the chunk under
    // extras.ai.fields, since an append grows the body and carries nothing
    // else; a nested value such as the provider metadata travels as an
    // object, and nothing goes under extras.headers. The adaptor's own
    // fields sit beside the type: the closer names the serial of the tool
    // input's message, and the deltas' message carries the stream marker.
    const toolInput = recorder.deliveries.find((d) => d.event?.type === 'tool-input-delta');
    const available = recorder.deliveries.find((d) => d.event?.type === 'tool-input-available');
    expect(available?.message.data).toEqual(turn[5]);
    expect(available?.message.extras).toEqual({
      ai: { codec: 'vercel-ai-sdk-ui-message', type: 'tool-input-available', ends: toolInput?.message.serial },
    });
    const delta = recorder.deliveries.find((d) => d.event?.type === 'text-delta');
    expect(delta?.message.data).toBe('It is 21°C');
    expect(delta?.message.extras).toEqual({
      ai: {
        codec: 'vercel-ai-sdk-ui-message',
        type: 'text-delta',
        stream: true,
        fields: { type: 'text-delta', id: 'txt_1', providerMetadata: { openai: { itemId: 'msg_1' } } },
      },
    });

    const message = await foldWithProviderReducer(recorder.events().filter(isChunk));
    const textPart = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
    expect(textPart?.text).toBe('It is 21°C in London.');
    const toolPart = message?.parts.find((p) => p.type === 'tool-weather');
    expect(toolPart).toMatchObject({ state: 'output-available', input: { city: 'London' }, output: { temp: 21 } });
  });

  it('publishes a user message a subscriber decodes whole, under the serial send returns', async () => {
    const name = uniqueChannelName('vercel');
    const client = adaptorOn(name);
    const agentChannel = ablyRealtimeClient().channels.get(name);
    const agentDecoder = vercelDecoder();
    const recorder = createDeliveryRecorder<VercelEvent>();
    agentDecoder.onEvent(recorder.record);
    await agentChannel.subscribe(agentDecoder.receive);

    const message: AI.UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is the weather?' }] };
    const sent = await client.send({ type: 'user-message', message });
    await recorder.waitFor((d) => d.length === 1);

    expect(recorder.events()).toStrictEqual([{ type: 'user-message', message }]);
    expect(recorder.deliveries[0]?.message.serial).toBe(sent.serial);
  });

  it('reads a finished turn from history as the chunks the agent produced, with each stream’s deltas joined', async () => {
    const name = uniqueChannelName('vercel');
    const agent = adaptorOn(name);
    await agent.pipe(streamOf(...turn));

    const history = await drainHistory(ablyRealtimeClient().channels.get(name), vercelDecoder());

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
    const agent = adaptorOn(name);
    const clientChannel = ablyRealtimeClient().channels.get(name);
    const clientDecoder = vercelDecoder();
    const recorder = createDeliveryRecorder<VercelEvent>();
    clientDecoder.onEvent(recorder.record);
    await clientChannel.subscribe(clientDecoder.receive);

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
