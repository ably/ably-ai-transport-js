/**
 * The agent adaptor and the decoder over a real Ably channel, with the
 * application holding the channel through ably-js.
 *
 * Every scenario here needs the platform: append delivery, the full-content
 * update a late joiner receives, `untilAttach` paging, the serial an ack
 * returns, and `updateMessage` as a repair. The codec is a test one so
 * nothing on screen belongs to a provider.
 */

import type * as Ably from 'ably';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentAdaptor, createDecoder, type Delivery, type Published } from '../../../src/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createTestCodec, streamOf, type TestEvent, textEvents } from '../../helper/test-codec.js';
import { controlledStream, createDeliveryRecorder, failingFirstAppend } from '../helpers.js';

const isTextEnd = (deliveries: { event?: TestEvent }[]): boolean =>
  deliveries.some((d) => d.event?.type === 'text-end');

describe('agent adaptor and decoder over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a reply a subscriber decodes delta for delta, yielding each event with the serial it landed on', async () => {
    const name = uniqueChannelName();
    const agentChannel = ablyRealtimeClient().channels.get(name);
    const clientChannel = ablyRealtimeClient().channels.get(name);
    const decoder = createDecoder(createTestCodec());
    const recorder = createDeliveryRecorder<TestEvent>();
    decoder.onEvent(recorder.record);
    await clientChannel.subscribe(decoder.receive);

    const adaptor = createAgentAdaptor(agentChannel, createTestCodec());
    const sent = await createAgentAdaptor(clientChannel, createTestCodec()).send({ type: 'note', text: 'Weather?' });
    const yielded: Published<TestEvent>[] = [];
    for await (const published of adaptor.pipeEach(streamOf(...textEvents('m1', 'The weather', ' is mild.')))) {
      yielded.push(published);
    }
    await recorder.waitFor(isTextEnd);

    expect(recorder.events()).toEqual([
      { type: 'note', text: 'Weather?' },
      ...textEvents('m1', 'The weather', ' is mild.'),
    ]);
    expect(recorder.deliveries[0]?.message.serial).toBe(sent.serial);
    // Both deltas land on the message the first one opened.
    const streamSerial = recorder.deliveries[2]?.message.serial;
    expect(yielded.map((p) => p.serial)).toEqual([
      recorder.deliveries[1]?.message.serial,
      streamSerial,
      streamSerial,
      recorder.deliveries[4]?.message.serial,
    ]);
  });

  it('gives a decoder that subscribes mid-stream the content so far as one delta', async () => {
    const name = uniqueChannelName();
    const adaptor = createAgentAdaptor(ablyRealtimeClient().channels.get(name), createTestCodec());
    const { source, push, finish } = controlledStream<TestEvent>();
    const piping = adaptor.pipe(source);

    const earlyChannel = ablyRealtimeClient().channels.get(name);
    const early = createDecoder(createTestCodec());
    const earlyRecorder = createDeliveryRecorder<TestEvent>();
    early.onEvent(earlyRecorder.record);
    await earlyChannel.subscribe(early.receive);
    push({ type: 'text-start', id: 'm1' });
    push({ type: 'text-delta', id: 'm1', delta: 'The' });
    push({ type: 'text-delta', id: 'm1', delta: ' weather' });
    await earlyRecorder.waitFor((d) => d.length === 3);

    const lateChannel = ablyRealtimeClient().channels.get(name);
    const late = createDecoder(createTestCodec());
    const lateRecorder = createDeliveryRecorder<TestEvent>();
    late.onEvent(lateRecorder.record);
    await lateChannel.subscribe(late.receive);
    push({ type: 'text-delta', id: 'm1', delta: ' is mild.' });
    push({ type: 'text-end', id: 'm1' });
    finish();
    await piping;
    await lateRecorder.waitFor(isTextEnd);

    // The late decoder's first delivery for the deltas' message is the
    // platform's full-content update, which it hands on whole.
    expect(lateRecorder.events()).toEqual([
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
  });

  it('decodes history paged back from the attach point into what the agent produced, with the deltas joined', async () => {
    const name = uniqueChannelName();
    await createAgentAdaptor(ablyRealtimeClient().channels.get(name), createTestCodec()).pipe(
      streamOf(...textEvents('m1', 'The weather', ' is mild.')),
    );

    const channel = ablyRealtimeClient().channels.get(name);
    await channel.attach();
    const decoder = createDecoder(createTestCodec());
    const messages: Ably.InboundMessage[] = [];
    let page = await channel.history({ untilAttach: true, limit: 1 });
    messages.push(...page.items);
    while (page.hasNext()) {
      const next = await page.next();
      if (!next) break;
      page = next;
      messages.push(...page.items);
    }
    // Pages arrive newest first; the decoder takes them in that order and
    // the application puts what it decoded back in channel order.
    const decoded = messages.flatMap((m) => decoder.decode(m)).toReversed();
    expect(decoded.map((d) => d.event)).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
  });

  it('delivers the application’s own publish and another codec’s with no event', async () => {
    const name = uniqueChannelName();
    const channel = ablyRealtimeClient().channels.get(name);
    const decoder = createDecoder(createTestCodec());
    const recorder = createDeliveryRecorder<TestEvent>();
    decoder.onEvent(recorder.record);
    await channel.subscribe(decoder.receive);

    const publisher = ablyRealtimeClient().channels.get(name);
    await publisher.publish({ name: 'chat.typing', data: { user: 'u1' } });
    await createAgentAdaptor(publisher, createTestCodec('other-codec')).send({
      type: 'note',
      text: 'not yours',
    });
    await createAgentAdaptor(publisher, createTestCodec()).send({ type: 'note', text: 'yours' });
    await recorder.waitFor((d) => d.length === 3);

    expect(recorder.deliveries.map((d: Delivery<TestEvent>) => d.event)).toEqual([
      undefined,
      undefined,
      { type: 'note', text: 'yours' },
    ]);
    expect(recorder.deliveries[0]?.message.name).toBe('chat.typing');
  });

  it('repairs a stream whose append failed, so history holds the whole text', async () => {
    const name = uniqueChannelName();
    // The first delta is a publish; the injected failure hits the second,
    // which is the stream's first append.
    const flaky = failingFirstAppend(ablyRealtimeClient(), new Error('injected append failure'));
    const adaptor = createAgentAdaptor(flaky.channels.get(name), createTestCodec());
    // Drained to the end, so the repair runs before the stream's closer.
    const yielded: Published<TestEvent>[] = [];
    for await (const published of adaptor.pipeEach(streamOf(...textEvents('m1', 'The weather', ' is mild.')))) {
      yielded.push(published);
    }
    expect(yielded).toHaveLength(4);

    const channel = ablyRealtimeClient().channels.get(name);
    await channel.attach();
    const page = await channel.history({ untilAttach: true, limit: 10 });
    const decoder = createDecoder(createTestCodec());
    const decoded = page.items.flatMap((m) => decoder.decode(m)).toReversed();
    expect(decoded.map((d) => d.event)).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
  });
});
