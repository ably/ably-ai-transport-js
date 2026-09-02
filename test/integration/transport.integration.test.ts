/**
 * Standalone-transport integration tests over real Ably.
 *
 * Prove the full send → stream → receive lifecycle through
 * `createClientTransport` and `createAgentTransport`, with the Vercel codec on
 * the wire and message assembly done the way an application does it: bucket
 * the classified events by transport-message-id and merge each bucket through the
 * provider's own reducer (`readUIMessageStream`). The SDK merges nothing.
 *
 * Scenarios follow the testing strategy's list — text roundtrip through the
 * transport, a tool call resolved by the client, the cancel chain, sequential
 * and concurrent runs, history paging, a run streaming across the attach
 * boundary (the shared-decoder contract: one message, not a duplicated
 * prefix), error propagation, multi-client sync, and a durable cross-process
 * re-entry via `adoptRun`.
 */

import '../helper/expectations.js';

import * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentTransport } from '../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../src/core/transport/client-transport.js';
import type {
  AgentTransport,
  ClientTransport,
  LocatedInput,
  RunLifecycleEvent,
  TransportEvent,
} from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import type { VercelInput, VercelOutput } from '../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../helper/identifier.js';
import { ablyRealtimeClient, closeAllClients } from '../helper/realtime-client.js';
import { foldWithProviderReducer } from '../helper/ui-message-fold.js';
import { createEventRecorder, drainHistory, textResponseStream } from './helpers.js';

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
  for (const event of events) {
    if (event.kind !== 'message') continue;
    const id = event.meta.transportMessageId;
    if (id === undefined) continue;
    const bucket = buckets.get(id) ?? { chunks: [] };
    buckets.set(id, bucket);
    bucket.chunks.push(...event.outputs);
    for (const input of event.inputs) {
      // A chunk-shaped action merges through the provider reducer with the
      // outputs; a message body is already whole — merge its parts (the wire
      // fans one part out per event), deduped by part equality so a
      // redelivered event adds nothing.
      if (input.kind === 'chunk') {
        bucket.chunks.push(input.payload);
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

interface Fixture {
  channelName: string;
  client: ClientTransport<VercelInput, VercelOutput>;
  agent: AgentTransport<VercelInput, VercelOutput>;
  events: Event[];
  /** Resolve once the predicate holds over the client's events. */
  waitFor: (predicate: (events: Event[]) => boolean) => Promise<void>;
}

/**
 * A client + agent transport pair on a fresh channel, with the client
 * connected and its classified events collected. The agent is connected only
 * when `connectAgent` is not `false`: a turn-driven scenario publishes its
 * trigger first and connects the agent after, the way an invocation POST
 * wakes a real agent — `locateInput` scans history bounded at the attach
 * point, so the trigger must precede the attach.
 * @param prefix - The channel-name prefix for this scenario.
 * @param opts - Optional setup shape.
 * @param opts.connectAgent - Set `false` to leave the agent unconnected.
 * @returns The fixture.
 */
const setup = async (prefix: string, opts?: { connectAgent?: boolean }): Promise<Fixture> => {
  const channelName = uniqueChannelName(prefix);
  const clientRealtime = ablyRealtimeClient();
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
  if (opts?.connectAgent !== false) await agent.connect();
  const recorder = createEventRecorder<VercelInput, VercelOutput>();
  client.subscribe(recorder.record);
  return { channelName, client, agent, events: recorder.events, waitFor: recorder.waitFor };
};

/**
 * Locate the input that woke this invocation.
 *
 * No retry and no sleep: the trigger is published before the agent attaches,
 * and `locateInput` scans history bounded at the attach point, so the platform
 * has already persisted it by the time the attach completes.
 * @param agent - The connected agent transport.
 * @param eventId - The triggering input's event id.
 * @returns The located trigger.
 */
const locateTrigger = async (
  agent: AgentTransport<VercelInput, VercelOutput>,
  eventId: string,
): Promise<LocatedInput<VercelInput>> => {
  const located = await agent.locateInput(eventId);
  if (!located) throw new Error(`trigger ${eventId} not found in history`);
  return located;
};

/**
 * Run one full agent turn: locate the input, open the run threading the
 * trigger, pipe the source, and end complete.
 * @param agent - The agent transport.
 * @param eventId - The triggering input's event id.
 * @param source - The output stream to pipe.
 * @returns The run's id.
 */
const runAgentTurn = async (
  agent: AgentTransport<VercelInput, VercelOutput>,
  eventId: string,
  source: ReadableStream<VercelOutput>,
): Promise<string> => {
  const located = await locateTrigger(agent, eventId);
  const run = agent.openRun({
    ...(located.meta.transportMessageId !== undefined && { inputTransportMessageId: located.meta.transportMessageId }),
  });
  await run.pipe(source);
  await run.end({ reason: 'complete' });
  return run.runId;
};

describe('standalone transport integration', () => {
  afterEach(() => {
    closeAllClients();
  });

  it('send → stream → receive: a text turn round-trips and merges through the provider reducer', async () => {
    const { client, agent, events, waitFor } = await setup('t-text', { connectAgent: false });

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello agent' }] },
    });
    await agent.connect();
    const runId = await runAgentTurn(agent, sent.eventId, textResponseStream('a1', 't1', 'Hello human'));

    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runId));

    // The client's runId watch resolved from the run's start event.
    await expect(sent.runId).resolves.toBe(runId);

    const messages = await mergeMessages(events);
    // First-seen bucket order is conversation order: the user's own input
    // coming back off the channel, then the assistant.
    expect(messages).toHaveLength(2);
    expect(textOf(messages[0])).toBe('hello agent');
    expect(textOf(messages[1])).toBe('Hello human');
    expect(messages[1]?.id).toBe('a1');

    const lifecycle = lifecycleOf(events).map((e) => e.type);
    expect(lifecycle).toEqual(['start', 'end']);
  }, 45_000);

  it('tool call through the transport: the client resolution merges onto the assistant', async () => {
    const { client, agent, events, waitFor } = await setup('t-tool', { connectAgent: false });

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'where am I?' }] },
    });
    await agent.connect();

    // Turn 1: the agent calls a client tool and suspends.
    const located = await locateTrigger(agent, sent.eventId);
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
    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'suspend'));

    // The assistant's transport-message-id, read off the wire like the useChat
    // adapter does.
    const assistantEvent = events.find(
      (e) => e.kind === 'message' && e.meta.runId === run.runId && e.outputs.length > 0,
    );
    const assistantId = assistantEvent?.kind === 'message' ? assistantEvent.meta.transportMessageId : undefined;
    if (assistantId === undefined) throw new Error('no assistant transport-message-id observed');

    // The client resolves the tool with the provider's own chunk, addressed to
    // the assistant, under the suspended run.
    await client.publishInput(
      {
        kind: 'chunk',
        payload: { type: 'tool-output-available', toolCallId: 'tc-1', output: { city: 'Berlin' }, dynamic: true },
      },
      { transportMessageId: assistantId, runId: run.runId },
    );

    await waitFor((all) => all.some((e) => e.kind === 'message' && e.inputs.some((input) => input.kind === 'chunk')));

    const messages = await mergeMessages(events);
    const assistant = messages.find((m) => m.id === 'a1');
    const toolPart = assistant?.parts.find((p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool');
    expect(toolPart?.state).toBe('output-available');
    if (toolPart?.state === 'output-available') {
      expect(toolPart.output).toEqual({ city: 'Berlin' });
    }
  }, 45_000);

  it('cancel chain: a client cancel aborts the agent stream and the run ends cancelled', async () => {
    const { client, agent, events, waitFor } = await setup('t-cancel');

    const run = agent.openRun();
    // A stream that never closes on its own — only the cancel ends it.
    const openStream = new ReadableStream<VercelOutput>({
      start: (c) => {
        c.enqueue({ type: 'start', messageId: 'a1' });
        c.enqueue({ type: 'text-start', id: 't1' });
        c.enqueue({ type: 'text-delta', id: 't1', delta: 'streaming…' });
      },
    });
    const pipePromise = run.pipe(openStream);

    await waitFor((all) => all.some((e) => e.kind === 'message' && e.outputs.length > 0));
    await client.cancel(run.runId);

    const result = await pipePromise;
    expect(result.reason).toBe('cancelled');
    expect(run.abortSignal.aborted).toBe(true);
    await run.end({ reason: 'cancelled' });

    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));
    const end = lifecycleOf(events).find((e) => e.type === 'end');
    expect(end).toMatchObject({ type: 'end', reason: 'cancelled' });
  }, 45_000);

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
  }, 45_000);

  it('multi-run sequential: two turns land as two runs with disjoint events', async () => {
    const { client, agent, events, channelName, waitFor } = await setup('t-multi', { connectAgent: false });

    const first = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
    });
    await agent.connect();
    const runA = await runAgentTurn(agent, first.eventId, textResponseStream('a1', 't1', 'answer one'));
    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runA));

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
    const runB = await runAgentTurn(secondAgent, second.eventId, textResponseStream('a2', 't2', 'answer two'));
    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runB));

    expect(runA).not.toBe(runB);
    const messages = await mergeMessages(events);
    expect(messages.map((message) => textOf(message))).toEqual(['one', 'answer one', 'two', 'answer two']);
    // Every assistant event names its own run.
    for (const event of events) {
      if (event.kind === 'message' && event.meta.transportMessageId === 'a2') {
        expect(event.meta.runId).toBe(runB);
      }
    }
  }, 45_000);

  it('concurrent runs: interleaved streams demultiplex by transport-message-id', async () => {
    const { agent, events, waitFor } = await setup('t-concurrent');

    const runA = agent.openRun();
    const runB = agent.openRun();
    await Promise.all([
      runA.pipe(textResponseStream('a1', 't1', 'from run A')),
      runB.pipe(textResponseStream('a2', 't2', 'from run B')),
    ]);
    await Promise.all([runA.end({ reason: 'complete' }), runB.end({ reason: 'complete' })]);

    await waitFor((all) => lifecycleOf(all).filter((e) => e.type === 'end').length === 2);

    const messages = await mergeMessages(events);
    const texts = messages.map((message) => textOf(message));
    expect(texts).toContain('from run A');
    expect(texts).toContain('from run B');
    expect(runA.runId).not.toBe(runB.runId);
  }, 45_000);

  it('history paging: a fresh client pages backwards to chronological batches', async () => {
    const { client, agent, channelName, waitFor } = await setup('t-history', { connectAgent: false });

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'history please' }] },
    });
    await agent.connect();
    const runId = await runAgentTurn(agent, sent.eventId, textResponseStream('a1', 't1', 'remembered'));
    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runId));

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
  }, 45_000);

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
  }, 45_000);

  it('error propagation: a run ending in error reaches the client with the error detail', async () => {
    const { agent, events, waitFor } = await setup('t-error');

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

    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end'));
    const end = lifecycleOf(events).find((e) => e.type === 'end');
    expect(end).toMatchObject({ type: 'end', reason: 'error' });
    const message = end?.type === 'end' && end.reason === 'error' ? end.error.message : undefined;
    expect(message).toContain('model exploded');
  }, 45_000);

  it('multi-client sync: two clients on one channel both merge the streamed response', async () => {
    const { client, agent, channelName, events, waitFor } = await setup('t-sync', { connectAgent: false });

    const otherRealtime = ablyRealtimeClient();
    const other = createClientTransport<VercelInput, VercelOutput>({
      channel: otherRealtime.channels.get(channelName),
      codec,
    });
    await other.connect();
    const otherRecorder = createEventRecorder<VercelInput, VercelOutput>();
    other.subscribe(otherRecorder.record);

    const sent = await client.publishInput({
      kind: 'message',
      payload: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'sync?' }] },
    });
    await agent.connect();
    const runId = await runAgentTurn(agent, sent.eventId, textResponseStream('a1', 't1', 'synced'));

    await waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runId));
    await otherRecorder.waitFor((all) => lifecycleOf(all).some((e) => e.type === 'end' && e.runId === runId));

    const merged = await mergeMessages(events);
    const otherMerged = await mergeMessages(otherRecorder.events);
    expect(textOf(merged.at(-1))).toBe('synced');
    expect(textOf(otherMerged.at(-1))).toBe('synced');
  }, 45_000);

  it('durable cross-process re-entry: a second transport ends the run via adoptRun', async () => {
    const { agent, events, channelName, waitFor } = await setup('t-durable');

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

    await waitFor((list) => lifecycleOf(list).some((e) => e.type === 'end'));
    const lifecycle = lifecycleOf(events).map((e) => e.type);
    // Exactly one open and one terminal: the re-entry published nothing extra.
    expect(lifecycle).toEqual(['start', 'end']);
  }, 45_000);
});
