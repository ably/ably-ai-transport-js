/**
 * OpenAI Responses codec driven through the core transports over real Ably.
 *
 * Every test here has three jobs, and they matter equally: it exercises only
 * the public API, it reads as the code a developer would write to get the
 * behaviour, and it fails when the behaviour breaks. The API calls stay in the
 * body of the test; the helpers below cover only what a developer does not
 * write themselves — a channel name, a fixture output stream, and waiting for
 * an event.
 *
 * The sibling `wire-codec.integration.test.ts` proves the codec's own wire
 * format without a transport. This file proves the pairing: `createClientTransport`
 * and `createAgentTransport` parameterised by the Responses codec, with runs,
 * history and the attach boundary underneath.
 *
 * Assertions read the decoded event sequence rather than a folded message.
 * The Vercel tier folds through `readUIMessageStream`, whose strictness doubles
 * as a well-formedness oracle; OpenAI has no usable equivalent here, because
 * `accumulateResponse` requires a `response.created` the codec drops, pushes
 * blindly on the `output_item.added` the decoder synthesises, and replaces
 * wholesale on the reduced `output_item.done` the codec publishes. Assembling
 * a message is the application's job either way (see the demo's own merge), so
 * these tests assert what the transport actually delivers.
 *
 * Scope: only behaviour where the codec's own shape meets the platform. Cancel,
 * steering, `echoMessages: false`, concurrent runs, run errors and `adoptRun`
 * are codec-agnostic and already proven in `../core/transport.integration.test.ts`.
 */

import type * as Ably from 'ably';
import type { Responses } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';

import { channelAgent } from '../../../src/core/agent.js';
import { createAgentTransport } from '../../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { RunLifecycleEvent, TransportEvent } from '../../../src/core/transport/types.js';
import type { OpenAIOutput } from '../../../src/openai/index.js';
import { createResponsesCodec } from '../../../src/openai/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import {
  contentPartAdded,
  functionCallArgsRun,
  itemAdded,
  itemDone,
  messageItem,
  reasoningItem,
  reasoningSummaryPartAdded,
  reasoningTextDelta,
  reasoningTextPartAdded,
  refusalPartAdded,
  textDelta,
  textDone,
} from '../../helper/openai-fixtures.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { createEventRecorder, drainHistory } from '../helpers.js';

/**
 * The application's own input vocabulary. The Responses API is output only, so
 * the codec declares no input shape: it carries whatever JSON body the
 * application hands it and gives the same body back on decode. Naming the
 * union here is what types both ends of that passthrough.
 */
type AppInput =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool-result'; item: Responses.ResponseInputItem.FunctionCallOutput };

const codec = createResponsesCodec<AppInput>();

/** Inert initial value for a captured resolver. */
const noop = (): void => {
  /* replaced by the promise executor */
};

type Event = TransportEvent<AppInput, OpenAIOutput>;

/**
 * A channel resolved the way an application resolves it, with the SDK's agent
 * param stamped so channel traffic is attributable to the codec.
 * @param channelName - The conversation's channel name.
 * @returns The resolved channel, on its own connection.
 */
const channelFor = (channelName: string): Ably.RealtimeChannel =>
  ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } });

/**
 * A fixture output stream: the given Responses events, in order, as the
 * agent's pipe source.
 * @param events - The events to stream, in order.
 * @returns A stream of those events.
 */
const responsesStream = (events: OpenAIOutput[]): ReadableStream<OpenAIOutput> =>
  new ReadableStream<OpenAIOutput>({
    start: (controller) => {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });

/**
 * Every decoded output across a batch of events, in delivery order.
 * @param events - The recorded transport events.
 * @returns The decoded output events they carry.
 */
const outputsOf = (events: Event[]): OpenAIOutput[] => events.flatMap((e) => (e.kind === 'message' ? e.outputs : []));

/**
 * Every run-lifecycle event across a batch, in delivery order.
 * @param events - The recorded transport events.
 * @returns The run-lifecycle events they carry.
 */
const lifecycleOf = (events: Event[]): RunLifecycleEvent[] =>
  events.flatMap((e) => (e.kind === 'run-lifecycle' ? [e.event] : []));

/**
 * The text a streamed message carries, concatenated from its deltas.
 * @param outputs - The decoded output events, in delivery order.
 * @returns The concatenated delta text.
 */
const deltaTextOf = (outputs: OpenAIOutput[]): string =>
  outputs
    .filter((o) => o.type === 'response.output_text.delta')
    .map((o) => o.delta)
    .join('');

describe('OpenAI codec over the core transports', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('a client sends a prompt and the agent answers with a streamed Responses turn', async () => {
    const channelName = uniqueChannelName('oai-turn');

    /**
     * The agent's route, in its own scope: everything it needs arrives in the
     * request and everything it produces goes onto the channel.
     * @param eventId - The triggering input's event id, as the client POSTed it.
     */
    const agentRoute = async (eventId: string): Promise<void> => {
      const agent = createAgentTransport<AppInput, OpenAIOutput>({
        channel: channelFor(channelName),
        codec,
        clientId: 'agent',
      });
      await agent.connect();

      // The route wakes with an event id and reads back the input that woke
      // it — an application-shaped body the codec carried opaquely.
      const input = await agent.locateInput(eventId);
      expect(input?.inputs).toEqual([{ kind: 'prompt', text: 'what is the weather?' }]);
      if (!input) return;

      const run = agent.openRun({ input });
      const streamed = await run.pipe(
        responsesStream([
          itemAdded(messageItem('msg_1')),
          contentPartAdded('msg_1'),
          textDelta('msg_1', 'It is '),
          textDelta('msg_1', 'sunny.'),
          textDone('msg_1', 'It is sunny.'),
          itemDone(messageItem('msg_1', [{ type: 'output_text', text: 'It is sunny.', annotations: [] }])),
        ]),
      );
      const ended = await run.end({ reason: 'complete' });

      expect(streamed.reason).toBe('complete');
      expect(ended.serial).toBeTypeOf('string');
      agent.close();
    };

    const client = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await client.connect();
    const received = createEventRecorder<AppInput, OpenAIOutput>();
    client.subscribe(received.record);

    const sent = await client.publishInput({ kind: 'prompt', text: 'what is the weather?' });
    const answered = agentRoute(sent.eventId);

    const runId = await sent.runId;
    await received.waitFor((all) =>
      all.some((e) => e.kind === 'run-lifecycle' && e.event.type === 'end' && e.event.runId === runId),
    );

    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle.map((e) => e.type)).toEqual(['start', 'end']);
    expect(lifecycle[0]).toMatchObject({ inputTransportMessageId: sent.transportMessageId });
    expect(lifecycle[1]).toMatchObject({ reason: 'complete' });

    // The bracket the codec's descriptor table curates survives real Ably
    // serialization: the item envelope, the part opener, the streamed deltas,
    // then the two closes rebuilt from the accumulated text.
    const outputs = outputsOf(received.events);
    const types = outputs.map((o) => o.type);
    // Assert the envelope arrived before ordering against it: indexOf yields
    // -1 for an absent event, which would satisfy every `toBeLessThan` below.
    expect(outputs.find((o) => o.type === 'response.output_item.added')).toMatchObject({
      item: { type: 'message', id: 'msg_1' },
    });
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
    expect(types.indexOf('response.content_part.added')).toBeLessThan(types.indexOf('response.output_text.delta'));
    expect(types.indexOf('response.output_text.delta')).toBeLessThan(types.indexOf('response.output_text.done'));
    expect(types.indexOf('response.output_text.done')).toBeLessThan(types.indexOf('response.output_item.done'));
    expect(deltaTextOf(outputs)).toBe('It is sunny.');

    await answered;
    client.close();
  });

  it('a client joining mid-stream receives a synthesised opening bracket ahead of the part it picked up', async () => {
    const channelName = uniqueChannelName('oai-join');
    const agent = createAgentTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      clientId: 'agent',
    });
    await agent.connect();

    // The first half streams before the joining client exists, so its first
    // delivery of the message is the platform's full-contents update rather
    // than the `output_item.added` that opened the bracket. That is the
    // delivery the decoder's mid-stream-join policy repairs.
    const run = agent.openRun();
    let releaseSecondHalf: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      releaseSecondHalf = resolve;
    });
    const source = new ReadableStream<OpenAIOutput>({
      start: async (controller) => {
        controller.enqueue(itemAdded(messageItem('msg_1')));
        controller.enqueue(contentPartAdded('msg_1'));
        controller.enqueue(textDelta('msg_1', 'first half '));
        await gate;
        controller.enqueue(textDelta('msg_1', 'second half'));
        controller.enqueue(textDone('msg_1', 'first half second half'));
        controller.enqueue(
          itemDone(messageItem('msg_1', [{ type: 'output_text', text: 'first half second half', annotations: [] }])),
        );
        controller.close();
      },
    });

    // A client that attached before the run, so its delivery of the first
    // append is what proves the append landed and the joiner below is
    // guaranteed to arrive mid-stream. A sleep here would let a slow run
    // finish first and pass without exercising the join at all. It waits for a
    // delta rather than any output because a streamed message opens on its
    // first delivery and its text arrives on a later append.
    const watching = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await watching.connect();
    const watched = createEventRecorder<AppInput, OpenAIOutput>();
    watching.subscribe(watched.record);

    const pipePromise = run.pipe(source);
    await watched.waitFor((all) =>
      outputsOf(all).some((o) => o.type === 'response.output_text.delta' && o.delta.includes('first half')),
    );

    const joiner = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await joiner.connect();
    const joined = createEventRecorder<AppInput, OpenAIOutput>();
    joiner.subscribe(joined.record);

    releaseSecondHalf();
    await pipePromise;
    await run.end({ reason: 'complete' });
    await joined.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));

    // The repair: the joiner never saw the real opener, so the decoder
    // synthesises one ahead of the part it did pick up. Without it the
    // sequence starts at a content part whose item was never introduced, and
    // a consumer's merge has nothing to attach it to.
    const outputs = outputsOf(joined.events);
    const types = outputs.map((o) => o.type);
    const openerIndex = types.indexOf('response.output_item.added');
    const partIndex = types.indexOf('response.content_part.added');
    expect(openerIndex).toBeGreaterThanOrEqual(0);
    expect(openerIndex).toBeLessThan(partIndex);

    const opener = outputs[openerIndex];
    expect(opener?.type).toBe('response.output_item.added');
    if (opener?.type === 'response.output_item.added') {
      // The synthesised container is a message, chosen from the re-stamped
      // part header, and it carries the item id the parts address.
      expect(opener.item).toMatchObject({ id: 'msg_1', type: 'message' });
    }

    // The joiner still reaches the whole reply: the full-contents update
    // carries what it missed, and the later appends carry the rest.
    const done = outputs.find((o) => o.type === 'response.output_text.done');
    expect(done).toMatchObject({ item_id: 'msg_1', text: 'first half second half' });

    joiner.close();
    watching.close();
    agent.close();
  });

  it('a function call streams to the client and its resolution wakes a fresh run', async () => {
    const channelName = uniqueChannelName('oai-tool');
    const client = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await client.connect();
    const received = createEventRecorder<AppInput, OpenAIOutput>();
    client.subscribe(received.record);

    const agent = createAgentTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      clientId: 'agent',
    });

    const asked = await client.publishInput({ kind: 'prompt', text: 'where am I?' });
    await agent.connect();

    // Turn one: the model calls a tool only the client can run, so the run
    // ends. There is nothing to suspend — the resolution wakes a new run.
    const located = await agent.locateInput(asked.eventId);
    if (!located) throw new Error(`trigger ${asked.eventId} not found in history`);
    const first = agent.openRun({ input: located });
    await first.pipe(responsesStream(functionCallArgsRun('fc_1', 'call_1', 'getLocation', '{}')));
    await first.end({ reason: 'complete' });

    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));

    // The call reached the client with the name and call_id it needs to run
    // the tool, rebuilt from the item envelope on the stream's start.
    const call = outputsOf(received.events).find((o) => o.type === 'response.output_item.added');
    expect(call).toMatchObject({ item: { type: 'function_call', call_id: 'call_1', name: 'getLocation' } });

    // The client publishes the result in its own vocabulary, which the codec
    // carries opaquely, and that input wakes a second run.
    const resolved = await client.publishInput({
      kind: 'tool-result',
      item: { type: 'function_call_output', call_id: 'call_1', output: '{"city":"Berlin"}' },
    });

    // A fresh transport for the second turn, as a per-request route gets:
    // `locateInput` pages backwards from the attach point, so a transport that
    // attached before the resolution was published can never see it.
    agent.close();
    const answering = createAgentTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      clientId: 'agent',
    });
    await answering.connect();

    const locatedResult = await answering.locateInput(resolved.eventId);
    expect(locatedResult?.inputs).toEqual([
      { kind: 'tool-result', item: { type: 'function_call_output', call_id: 'call_1', output: '{"city":"Berlin"}' } },
    ]);
    if (!locatedResult) throw new Error('resolution not found in history');

    const second = answering.openRun({ input: locatedResult });
    await second.pipe(
      responsesStream([
        // The agent echoes the executed result onto the channel so every other
        // subscriber sees the answer to a call it can also see.
        {
          type: 'function_call_output',
          item: { type: 'function_call_output', call_id: 'call_1', output: '{"city":"Berlin"}' },
        },
        itemAdded(messageItem('msg_2')),
        contentPartAdded('msg_2'),
        textDelta('msg_2', 'You are in Berlin.'),
        textDone('msg_2', 'You are in Berlin.'),
        itemDone(messageItem('msg_2', [{ type: 'output_text', text: 'You are in Berlin.', annotations: [] }])),
      ]),
    );
    await second.end({ reason: 'complete' });

    await received.waitFor((all) => lifecycleOf(all).filter((e) => e.type === 'end').length === 2);

    // Two runs, not a re-entry into the first.
    const runIds = lifecycleOf(received.events)
      .filter((e) => e.type === 'start')
      .map((e) => e.runId);
    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);

    const outputs = outputsOf(received.events);
    const echoed = outputs.find((o) => o.type === 'function_call_output');
    expect(echoed?.item).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"city":"Berlin"}' });
    expect(deltaTextOf(outputs)).toBe('You are in Berlin.');

    client.close();
    answering.close();
  });

  it('a cancel closes every streamed group a run left open', async () => {
    const channelName = uniqueChannelName('oai-cancel');
    const client = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await client.connect();
    const received = createEventRecorder<AppInput, OpenAIOutput>();
    client.subscribe(received.record);

    const agent = createAgentTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      clientId: 'agent',
    });

    const sent = await client.publishInput({ kind: 'prompt', text: 'think out loud, at length' });
    await agent.connect();
    const located = await agent.locateInput(sent.eventId);
    if (!located) throw new Error(`trigger ${sent.eventId} not found in history`);
    const run = agent.openRun({ input: located });

    // Four streamed groups open at once across two items — text and a refusal
    // sharing a message, a summary and reasoning text sharing a reasoning
    // item. A denser topology than a flat chunk stream produces, and the one
    // the cancel has to unwind. The source never closes on its own, so only
    // the cancel ends it.
    const streamed = run.pipe(
      new ReadableStream<OpenAIOutput>({
        start: (controller) => {
          controller.enqueue(itemAdded(messageItem('msg_1')));
          controller.enqueue(contentPartAdded('msg_1', 0));
          controller.enqueue(refusalPartAdded('msg_1', 1));
          controller.enqueue(itemAdded(reasoningItem('rs_1')));
          controller.enqueue(reasoningSummaryPartAdded('rs_1', 0));
          controller.enqueue(reasoningTextPartAdded('rs_1', 0));
          controller.enqueue(textDelta('msg_1', 'starting', 0));
          controller.enqueue(reasoningTextDelta('rs_1', 'weighing', 0));
        },
      }),
    );

    await received.waitFor((all) => outputsOf(all).some((o) => o.type === 'response.output_text.delta'));
    await client.cancel(await sent.runId);

    const result = await streamed;
    expect(result.reason).toBe('cancelled');
    expect(run.abortSignal.aborted).toBe(true);

    await run.end({ reason: 'cancelled' });
    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));
    expect(lifecycleOf(received.events).at(-1)).toMatchObject({ type: 'end', reason: 'cancelled' });

    // Everything published before the cancel is still on the wire and still
    // decodes: unwinding the open groups does not retract what they carried.
    const outputs = outputsOf(received.events);
    expect(deltaTextOf(outputs)).toBe('starting');
    expect(outputs.some((o) => o.type === 'response.reasoning_text.delta')).toBe(true);

    client.close();
    agent.close();
  });

  it('history paging replays a finished Responses turn with its streamed group intact', async () => {
    const channelName = uniqueChannelName('oai-history');
    const client = createClientTransport<AppInput, OpenAIOutput>({ channel: channelFor(channelName), codec });
    await client.connect();

    const agent = createAgentTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      clientId: 'agent',
    });

    const sent = await client.publishInput({ kind: 'prompt', text: 'history please' });
    await agent.connect();
    const located = await agent.locateInput(sent.eventId);
    if (!located) throw new Error(`trigger ${sent.eventId} not found in history`);
    const run = agent.openRun({ input: located });
    await run.pipe(
      responsesStream([
        itemAdded(messageItem('msg_1')),
        contentPartAdded('msg_1'),
        textDelta('msg_1', 'remem'),
        textDelta('msg_1', 'bered'),
        textDone('msg_1', 'remembered'),
        itemDone(messageItem('msg_1', [{ type: 'output_text', text: 'remembered', annotations: [] }])),
      ]),
    );
    await run.end({ reason: 'complete' });
    client.close();

    // A client that was never there pages the whole conversation back. A
    // streamed group persists as one channel message that grew by append, so
    // history returns it aggregated rather than delta by delta.
    const late = createClientTransport<AppInput, OpenAIOutput>({
      channel: channelFor(channelName),
      codec,
      historyPageSize: 3,
    });
    await late.connect();
    const history = await drainHistory(late);

    expect(lifecycleOf(history).map((e) => e.type)).toEqual(['start', 'end']);
    expect(history.flatMap((e) => (e.kind === 'message' ? e.inputs : []))).toEqual([
      { kind: 'prompt', text: 'history please' },
    ]);

    const outputs = outputsOf(history);
    const types = outputs.map((o) => o.type);
    expect(outputs.find((o) => o.type === 'response.output_item.added')).toMatchObject({
      item: { type: 'message', id: 'msg_1' },
    });
    expect(types.indexOf('response.output_item.added')).toBeLessThan(types.indexOf('response.content_part.added'));
    expect(deltaTextOf(outputs)).toBe('remembered');
    const doneItem = outputs.find((o) => o.type === 'response.output_item.done');
    expect(doneItem).toBeDefined();
    expect(doneItem).toMatchObject({ item: { id: 'msg_1', type: 'message' } });
    // The terminal rides the wire reduced: the deltas already carried the
    // text, so re-sending it on the close would duplicate the whole message.
    const doneWireItem = doneItem?.type === 'response.output_item.done' ? doneItem.item : undefined;
    expect(doneWireItem).toBeDefined();
    expect(doneWireItem && 'content' in doneWireItem).toBe(false);

    late.close();
    agent.close();
  });
});
