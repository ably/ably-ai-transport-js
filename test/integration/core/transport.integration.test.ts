/**
 * The transport over a real Ably channel.
 *
 * Every scenario here needs the platform: append delivery, the full-content
 * update a late joiner receives, `untilAttach` paging, the serial an ack
 * returns, `updateMessage` as a repair, and delete delivery. Codec edge cases
 * stay in the unit tier. The codec is a test one so nothing on screen belongs
 * to a provider.
 */

import * as Ably from 'ably';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelAgent, createTransport, ErrorCode, type Transport } from '../../../src/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createTestCodec, streamOf, type TestEvent, textEvents } from '../../helper/test-codec.js';
import { controlledStream, createDeliveryRecorder, drainHistory, failingFirstAppend } from '../helpers.js';

const codec = createTestCodec();

const channelFor = (client: Ably.Realtime, name: string): Ably.RealtimeChannel =>
  client.channels.get(name, { params: { agent: channelAgent(codec) } });

const transportOn = (name: string): Transport<TestEvent> =>
  createTransport({ channel: channelFor(ablyRealtimeClient(), name), codec: createTestCodec() });

/**
 * A transport with the channel it reads, for a subscriber that waits for the attach.
 * @param name - The channel name.
 * @returns The transport and its channel.
 */
const readerOn = (name: string): { transport: Transport<TestEvent>; channel: Ably.RealtimeChannel } => {
  const channel = channelFor(ablyRealtimeClient(), name);
  return { transport: createTransport({ channel, codec: createTestCodec() }), channel };
};

const isTextEnd = (deliveries: { event?: TestEvent }[]): boolean =>
  deliveries.some((d) => d.event?.type === 'text-end');

describe('transport over Ably', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('streams a reply as a message per start and end and one that grows by appends, and a subscriber decodes each delta', async () => {
    const name = uniqueChannelName();
    const agent = transportOn(name);
    const { transport: client, channel: clientChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<TestEvent>();
    // The first subscribe attaches the channel; waiting for ATTACHED means the
    // messages below cannot arrive before the listener is in place.
    client.subscribe(recorder.record);
    await clientChannel.whenState('attached');

    const sent = await client.send({ type: 'note', text: 'What is the weather?' });
    const result = await agent.pipe(streamOf<TestEvent>(...textEvents('m1', 'The weather', ' is mild.')));
    await recorder.waitFor(isTextEnd);

    expect(recorder.events()).toEqual([
      { type: 'note', text: 'What is the weather?' },
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The weather' },
      { type: 'text-delta', id: 'm1', delta: ' is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
    // send's serial is the delivered message's serial. The stream is three
    // messages: the start, the one the deltas share, and the end, and the pipe
    // resolves with the serial of the last one.
    expect(recorder.deliveries[0]?.message.serial).toBe(sent.serial);
    const streamSerials = new Set(recorder.deliveries.slice(1).map((d) => d.message.serial));
    expect(streamSerials.size).toBe(3);
    expect(result.serial).toBe(recorder.deliveries.at(-1)?.message.serial);
    expect(recorder.deliveries.slice(1).map((d) => d.message.action)).toEqual([
      'message.create',
      'message.create',
      'message.append',
      'message.create',
    ]);
    // The raw shape: the codec's name, the row's data, the row's headers under
    // extras.headers and the type under extras.ai, echoed as published, with
    // the transport's stream marker on the deltas' writes and the serial the
    // end message ends.
    // CAST: `data` and `extras` are typed `any`; the test compares them as values.
    expect(
      recorder.deliveries.map((d) => [d.message.name, d.message.data as unknown, d.message.extras as unknown]),
    ).toEqual([
      ['test', 'What is the weather?', { ai: { type: 'note' } }],
      ['test', '', { ai: { type: 'text-start' }, headers: { id: 'm1' } }],
      ['test', 'The weather', { ai: { type: 'text-delta', stream: true }, headers: { id: 'm1' } }],
      ['test', ' is mild.', { ai: { type: 'text-delta', stream: true }, headers: { id: 'm1' } }],
      ['test', '', { ai: { type: 'text-end', ends: recorder.deliveries[2]?.message.serial }, headers: { id: 'm1' } }],
    ]);
  });

  it('gives a subscriber that attaches mid-stream the content so far as one delta', async () => {
    const name = uniqueChannelName();
    const agent = transportOn(name);
    const { source, push, finish } = controlledStream<TestEvent>();
    const piping = agent.pipe(source);

    // The first subscriber sees the stream from the start.
    const { transport: early, channel: earlyChannel } = readerOn(name);
    const earlyRecorder = createDeliveryRecorder<TestEvent>();
    early.subscribe(earlyRecorder.record);
    await earlyChannel.whenState('attached');
    push({ type: 'text-start', id: 'm1' });
    push({ type: 'text-delta', id: 'm1', delta: 'The' });
    push({ type: 'text-delta', id: 'm1', delta: ' weather' });
    await earlyRecorder.waitFor((d) => d.length === 3);

    // A second subscriber attaches while the stream is in flight. Its first
    // delivery for the message is the platform's full-content update, which
    // the codec reduces to one delta carrying everything so far.
    const { transport: late, channel: lateChannel } = readerOn(name);
    const lateRecorder = createDeliveryRecorder<TestEvent>();
    late.subscribe(lateRecorder.record);
    await lateChannel.whenState('attached');
    push({ type: 'text-delta', id: 'm1', delta: ' is mild.' });
    push({ type: 'text-end', id: 'm1' });
    finish();
    await piping;
    await lateRecorder.waitFor(isTextEnd);
    await earlyRecorder.waitFor(isTextEnd);

    // The late subscriber attached after 'The' opened the deltas' message and
    // ' weather' was appended to it, so the first delivery it gets for that
    // message is not the ' is mild.' append. Ably converts the first append
    // after an attach into a `message.update` carrying the whole message so
    // far, and the codec decodes that update as one delta with all of the
    // text. The end is its own message, so it follows as a create.
    expect(lateRecorder.deliveries.map((d) => d.message.action)).toEqual(['message.update', 'message.create']);
    expect(lateRecorder.deliveries[0]?.message.data).toBe('The weather is mild.');
    expect(lateRecorder.events()).toEqual([
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
    // The early subscriber was attached before anything was published and
    // stayed subscribed throughout: the start is a create, the first delta is
    // the create that opens the deltas' message, each later delta is its own
    // `message.append`, and the end is a create.
    expect(earlyRecorder.deliveries.map((d) => d.message.action)).toEqual([
      'message.create',
      'message.create',
      'message.append',
      'message.append',
      'message.create',
    ]);
    expect(earlyRecorder.events()).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The' },
      { type: 'text-delta', id: 'm1', delta: ' weather' },
      { type: 'text-delta', id: 'm1', delta: ' is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
  });

  it('recovers from a discontinuity by reading history back to the last serial seen', async () => {
    const name = uniqueChannelName();
    const writer = transportOn(name);
    const { transport: reader, channel: readerChannel } = readerOn(name);
    const discontinuities = vi.fn();
    reader.on('discontinuity', discontinuities);
    const recorder = createDeliveryRecorder<TestEvent>();
    reader.subscribe(recorder.record);
    await readerChannel.whenState('attached');
    await writer.send({ type: 'note', text: 'one' });
    await writer.send({ type: 'note', text: 'two' });
    await recorder.waitFor((d) => d.length === 2);

    // The channel loses continuity: detached, then attached again with no
    // resume, as ably-js does after a long disconnection. Two messages land
    // in the gap.
    const lastSeen = recorder.deliveries[1]?.message.serial ?? '';
    await readerChannel.detach();
    await writer.send({ type: 'note', text: 'three' });
    await writer.send({ type: 'note', text: 'four' });
    await readerChannel.attach();
    expect(discontinuities).toHaveBeenCalled();

    // The recovery: page history back from the new attach point and apply
    // what is newer than the last serial applied. Serials sort as strings.
    const page = await reader.history({ limit: 10 });
    const missed = page.items.filter((d) => (d.message.serial ?? '') > lastSeen);
    expect(missed.map((d) => d.event)).toEqual([
      { type: 'note', text: 'three' },
      { type: 'note', text: 'four' },
    ]);
    // CAST: `data` is typed `any`; the test compares it as a value.
    expect(page.items.map((d) => d.message.data as unknown)).toEqual(['one', 'two', 'three', 'four']);

    // Live delivery carries on from the new attach point.
    await writer.send({ type: 'note', text: 'five' });
    await recorder.waitFor((d) => d.length === 3);
    expect(recorder.events().at(-1)).toEqual({ type: 'note', text: 'five' });
  });

  it('reads a finished stream from history as the events the agent produced, with the deltas joined', async () => {
    const name = uniqueChannelName();
    const agent = transportOn(name);
    await agent.pipe(streamOf<TestEvent>(...textEvents('m1', 'The weather', ' is mild.')));

    // Ably's append replaces the stored extras, so the message the deltas
    // share reads back under the delta type with the joined text; the start
    // and the end are messages of their own and read back as themselves.
    const reader = transportOn(name);
    const history = await drainHistory(reader);
    expect(history.map((d) => d.event)).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
    expect(history[1]?.message.data).toBe('The weather is mild.');
  });

  it('pages a finished stream back one message at a time, decoding the end before the message it ends', async () => {
    const name = uniqueChannelName();
    const agent = transportOn(name);
    // A live subscriber records the publish that opens the deltas' message,
    // so the serial the end names can be checked against the serial that
    // publish was acked with rather than against what history reports.
    const { transport: live, channel: liveChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<TestEvent>();
    live.subscribe(recorder.record);
    await liveChannel.whenState('attached');

    // Three messages: the start, the one the deltas share (a publish and two
    // appends), and the end.
    const result = await agent.pipe(streamOf<TestEvent>(...textEvents('m1', 'The', ' weather', ' is mild.')));
    await recorder.waitFor(isTextEnd);
    const opened = recorder.deliveries.find(
      (d) => d.message.action === 'message.create' && d.event?.type === 'text-delta',
    );
    const createSerial = opened?.message.serial;
    expect(createSerial).toBeDefined();

    // A page of one walks the stream backwards: the end first, then the
    // message it ends, then the start. The end names the deltas' message
    // under extras.ai.ends, and the decoder meets that message only after the
    // end, on the next page, as a whole message it hands on and does not
    // track.
    const reader = transportOn(name);
    const endPage = await reader.history({ limit: 1 });
    expect(endPage.items.map((d) => d.event)).toEqual([{ type: 'text-end', id: 'm1' }]);
    expect(endPage.items[0]?.message.serial).toBe(result.serial);
    expect(endPage.hasNext).toBe(true);

    const deltasPage = await endPage.next();
    expect(deltasPage.items.map((d) => d.event)).toEqual([
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
    ]);
    expect(deltasPage.items[0]?.message.data).toBe('The weather is mild.');
    // The end names the message by the serial its opening publish was acked
    // with. That is the message's own serial, which the appends do not move;
    // history reports the same serial for it, with a later version serial.
    // CAST: `extras` is typed `any`; the test reads the serial the end names.
    const ended = (endPage.items[0]?.message.extras as { ai?: { ends?: unknown } } | undefined)?.ai?.ends;
    expect(ended).toBe(createSerial);
    expect(deltasPage.items[0]?.message.serial).toBe(createSerial);
    expect(deltasPage.items[0]?.message.version.serial).not.toBe(createSerial);
    expect(deltasPage.hasNext).toBe(true);

    const startPage = await deltasPage.next();
    expect(startPage.items.map((d) => d.event)).toEqual([{ type: 'text-start', id: 'm1' }]);
    // A full page reports a next link whether or not anything older exists;
    // the walk ends with an empty page whose hasNext is false.
    let past = startPage;
    while (past.hasNext) {
      past = await past.next();
      expect(past.items).toEqual([]);
    }

    // The three messages have three distinct serials, in channel order.
    const serials = [startPage, deltasPage, endPage].map((p) => p.items[0]?.message.serial ?? '');
    expect(new Set(serials).size).toBe(3);
    expect([...serials].toSorted()).toEqual(serials);
  });

  it('delivers another application’s publish on the same channel raw, with no event', async () => {
    const name = uniqueChannelName();
    const { transport: reader, channel: readerChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<TestEvent>();
    reader.subscribe(recorder.record);
    await readerChannel.whenState('attached');

    const foreign = channelFor(ablyRealtimeClient(), name);
    await foreign.publish({ name: 'chat.message', data: { text: 'hello from the app' } });
    await transportOn(name).send({ type: 'note', text: 'ours' });
    await recorder.waitFor((d) => d.length === 2);

    expect(recorder.deliveries[0]?.event).toBeUndefined();
    expect(recorder.deliveries[0]?.message.name).toBe('chat.message');
    expect(recorder.events()).toEqual([{ type: 'note', text: 'ours' }]);
  });

  it('delivers a delete with no event', async () => {
    const name = uniqueChannelName();
    const writer = transportOn(name);
    const { transport: reader, channel: readerChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<TestEvent>();
    reader.subscribe(recorder.record);
    await readerChannel.whenState('attached');

    const { serial } = await writer.send({ type: 'note', text: 'to be removed' });
    await recorder.waitFor((d) => d.length === 1);
    await channelFor(ablyRealtimeClient(), name).deleteMessage({ serial });
    await recorder.waitFor((d) => d.length === 2);

    const deletion = recorder.deliveries[1];
    expect(deletion?.event).toBeUndefined();
    expect(deletion?.message.action).toBe('message.delete');
    expect(deletion?.message.serial).toBe(serial);
  });

  it('stops a pipe on its signal and writes nothing more', async () => {
    const name = uniqueChannelName();
    const agent = transportOn(name);
    const controller = new AbortController();
    const source = new ReadableStream<TestEvent>({
      start: (c) => {
        c.enqueue({ type: 'text-start', id: 'm1' });
        c.enqueue({ type: 'text-delta', id: 'm1', delta: 'partial' });
        // Never closes: the pipe ends only by signal.
      },
    });
    const piping = agent.pipe(source, { signal: controller.signal });

    const { transport: reader, channel: readerChannel } = readerOn(name);
    const recorder = createDeliveryRecorder<TestEvent>();
    reader.subscribe(recorder.record);
    await readerChannel.whenState('attached');
    // Give the pipe time to write, in the only way this tier allows: wait for
    // the second delivery, which is the delta the reader sees.
    await recorder.waitFor((d) => d.some((x) => x.event?.type === 'text-delta'));
    const outcome = expect(piping).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    controller.abort();
    await outcome;

    // The start, and the message the first delta opened, are all that reached
    // the channel.
    const history = await drainHistory(transportOn(name));
    expect(history.map((d) => d.event)).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'partial' },
    ]);
    expect(history[1]?.message.data).toBe('partial');
  });

  it('repairs a stream whose append failed, so history holds the whole text', async () => {
    const name = uniqueChannelName();
    // The first delta is a publish; the injected failure hits the second,
    // which is the stream's first append.
    const flaky = failingFirstAppend(channelFor(ablyRealtimeClient(), name), new Error('injected append failure'));
    const agent = createTransport({ channel: flaky, codec: createTestCodec() });

    await expect(agent.pipe(streamOf<TestEvent>(...textEvents('m1', 'The weather', ' is mild.')))).resolves.toEqual({
      serial: expect.any(String) as string,
    });

    const history = await drainHistory(transportOn(name));
    expect(history.map((d) => d.event)).toEqual([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'The weather is mild.' },
      { type: 'text-end', id: 'm1' },
    ]);
    expect(history[1]?.message.data).toBe('The weather is mild.');
  });

  it('rejects a pipe OperationCancelled when the transport closes under it', async () => {
    const agent = transportOn(uniqueChannelName());
    const source = new ReadableStream<TestEvent>({
      start: (c) => {
        c.enqueue({ type: 'note', text: 'first' });
      },
    });
    const piping = agent.pipe(source);
    const outcome = expect(piping).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    await agent.close();
    await outcome;
    await expect(agent.send({ type: 'note', text: 'late' })).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });
});
