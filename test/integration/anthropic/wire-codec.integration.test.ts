/**
 * The Anthropic Messages codec over a real Ably channel.
 *
 * An agent pipes a turn that thinks and calls a tool, a client publishes the
 * tool's result as input, and the agent pipes the answer, which searches the
 * web and cites it. A subscriber decodes every event in order and folds each
 * turn with the SDK's own MessageStream. The platform is what makes these
 * worth running: each block's text streams as appends to one message, and
 * history returns it as one message with the text joined.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { anthropicAdaptor, anthropicDecoder, type AnthropicEvent } from '../../../src/anthropic/index.js';
import type { AgentAdaptor } from '../../../src/index.js';
import { searchTurn, toolResult, toolTurn } from '../../anthropic/codec/fixtures.js';
import { foldWithMessageStream } from '../../helper/anthropic-fold.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients, pubsubClient } from '../../helper/pubsub-client.js';
import { streamOf } from '../../helper/test-codec.js';
import { createDeliveryRecorder, drainHistory } from '../helpers.js';

const adaptorOn = (name: string): AgentAdaptor<AnthropicEvent> => anthropicAdaptor(pubsubClient().channels.get(name));

const stops = (deliveries: { event?: AnthropicEvent }[]): number =>
  deliveries.filter((d) => d.event?.type === 'message_stop').length;

/**
 * The events without the signature and citation deltas, which are plain
 * publishes and can reach a subscriber ahead of an append still in flight.
 * @param events - The events.
 * @returns The events whose order the channel keeps.
 */
const ordered = (events: AnthropicEvent[]): AnthropicEvent[] =>
  events.filter(
    (e) =>
      e.type !== 'content_block_delta' || (e.delta.type !== 'signature_delta' && e.delta.type !== 'citations_delta'),
  );

describe('Anthropic codec over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a tool call, its result and the answer, and folds each turn to the agent’s Message', async () => {
    const name = uniqueChannelName('anthropic');
    const agent = adaptorOn(name);
    const clientChannel = pubsubClient().channels.get(name);
    const decoder = anthropicDecoder();
    const recorder = createDeliveryRecorder<AnthropicEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    const first = await agent.pipe(streamOf(...toolTurn));
    await recorder.waitFor((d) => stops(d) === 1);

    const sent = await anthropicAdaptor(clientChannel).send({ type: 'input', messages: toolResult });
    const second = await agent.pipe(streamOf(...searchTurn));
    await recorder.waitFor((d) => stops(d) === 2);

    // Each turn's message_stop is its last publish, so its serial is the pipe's.
    const stopped = recorder.deliveries.filter((d) => d.event?.type === 'message_stop');
    expect([first.serial, second.serial]).toEqual(stopped.map((d) => d.message.serial));

    expect(ordered(recorder.events())).toStrictEqual(
      ordered([...toolTurn, { type: 'input', messages: toolResult }, ...searchTurn]),
    );
    const input = recorder.deliveries.find((d) => d.event?.type === 'input');
    expect(input?.message.serial).toBe(sent.serial);

    // The signature and the citation can arrive ahead of text before them,
    // and the reducer still builds the Messages the agent's stream built,
    // with both intact.
    expect(await foldWithMessageStream(recorder.events())).toStrictEqual(
      await foldWithMessageStream([...toolTurn, ...searchTurn]),
    );

    // The raw shape: a delta carries its text as the body and the rest of the
    // event under extras.ai.fields, with the adaptor's stream marker beside
    // the type and nothing under extras.headers.
    const delta = recorder.deliveries.find((d) => d.event?.type === 'content_block_delta');
    expect(delta?.message.data).toBe('The user wants ');
    expect(delta?.message.extras).toEqual({
      ai: {
        codec: 'anthropic-messages',
        type: 'content_block_delta',
        stream: true,
        fields: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } },
      },
    });
  });

  it('reads both turns from history with each block’s deltas joined, to the same Messages', async () => {
    const name = uniqueChannelName('anthropic');
    const agent = adaptorOn(name);
    await agent.pipe(streamOf(...toolTurn));
    await agent.pipe(streamOf(...searchTurn));

    const history = await drainHistory(pubsubClient().channels.get(name), anthropicDecoder());
    const events = history.map((d) => d.event).filter((e): e is AnthropicEvent => e !== undefined);

    // Each block's deltas come back as one delta carrying the joined text.
    expect(events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta)).toEqual([
      { type: 'thinking_delta', thinking: 'The user wants the weather.' },
      { type: 'signature_delta', signature: 'EqQBCkYIBxgCKkA=' },
      { type: 'text_delta', text: 'Let me check London.' },
      { type: 'input_json_delta', partial_json: '{"city": "London"}' },
      { type: 'input_json_delta', partial_json: '{"query": "London weather"}' },
      { type: 'text_delta', text: 'It is 12°C and cloudy.' },
      expect.objectContaining({ type: 'citations_delta' }),
    ]);

    expect(await foldWithMessageStream(events)).toStrictEqual(
      await foldWithMessageStream([...toolTurn, ...searchTurn]),
    );
  });
});
