/**
 * Core-transport integration tests over real Ably.
 *
 * Every test here has three jobs, and they matter equally.
 *
 * 1. **Exercise the public API.** A test calls only what an application can
 *    call: what an `index.ts` re-exports. It never reaches into a transport's
 *    fields or asserts on private state.
 * 2. **Demonstrate use.** A test reads as the code a developer would write to
 *    get the behaviour, in the order they would write it. The API calls stay
 *    in the body of the test. Helpers cover only what a developer does not
 *    write themselves: a channel name, a fixture output stream, and waiting
 *    for an event.
 * 3. **Verify the behaviour.** A test fails when the behaviour breaks, and its
 *    assertions read return values and delivered events.
 *
 * A test that proves the behaviour through private state, or that hides the
 * calls behind a local helper, fails the second job even while it passes.
 *
 * This file covers `createClientTransport` and `createAgentTransport` with the
 * Vercel codec on the wire. Message assembly is done the way an application
 * does it: bucket the classified events by transport-message-id and merge each
 * bucket through the provider's own reducer (`readUIMessageStream`). The SDK
 * merges nothing.
 *
 * The chat-transport tier is a sibling, in `../vercel/`.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { EVENT_RUN_START } from '../../../src/constants.js';
import { channelAgent } from '../../../src/core/agent.js';
import { createAgentTransport } from '../../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { AgentTransport, RunLifecycleEvent, TransportEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../../helper/realtime-client.js';
import { foldWithProviderReducer } from '../../helper/ui-message-fold.js';
import { createEventRecorder, drainHistory, textResponseStream } from '../helpers.js';

const codec = createUIMessageCodec();

/** Inert initial value for a captured resolver. */
const noop = (): void => {
  /* replaced by the promise executor */
};

type Event = TransportEvent<VercelInput, VercelOutput>;

/**
 * The application's demultiplex-and-merge: bucket output chunks (and
 * chunk-shaped input bodies) by transport-message-id in first-seen order, merge
 * each bucket through the provider's own reducer, and return the final
 * message per bucket.
 * @param events - The classified events, in delivery order.
 * @returns The merged messages, in first-seen bucket order.
 */
const mergeMessages = async (events: Event[]): Promise<AI.UIMessage[]> => {
  interface Bucket {
    chunks: AI.UIMessageChunk[];
    message?: AI.UIMessage;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh: Bucket = { chunks: [] };
    buckets.set(key, fresh);
    return fresh;
  };
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const id = event.meta.transportMessageId;
    if (id === undefined) continue;
    const bucket = bucketFor(id);
    bucket.chunks.push(...event.outputs);
    for (const input of event.inputs) {
      // A chunk-shaped action merges through the provider reducer with the
      // outputs, and it names the assistant it amends, so it joins that
      // bucket rather than the one its own wire message opened. A message body
      // is already whole — merge its parts (the wire fans one part out per
      // event), deduped by part equality so a redelivered event adds nothing.
      if (input.kind === 'chunk') {
        bucketFor(input.payload.messageId).chunks.push(input.payload.chunk);
      } else if (input.kind === 'message') {
        if (bucket.message === undefined) {
          bucket.message = structuredClone(input.payload);
        } else {
          const existing = new Set(bucket.message.parts.map((part) => JSON.stringify(part)));
          for (const part of input.payload.parts) {
            if (!existing.has(JSON.stringify(part))) bucket.message.parts.push(part);
          }
        }
      }
    }
  }
  const messages: AI.UIMessage[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.message) {
      messages.push(bucket.message);
      continue;
    }
    if (bucket.chunks.length === 0) continue;
    const merged = await foldWithProviderReducer(bucket.chunks);
    if (merged) messages.push(merged);
  }
  return messages;
};

/**
 * The run-lifecycle events among the collected events, in delivery order.
 * @param events - The collected events.
 * @returns The run-lifecycle events.
 */
const lifecycleOf = (events: Event[]): RunLifecycleEvent[] =>
  events.flatMap((event) => (event.kind === 'run-lifecycle' ? [event.event] : []));

/**
 * The text of the first text part on a message.
 * @param message - The merged message.
 * @returns The text, or `undefined` when the message has no text part.
 */
const textOf = (message: AI.UIMessage | undefined): string | undefined => {
  const part = message?.parts.find((p): p is AI.TextUIPart => p.type === 'text');
  return part?.text;
};

/**
 * The body a browser POSTs to its own chat route: everything that crosses from
 * the client to the agent. A route knows only this, which is why the tests
 * below build the agent inside a route function rather than beside the client.
 */
interface ChatRequest {
  /** The conversation's channel. */
  channelName: string;
  /** The triggering input's event id, which the route locates in history. */
  eventId: string;
}

/**
 * Build a route's own agent transport, as a per-request serverless handler
 * would. Its attach point lands after the triggering input, which is what lets
 * `locateInput` reach that input in backwards-bounded history.
 * @param channelName - The conversation's channel.
 * @returns A connected agent transport.
 */
const routeAgent = async (channelName: string): Promise<AgentTransport<VercelInput, VercelOutput>> => {
  const agent = createAgentTransport<VercelInput, VercelOutput>({
    channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
    codec,
    clientId: 'agent',
  });
  await agent.connect();
  return agent;
};

/**
 * A route that answers a prompt with a fixed reply and ends the run. Used by
 * the tests whose subject is the client rather than the agent.
 * @param request - The POST body; see {@link ChatRequest}.
 * @param request.channelName - The conversation's channel.
 * @param request.eventId - The triggering input's event id.
 * @param reply - The assistant message id and text to answer with.
 * @param reply.id - The assistant message's domain id.
 * @param reply.text - The reply text.
 */
const answeringRoute = async (
  { channelName, eventId }: ChatRequest,
  reply: { id: string; text: string },
): Promise<void> => {
  const agent = await routeAgent(channelName);
  const input = await agent.locateInput(eventId);
  if (!input) throw new Error(`trigger ${eventId} not found in history`);
  const run = agent.openRun({ input });
  await run.pipe(textResponseStream(reply.id, `${reply.id}-t`, reply.text));
  await run.end({ reason: 'complete' });
  agent.close();
};

describe('standalone transport integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('a client sends a prompt and the agent answers it', async () => {
    const channelName = uniqueChannelName('t-turn');

    /**
     * The agent's route, in its own scope. It shares no variable with the
     * browser below: everything it needs arrives in the request, and
     * everything it produces goes onto the channel.
     * @param request - The POST body.
     * @param request.channelName - The conversation's channel.
     * @param request.eventId - The triggering input's event id.
     */
    const agentRoute = async ({ channelName: channel, eventId }: ChatRequest): Promise<void> => {
      const agent = await routeAgent(channel);

      // The route wakes with an event id and reads the input that woke it back
      // out of channel history.
      const input = await agent.locateInput(eventId);
      expect(input?.inputs).toEqual([
        { kind: 'message', payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello agent' }] } },
      ]);
      if (!input) return;

      // The input drives the open. Its run-id header decides a fresh start
      // against a re-entry, and its transport-message-id becomes the run's
      // anchor, which is what resolves the browser's `sent.runId`.
      const run = agent.openRun({ input });
      const streamed = await run.pipe(textResponseStream('a1', 't1', 'Hello human'));
      const ended = await run.end({ reason: 'complete' });

      expect(streamed.reason).toBe('complete');
      expect(ended.serial).toBeTypeOf('string');
      agent.close();
    };

    // ---- the browser -----------------------------------------------------
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();

    // The recorder collects every event the client receives, so the assertions
    // at the end of the test can read them back.
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);

    // publishInput answers with three things: the id the client owns right
    // now, the event id it POSTs to its own route, and a promise for the run
    // the agent has not opened yet.
    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello agent' }] },
    });

    // The browser fires the POST and carries on.
    const answered = agentRoute({ channelName, eventId: sent.eventId });

    // ---- the browser gets all live data from the channel -----------------
    const runId = await sent.runId;
    await received.waitFor((all) =>
      all.some((e) => e.kind === 'run-lifecycle' && e.event.type === 'end' && e.event.runId === runId),
    );

    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle.map((e) => e.type)).toEqual(['start', 'end']);
    expect(lifecycle.every((e) => e.runId === runId)).toBe(true);
    expect(lifecycle.every((e) => typeof e.serial === 'string')).toBe(true);
    expect(lifecycle[0]).toMatchObject({ inputTransportMessageId: sent.transportMessageId });
    expect(lifecycle[1]).toMatchObject({ reason: 'complete' });

    // Assembling a message is the application's job, so the test does it the
    // way an application does, through the provider's own reducer.
    const chunks = received.events.flatMap((e) => (e.kind === 'message' ? e.outputs : []));
    const assistant = await foldWithProviderReducer(chunks);
    expect(assistant?.id).toBe('a1');
    expect(textOf(assistant)).toBe('Hello human');

    // The route's own assertions surface here.
    await answered;
    client.close();
  });

  it('a client cancels a run while it is streaming', async () => {
    const channelName = uniqueChannelName('t-cancel');

    /**
     * A route whose stream never closes on its own, so only the cancel ends
     * it. That is what a long generation looks like from here.
     * @param request - The POST body.
     * @param request.channelName - The conversation's channel.
     * @param request.eventId - The triggering input's event id.
     */
    const cancellableRoute = async ({ channelName: channel, eventId }: ChatRequest): Promise<void> => {
      const agent = await routeAgent(channel);
      const input = await agent.locateInput(eventId);
      if (!input) return;
      const run = agent.openRun({ input });

      const streamed = await run.pipe(
        new ReadableStream<VercelOutput>({
          start: (controller) => {
            controller.enqueue({ type: 'start', messageId: 'a1' });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'thinking' });
          },
        }),
      );

      // The cancel reached the run through the channel and fired its signal.
      expect(streamed.reason).toBe('cancelled');
      expect(run.abortSignal.aborted).toBe(true);

      await run.end({ reason: 'cancelled' });
      agent.close();
    };

    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'write me an essay' }] },
    });
    const answered = cancellableRoute({ channelName, eventId: sent.eventId });

    // The user hits stop once they can see the reply starting.
    await received.waitFor((all) => all.some((e) => e.kind === 'message' && e.outputs.length > 0));
    await client.cancel(await sent.runId);

    const end = await received.waitForEvent((e) => e.kind === 'run-lifecycle' && e.event.type === 'end');
    expect(end.kind === 'run-lifecycle' && end.event).toMatchObject({ type: 'end', reason: 'cancelled' });

    await answered;
    client.close();
  });

  it('a client steers a run and both steering promises settle', async () => {
    const channelName = uniqueChannelName('t-steer');

    /**
     * A route that runs a real two-pass loop with explicit steps, because a
     * steer only reports `consumed` once the agent drains it and a later step
     * attempt stamps the drained ids.
     * @param request - The POST body.
     * @param request.channelName - The conversation's channel.
     * @param request.eventId - The triggering input's event id.
     */
    const steerableRoute = async ({ channelName: channel, eventId }: ChatRequest): Promise<void> => {
      const agent = await routeAgent(channel);

      // The route watches its own channel, so it can wait for the steer to
      // land rather than polling hasInput() on a clock.
      const observed = createEventRecorder<VercelInput, VercelOutput>();
      agent.subscribe(observed.record);

      const input = await agent.locateInput(eventId);
      if (!input) return;
      const run = agent.openRun({ input });

      // Pass one answers the triggering input. hasInput() is true until the
      // first output pass, and reading it drains anything pending.
      expect(run.hasInput()).toBe(true);
      const first = run.createStep();
      await first.pipe(textResponseStream('a1', 't1', 'a long answer'));
      await first.end();

      await observed.waitFor((all) =>
        all.some((e) =>
          e.kind === 'message' ? e.inputs.some((i) => i.kind === 'message' && i.payload.id === 'u-steer') : false,
        ),
      );

      // Pass two. This read drains the steer, and the next step attempt stamps
      // the drained ids, which is what lets the client resolve consumed.
      expect(run.hasInput()).toBe(true);
      const second = run.createStep();
      await second.pipe(textResponseStream('a2', 't2', 'briefly then'));
      await second.end();

      // Nothing further arrived, so the loop stops.
      expect(run.hasInput()).toBe(false);
      await run.end({ reason: 'complete' });
      agent.close();
    };

    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'explain everything' }] },
    });
    const answered = steerableRoute({ channelName, eventId: sent.eventId });

    // The user adds an instruction while the reply is already running.
    await received.waitFor((all) => all.some((e) => e.kind === 'message' && e.outputs.length > 0));
    const steer = client.steer(await sent.runId, {
      kind: 'message',
      payload: { id: 'u-steer', role: 'user', parts: [{ type: 'text', text: 'be brief' }] },
    });

    // `published` settles from the publish acknowledgement, so it needs no echo.
    const published = await steer.published;
    expect(published.serial).toBeTypeOf('string');

    // `outcome` settles at the run's terminal, and consumed is true because
    // the agent drained this steer and stamped it on the step that followed.
    await expect(steer.outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });

    await answered;
    client.close();
  });

  it('a client observes a run another participant started', async () => {
    const channelName = uniqueChannelName('t-observe');
    const channelFor = (): Parameters<typeof createClientTransport>[0]['channel'] =>
      ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } });

    // The participant who asks.
    const asking = createClientTransport<VercelInput, VercelOutput>({ channel: channelFor(), codec });
    // The participant who only watches. It publishes nothing for the whole test.
    const watching = createClientTransport<VercelInput, VercelOutput>({ channel: channelFor(), codec });
    await asking.connect();
    await watching.connect();

    const seen = createEventRecorder<VercelInput, VercelOutput>();
    watching.subscribe(seen.record);

    const sent = await asking.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is the weather' }] },
    });
    await answeringRoute({ channelName, eventId: sent.eventId }, { id: 'a1', text: 'four degrees' });

    // The watcher never called publishInput, so it holds no runId promise and
    // waits on the subscription alone.
    await seen.waitFor((all) => all.some((e) => e.kind === 'run-lifecycle' && e.event.type === 'end'));

    // It received the other participant's prompt, which is what lets it render
    // the question above the answer.
    const inputs = seen.events.flatMap((e) => (e.kind === 'message' ? e.inputs : []));
    expect(inputs).toContainEqual({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what is the weather' }] },
    });

    // And it received the reply, so both halves of a conversation it took no
    // part in are on its subscription.
    const chunks = seen.events.flatMap((e) => (e.kind === 'message' ? e.outputs : []));
    expect(chunks.some((c) => c.type === 'start' && c.messageId === 'a1')).toBe(true);

    asking.close();
    watching.close();
  });

  it('foreign traffic on a shared channel drives no run and still surfaces raw', async () => {
    const channelName = uniqueChannelName('t-foreign');
    // The name an application uses for traffic of its own on the same channel.
    const appNote = 'app-note';

    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();

    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);

    // The raw log a debug pane reads. Resolving off the handler keeps the wait
    // on an event rather than a clock, because foreign messages are classified
    // to nothing and so never reach the recorder.
    const raw: Ably.InboundMessage[] = [];
    let sawForeign = noop;
    const foreignArrived = new Promise<void>((resolve) => {
      sawForeign = resolve;
    });
    client.on('ably-message', (message) => {
      raw.push(message);
      if (raw.filter((m) => m.name === appNote || m.name === EVENT_RUN_START).length === 2) sawForeign();
    });

    // The application publishes its own traffic, straight onto the channel the
    // transport shares. The second one borrows a name the SDK uses for its own
    // wire: the classifier does branch on the name, so what keeps it inert is
    // that the run-lifecycle parse needs a run-id out of `extras.ai.transport`
    // and a message with no envelope carries none.
    const appChannel = ablyRealtimeClient().channels.get(channelName);
    await appChannel.publish(appNote, { note: 'a note from the app' });
    await appChannel.publish(EVENT_RUN_START, { runId: 'not-a-real-run' });
    await foreignArrived;

    // Neither was classified. Nothing has reached the event stream at all, so
    // the borrowed name minted no phantom run.
    expect(received.events).toEqual([]);

    // A real turn on the same channel still lands, so the filter discriminates
    // rather than dropping everything.
    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'still working?' }] },
    });
    await answeringRoute({ channelName, eventId: sent.eventId }, { id: 'a1', text: 'yes' });

    const runId = await sent.runId;
    await received.waitFor((all) => all.some((e) => e.kind === 'run-lifecycle' && e.event.type === 'end'));

    const lifecycle = lifecycleOf(received.events);
    expect(lifecycle.map((e) => e.type)).toEqual(['start', 'end']);
    expect([...new Set(lifecycle.map((e) => e.runId))]).toEqual([runId]);

    // Both foreign messages still reached the raw log, so an application
    // sharing the channel can read its own traffic back.
    expect(raw.map((m) => m.name)).toEqual(expect.arrayContaining([appNote, EVENT_RUN_START]));

    client.close();
  });

  it('tool call through the transport: the client resolution merges onto the assistant', async () => {
    const channelName = uniqueChannelName('t-tool');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'where am I?' }] },
    });
    await agent.connect();

    // Turn 1: the agent calls a client tool and suspends.
    const located = await agent.locateInput(sent.eventId);
    if (!located) throw new Error(`trigger ${sent.eventId} not found in history`);
    const run = agent.openRun({
      ...(located.meta.transportMessageId !== undefined && {
        inputTransportMessageId: located.meta.transportMessageId,
      }),
    });
    await run.pipe(
      new ReadableStream<VercelOutput>({
        start: (c) => {
          c.enqueue({ type: 'start', messageId: 'a1' });
          c.enqueue({ type: 'start-step' });
          c.enqueue({
            type: 'tool-input-available',
            toolCallId: 'tc-1',
            toolName: 'getLocation',
            input: {},
            dynamic: true,
          });
          c.close();
        },
      }),
    );
    await run.suspend();
    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'suspend'));

    // The assistant's transport-message-id, read off the wire like the useChat
    // adapter does.
    const assistantEvent = received.events.find(
      (e) => e.kind === 'message' && e.meta.runId === run.runId && e.outputs.length > 0,
    );
    const assistantId = assistantEvent?.kind === 'message' ? assistantEvent.meta.transportMessageId : undefined;
    if (assistantId === undefined) throw new Error('no assistant transport-message-id observed');

    // The client resolves the tool with the provider's own chunk, addressed to
    // the assistant, under the suspended run.
    await client.publishInput(
      {
        kind: 'chunk',
        payload: {
          messageId: assistantId,
          chunk: { type: 'tool-output-available', toolCallId: 'tc-1', output: { city: 'Berlin' }, dynamic: true },
        },
      },
      { runId: run.runId },
    );

    await received.waitFor((all) =>
      all.some((e) => e.kind === 'message' && e.inputs.some((input) => input.kind === 'chunk')),
    );

    const messages = await mergeMessages(received.events);
    const assistant = messages.find((m) => m.id === 'a1');
    const toolPart = assistant?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart?.state).toBe('output-available');
    if (toolPart?.state === 'output-available') {
      expect(toolPart.output).toEqual({ city: 'Berlin' });
    }
  });

  it('steering settles for a client that never receives its own publishes', async () => {
    // Why `published` resolves from the publish acknowledgement rather than
    // the steer's own channel echo: with echoMessages off there is no echo to
    // wait for.
    const channelName = uniqueChannelName('t-steer-noecho');
    const clientRealtime = ablyRealtimeClient({ echoMessages: false });
    const agentRealtime = ablyRealtimeClient();
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: clientRealtime.channels.get(channelName),
      codec,
    });
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: agentRealtime.channels.get(channelName),
      codec,
      clientId: 'agent',
    });
    await client.connect();
    await agent.connect();
    // The client's own subscription never sees its publishes here, so the
    // agent's is what confirms the steer reached the channel at all.
    const agentRecorder = createEventRecorder<VercelInput, VercelOutput>();
    agent.subscribe(agentRecorder.record);

    const run = agent.openRun();
    await run.pipe(textResponseStream('a1', 't1', 'thinking'));

    const steer = client.steer(run.runId, {
      kind: 'message',
      payload: { id: 'u-steer', role: 'user', parts: [{ type: 'text', text: 'be brief' }] },
    });

    // No echo arrives, so this can only have settled from the acknowledgement.
    const published = await steer.published;
    expect(published.serial).toBeDefined();

    await agentRecorder.waitFor((all) => all.some((e) => e.kind === 'message' && e.inputs.length > 0));

    // The outcome settles off the run's next lifecycle bracket, which the
    // agent publishes — so the client does receive that one.
    await run.end({ reason: 'complete' });
    await expect(steer.outcome).resolves.toBeDefined();
  });

  it('multi-run sequential: two turns land as two runs with disjoint events', async () => {
    const channelName = uniqueChannelName('t-multi');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });

    const first = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
    });
    await agent.connect();
    const locatedA = await agent.locateInput(first.eventId);
    if (!locatedA) throw new Error(`trigger ${first.eventId} not found in history`);
    const turnA = agent.openRun({ input: locatedA });
    await turnA.pipe(textResponseStream('a1', 't1', 'answer one'));
    await turnA.end({ reason: 'complete' });
    const runA = turnA.runId;
    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runA));

    const second = await client.publishInput({
      kind: 'message',
      payload: { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }] },
    });
    // A fresh invocation attaches after its trigger, like a real agent wake:
    // the locate scan is bounded at the attach point.
    const secondAgent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName),
      codec,
      clientId: 'agent',
    });
    await secondAgent.connect();
    const locatedB = await secondAgent.locateInput(second.eventId);
    if (!locatedB) throw new Error(`trigger ${second.eventId} not found in history`);
    const turnB = secondAgent.openRun({ input: locatedB });
    await turnB.pipe(textResponseStream('a2', 't2', 'answer two'));
    await turnB.end({ reason: 'complete' });
    const runB = turnB.runId;
    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runB));

    expect(runA).not.toBe(runB);
    const messages = await mergeMessages(received.events);
    expect(messages.map((message) => textOf(message))).toEqual(['one', 'answer one', 'two', 'answer two']);
    // Every assistant event names its own run.
    for (const event of received.events) {
      if (event.kind === 'message' && event.meta.transportMessageId === 'a2') {
        expect(event.meta.runId).toBe(runB);
      }
    }
  });

  it('concurrent runs: interleaved streams demultiplex by transport-message-id', async () => {
    const channelName = uniqueChannelName('t-concurrent');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });
    await agent.connect();

    const runA = agent.openRun();
    const runB = agent.openRun();
    await Promise.all([
      runA.pipe(textResponseStream('a1', 't1', 'from run A')),
      runB.pipe(textResponseStream('a2', 't2', 'from run B')),
    ]);
    await Promise.all([runA.end({ reason: 'complete' }), runB.end({ reason: 'complete' })]);

    await received.waitFor((all) => lifecycleOf(all).filter((e) => e.type === 'end').length === 2);

    const messages = await mergeMessages(received.events);
    const texts = messages.map((message) => textOf(message));
    expect(texts).toContain('from run A');
    expect(texts).toContain('from run B');
    expect(runA.runId).not.toBe(runB.runId);
  });

  it('history paging: a fresh client pages backwards to chronological batches', async () => {
    const channelName = uniqueChannelName('t-history');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'history please' }] },
    });
    await agent.connect();
    const located = await agent.locateInput(sent.eventId);
    if (!located) throw new Error(`trigger ${sent.eventId} not found in history`);
    const turn = agent.openRun({ input: located });
    await turn.pipe(textResponseStream('a1', 't1', 'remembered'));
    await turn.end({ reason: 'complete' });
    const runId = turn.runId;
    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runId));

    // A fresh transport (a reloaded page) sees nothing live and pages history.
    const lateRealtime = ablyRealtimeClient();
    const late = createClientTransport<VercelInput, VercelOutput>({
      channel: lateRealtime.channels.get(channelName),
      codec,
      historyPageSize: 3,
    });
    await late.connect();

    const all = await drainHistory(late);

    const messages = await mergeMessages(all);
    expect(messages.map((message) => textOf(message))).toEqual(['history please', 'remembered']);
    const lifecycle = lifecycleOf(all).map((e) => e.type);
    expect(lifecycle).toEqual(['start', 'end']);
  });

  it('a run streaming across the attach boundary merges to one message, not a duplicated prefix', async () => {
    const channelName = uniqueChannelName('t-boundary');
    const agentRealtime = ablyRealtimeClient();
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: agentRealtime.channels.get(channelName),
      codec,
    });
    await agent.connect();

    // First half streams before the client exists.
    const run = agent.openRun();
    let releaseSecondHalf: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      releaseSecondHalf = resolve;
    });
    const source = new ReadableStream<VercelOutput>({
      start: async (c) => {
        c.enqueue({ type: 'start', messageId: 'a1' });
        c.enqueue({ type: 'text-start', id: 't1' });
        c.enqueue({ type: 'text-delta', id: 't1', delta: 'first half ' });
        await gate;
        c.enqueue({ type: 'text-delta', id: 't1', delta: 'second half' });
        c.enqueue({ type: 'text-end', id: 't1' });
        c.close();
      },
    });
    // Wait for the first half to actually land, not for a fixed delay: a raw
    // listener on a throwaway client tells us the append is on the channel, so
    // the client below is guaranteed to attach mid-stream. A sleep here would
    // let a slow run attach after the whole stream and pass without ever
    // exercising the boundary this test is named for.
    const watcherRealtime = ablyRealtimeClient();
    const watcherChannel = watcherRealtime.channels.get(channelName);
    const firstHalfLanded = new Promise<void>((resolve) => {
      void watcherChannel.subscribe((message) => {
        if (typeof message.data === 'string' && message.data.includes('first half')) resolve();
      });
    });
    await watcherChannel.attach();

    const pipePromise = run.pipe(source);
    await firstHalfLanded;

    // The client attaches mid-stream, subscribes, then hydrates the gap.
    const clientRealtime = ablyRealtimeClient();
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: clientRealtime.channels.get(channelName),
      codec,
    });
    await client.connect();
    const liveRecorder = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(liveRecorder.record);

    const history = await drainHistory(client);

    releaseSecondHalf();
    await pipePromise;
    await run.end({ reason: 'complete' });
    await liveRecorder.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));

    // History and live share one decoder: merging history-then-live in
    // delivery order yields ONE message with the full text — no duplicated
    // prefix, no dedup needed.
    const messages = await mergeMessages([...history, ...liveRecorder.events]);
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toBe('first half second half');
  });

  it('error propagation: a run ending in error reaches the client with the error detail', async () => {
    const channelName = uniqueChannelName('t-error');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });
    await agent.connect();

    const run = agent.openRun();
    await run.pipe(
      new ReadableStream<VercelOutput>({
        start: (c) => {
          c.enqueue({ type: 'start', messageId: 'a1' });
          c.close();
        },
      }),
    );
    const { ErrorInfo } = await import('ably');
    await run.end({
      reason: 'error',
      error: new ErrorInfo('model exploded', ErrorCode.RunResponseStreamFailed, 500),
    });

    await received.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));
    const end = lifecycleOf(received.events).find((e) => e.type === 'end');
    expect(end).toMatchObject({ type: 'end', reason: 'error' });
    const message = end?.type === 'end' && end.reason === 'error' ? end.error.message : undefined;
    expect(message).toContain('model exploded');
  });

  it('durable cross-process re-entry: a second transport ends the run via adoptRun', async () => {
    const channelName = uniqueChannelName('t-durable');
    const client = createClientTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
    });
    await client.connect();
    const received = createEventRecorder<VercelInput, VercelOutput>();
    client.subscribe(received.record);
    const agent = createAgentTransport<VercelInput, VercelOutput>({
      channel: ablyRealtimeClient().channels.get(channelName, { params: { agent: channelAgent(codec) } }),
      codec,
      clientId: 'agent',
    });
    await agent.connect();

    // Process 1 opens the run and streams, then hands off without a terminal.
    const run = agent.openRun();
    await run.pipe(textResponseStream('a1', 't1', 'durable turn'));
    agent.close();

    // Process 2 attaches without publishing, gates on history, and ends.
    const secondRealtime = ablyRealtimeClient();
    const second = createAgentTransport<VercelInput, VercelOutput>({
      channel: secondRealtime.channels.get(channelName),
      codec,
    });
    await second.connect();
    const all = await drainHistory(second);
    const lastLifecycle = lifecycleOf(all).findLast((e) => e.runId === run.runId);
    expect(lastLifecycle?.type).toBe('start');

    const adopted = second.adoptRun(run.runId);
    await adopted.end({ reason: 'complete' });

    await received.waitFor((list) => lifecycleOf(list).some((e) => e.type === 'end'));
    const lifecycle = lifecycleOf(received.events).map((e) => e.type);
    // Exactly one open and one terminal: the re-entry published nothing extra.
    expect(lifecycle).toEqual(['start', 'end']);
  });
});
