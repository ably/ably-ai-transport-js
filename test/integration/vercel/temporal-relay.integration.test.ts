/**
 * The relay adaptor for Temporal's AI SDK plugin over a real Ably channel.
 *
 * The relay's events are written as the relay would hand them over: the
 * workflow's own chunks as objects, and the model's stream parts as the
 * plugin publishes them, JSON encoded to bytes. The platform is what makes
 * this worth running: a reply's text, cut by a checkpoint, is appended to one
 * message across two activity attempts.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import type { RelayJsonValue } from '../../../src/index.js';
import { vercelDecoder, type VercelEvent, vercelTemporalRelayAdaptor } from '../../../src/vercel/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients, pubsubClient } from '../../helper/pubsub-client.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';
import { createDeliveryRecorder } from '../helpers.js';

const encoder = new TextEncoder();

/** A turn's Workflow Stream: the workflow's chunks as objects, and one model call's parts as bytes. */
const published: (VercelEvent | Uint8Array)[] = [
  { type: 'start', messageId: 'msg_1' },
  ...[
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'r1', modelId: 'm' },
    { type: 'text-start', id: 'txt_1' },
    { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C' },
    { type: 'text-delta', id: 'txt_1', delta: ' in London.' },
    { type: 'text-end', id: 'txt_1' },
    {
      type: 'finish',
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
    },
  ].map((part) => encoder.encode(JSON.stringify(part))),
  { type: 'finish', finishReason: 'stop' },
];

/** The chunks `toUIMessageStream` gives for the same turn. */
const reply: VercelEvent[] = [
  { type: 'start', messageId: 'msg_1' },
  { type: 'start-step' },
  { type: 'text-start', id: 'txt_1' },
  { type: 'text-delta', id: 'txt_1', delta: 'It is 21°C' },
  { type: 'text-delta', id: 'txt_1', delta: ' in London.' },
  { type: 'text-end', id: 'txt_1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

const isChunk = (e: VercelEvent): e is AI.UIMessageChunk => e.type !== 'user-message';

const isFinish = (deliveries: { event?: VercelEvent }[]): boolean => deliveries.some((d) => d.event?.type === 'finish');

describe("Vercel relay adaptor for Temporal's AI SDK plugin over Ably", () => {
  afterEach(() => {
    closeAllClients();
  });

  it('relays a turn of model parts and workflow chunks across a checkpoint that cuts its text, on one message', async () => {
    const name = uniqueChannelName('vercel');
    const clientChannel = pubsubClient().channels.get(name);
    const decoder = vercelDecoder();
    const recorder = createDeliveryRecorder<VercelEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    // Each relay activity attempt gets its own adaptor from the factory; the
    // first checkpoints after the text's first delta, and the relay stores
    // the handoff in workflow history as JSON.
    const factory = vercelTemporalRelayAdaptor();
    const agentChannel = pubsubClient().channels.get(name);
    // eslint-disable-next-line unicorn/no-null -- the relay passes null when a route starts
    const first = factory(agentChannel, null);
    for (const [offset, data] of published.slice(0, 5).entries()) first.write({ topic: 'turn', offset, data });
    const checkpoint = await first.flush();
    // eslint-disable-next-line unicorn/prefer-structured-clone -- workflow history stores JSON, which structuredClone does not model
    const stored: unknown = JSON.parse(JSON.stringify(checkpoint.handoff));
    // CAST: what the relay reads back from history is the JSON it stored.
    const second = factory(agentChannel, stored as RelayJsonValue);
    for (const [offset, data] of published.slice(5).entries())
      second.write({ topic: 'turn', offset: 5 + offset, data });
    await second.close();
    await recorder.waitFor(isFinish);

    expect(recorder.events()).toStrictEqual(reply);
    const deltas = recorder.deliveries.filter((d) => d.event?.type === 'text-delta');
    expect(new Set(deltas.map((d) => d.message.serial)).size).toBe(1);
    const message = await foldWithProviderReducer(recorder.events().filter(isChunk));
    expect(message?.parts.find((p): p is AI.TextUIPart => p.type === 'text')?.text).toBe('It is 21°C in London.');
  });
});
