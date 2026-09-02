/**
 * Transport-level integration: history paging and the attach boundary, over
 * real Ably. Both scenarios share the seed-then-attach-late arrangement.
 *
 * Paging: a fresh client pages backwards from its attach point and receives
 * chronological batches of classified events, each call a strictly older
 * slice, with a completed stream folded out of history as ONE delta carrying
 * the whole text (the platform returns the aggregate). Messages published
 * after the attach point stay outside the `untilAttach` window.
 *
 * Attach boundary: a run streaming across a late client's attach point yields
 * one message's worth of events. The live fold and the history walk share a
 * decoder, so the spanning message comes back from history carrying its
 * metadata and no events — the accumulated prefix is delivered once, never
 * twice.
 *
 * Serials are compared lexicographically and never parsed; every await is an
 * event, never a clock. Calling history() mid-stream is a different contract
 * (a live aggregate above the tracker's version legitimately re-delivers
 * content) — these tests await the run terminal first, deliberately.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentTransport, ClientTransport, TransportEvent } from '../../../src/index.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients } from '../../helper/realtime-client.js';
import { manualStream } from '../../helper/streams.js';
import {
  type EventRecorder,
  eventShape,
  isInputFor,
  isRunLifecycle,
  outputsOf,
  recordEvents,
} from '../../helper/transport-events.js';
import {
  closeAllTransports,
  createAgentEndpoint,
  createClientEndpoint,
  type TransportEndpoint,
} from '../../helper/transport-pair.js';
import { textOfChunks, textResponseChunks } from '../../helper/vercel-chunks.js';

type Event = TransportEvent<VercelInput, VercelOutput>;

/**
 * The serial ordering key of one classified event.
 * @param event - The event to key.
 * @returns The serial (empty string for an optimistic local event).
 */
const serialOf = (event: Event): string => {
  if (event.kind === 'message') return event.meta.serial ?? '';
  return event.event.serial ?? '';
};

/** The classified-event shape one complete seeded turn folds out of history as. */
const TURN_SHAPE = [
  'message[in:message]',
  'run:start',
  'step:step-start',
  'message[out:start]',
  'message[out:start-step]',
  'message[out:text-start out:text-delta out:text-end]',
  'message[out:finish]',
  'step:step-end',
  'run:end',
];

/**
 * Run one complete turn: publish an input, open a run naming it on the
 * agent's live observation, stream a fixture response, end the run.
 * @param agent - The agent endpoint.
 * @param agentEvents - The agent's recorder (attached before any publish).
 * @param sender - The client endpoint publishing the input.
 * @param index - Turn index, used for per-turn ids and text.
 * @returns The turn's identifiers.
 */
const seedTurn = async (
  agent: TransportEndpoint<AgentTransport<VercelInput, VercelOutput>>,
  agentEvents: EventRecorder<VercelInput, VercelOutput>,
  sender: TransportEndpoint<ClientTransport<VercelInput, VercelOutput>>,
  index: number,
): Promise<{ runId: string; codecMessageId: string }> => {
  const message: AI.UIMessage = {
    id: `user-${String(index)}`,
    role: 'user',
    parts: [{ type: 'text', text: `question ${String(index)}` }],
  };
  const sent = await sender.transport.publishInput({ kind: 'message', payload: message });
  await agentEvents.next(isInputFor(sent.codecMessageId));
  const run = agent.transport.openRun({ inputCodecMessageId: sent.codecMessageId });
  await run.pipe(textResponseChunks(`asst-${String(index)}`, `text-${String(index)}`, `answer ${String(index)}`));
  await run.end({ reason: 'complete' });
  return { runId: run.runId, codecMessageId: sent.codecMessageId };
};

/**
 * Page a client's history to exhaustion.
 * @param client - The client transport to page.
 * @returns The batches in call order (newest slice first).
 */
const pageToExhaustion = async (client: ClientTransport<VercelInput, VercelOutput>): Promise<Event[][]> => {
  const batches: Event[][] = [];
  for (;;) {
    const batch = await client.history({ limit: 1 });
    batches.push(batch.events);
    if (batch.exhausted) return batches;
  }
};

describe('transport history over real Ably', () => {
  afterEach(() => {
    closeAllTransports();
    closeAllClients();
  });

  it('pages backwards in chronological batches, ending at the attach point', async () => {
    const channelName = uniqueChannelName('transport-history-paging');
    const agent = await createAgentEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const sender = await createClientEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const agentEvents = recordEvents(agent.transport);

    const turns = [];
    for (let index = 1; index <= 3; index++) {
      turns.push(await seedTurn(agent, agentEvents, sender, index));
    }

    // The fresh client attaches after the seeded turns. A small page size
    // against ~27 wire messages forces genuine multi-page paging.
    const fresh = await createClientEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
      historyPageSize: 6,
    });
    const freshEvents = recordEvents(fresh.transport);

    // A post-attach sentinel, awaited on the fresh client's own live stream:
    // it proves the client is attached and delivering, puts a full server
    // round trip between the last seeded ack and the history query, and is
    // the one message the untilAttach window must exclude.
    const sentinel = await sender.transport.publishInput({
      kind: 'message',
      payload: { id: 'sentinel', role: 'user', parts: [{ type: 'text', text: 'after the attach point' }] },
    });
    await freshEvents.next(isInputFor(sentinel.codecMessageId));

    const batches = await pageToExhaustion(fresh.transport);
    const chronological = batches.toReversed().flat();

    // Paging genuinely happened, and limit is page-granular: every batch is
    // non-empty and holds at most one page's worth of events. Never a
    // hardcoded page count — Ably may split pages differently.
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(6);
    }

    // Chronological within a batch and across the whole walk (lexicographic
    // serial comparison), and each later call returned a strictly older slice.
    for (const batch of batches) {
      for (let i = 1; i < batch.length; i++) {
        const prev = batch[i - 1];
        const curr = batch[i];
        if (!prev || !curr) throw new Error('unexpected batch hole');
        expect(serialOf(prev) < serialOf(curr)).toBe(true);
      }
    }
    for (let i = 0; i + 1 < batches.length; i++) {
      const newer = batches[i];
      const older = batches[i + 1];
      const oldestOfNewer = newer?.at(0);
      const newestOfOlder = older?.at(-1);
      if (!oldestOfNewer || !newestOfOlder) throw new Error('unexpected empty batch');
      expect(serialOf(newestOfOlder) < serialOf(oldestOfNewer)).toBe(true);
    }

    // The whole walk is three complete turns, in order — a completed stream
    // folds out of history as ONE delta carrying the whole text.
    expect(chronological.map((event) => eventShape(event))).toEqual([...TURN_SHAPE, ...TURN_SHAPE, ...TURN_SHAPE]);
    for (const [index, turn] of turns.entries()) {
      const slice = chronological.slice(index * TURN_SHAPE.length, (index + 1) * TURN_SHAPE.length);
      const start = slice[1];
      if (start?.kind !== 'run-lifecycle') throw new Error('expected run-start');
      expect(start.event.runId).toBe(turn.runId);
      expect(textOfChunks(outputsOf(slice))).toBe(`answer ${String(index + 1)}`);
    }

    // The post-attach sentinel stays outside the untilAttach window, and the
    // exhausted cursor stays exhausted.
    expect(
      chronological.some((event) => event.kind === 'message' && event.meta.codecMessageId === sentinel.codecMessageId),
    ).toBe(false);
    await expect(fresh.transport.history({ limit: 1 })).resolves.toEqual({ events: [], exhausted: true });
  });

  it('yields one message worth of events for a run streaming across the attach point', async () => {
    const channelName = uniqueChannelName('transport-attach-boundary');
    const agent = await createAgentEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const agentEvents = recordEvents(agent.transport);

    const source = manualStream<AI.UIMessageChunk>();
    const push = (chunk: AI.UIMessageChunk): void => {
      source.push(chunk);
    };
    const run = agent.transport.openRun();
    // Held, not awaited: the pipe resolves only when the source closes. An
    // early await here deadlocks into the test timeout.
    const piped = run.pipe(source.stream);

    push({ type: 'start', messageId: 'asst-1' });
    push({ type: 'start-step' });
    push({ type: 'text-start', id: 'text-1' });
    push({ type: 'text-delta', id: 'text-1', delta: 'the prefix ' });

    // The barrier: appends are fire-and-forget, so nothing in the agent API
    // reports the delta landing — but the agent subscribes to the same
    // channel, and its own echo of the append IS the ack. The late client's
    // attach is then provably after the create and first delta, and provably
    // before everything still unpushed. (If echo-on-publish is ever disabled
    // for the agent connection, use a witness ClientTransport instead.)
    await agentEvents.next(
      (event) => event.kind === 'message' && event.outputs.some((chunk) => chunk.type === 'text-delta'),
    );

    const late = await createClientEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const lateEvents = recordEvents(late.transport);

    push({ type: 'text-delta', id: 'text-1', delta: 'and the tail' });
    push({ type: 'text-end', id: 'text-1' });
    push({ type: 'finish' });
    source.close();
    await piped;
    await run.end({ reason: 'complete' });

    const live = await lateEvents.until(isRunLifecycle('end', run.runId));

    // The pre-attach `start` / `start-step` wires were never delivered live —
    // the client attached mid-run — so the decoder SYNTHESISES them on first
    // contact with the in-flight stream (the mid-stream-join repair the
    // provider's strict reducer requires), and the platform's
    // first-post-attach conversion delivers the accumulated prefix. The full
    // text arrives exactly once; the concatenation is the contract, never the
    // delta count.
    const liveOutputs = outputsOf(live);
    expect(liveOutputs.filter((chunk) => chunk.type !== 'text-delta').map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-end',
      'finish',
    ]);
    expect(textOfChunks(liveOutputs)).toBe('the prefix and the tail');
    const liveLifecycle = live.filter((event) => event.kind !== 'message');
    expect(liveLifecycle.map((event) => eventShape(event))).toEqual(['step:step-end', 'run:end']);

    // The history walk returns the pre-attach wire messages the client never
    // saw live: the run bracket, then the REAL `start` / `start-step` openers
    // (the synthesised live ones were the stopgap; dedup suppresses synthetic
    // re-emission, never real wires). The spanning stream — created before the
    // attach point, still appending after it — is at the platform's
    // discretion to include in the untilAttach window: when returned it is a
    // fifth, metadata-only `message[]` entry contributing ZERO events, because
    // the shared decoder already folded its content live. Either way, no
    // content re-delivers — that is the duplicated-prefix regression, pinned
    // unconditionally below.
    const batches = await pageToExhaustion(late.transport);
    const chronological = batches.toReversed().flat();
    const shapes = chronological.map((event) => eventShape(event));
    expect(shapes.slice(0, 4)).toEqual([
      'run:start',
      'step:step-start',
      'message[out:start]',
      'message[out:start-step]',
    ]);
    expect(shapes.length).toBeLessThanOrEqual(5);
    if (shapes.length === 5) {
      // Same wire message, folded once: the metadata-only entry carries the
      // live stream's own serial.
      expect(shapes[4]).toBe('message[]');
      const spanning = chronological.at(-1);
      const liveTextEvent = live.find(
        (event) => event.kind === 'message' && event.outputs.some((chunk) => chunk.type === 'text-start'),
      );
      if (spanning?.kind !== 'message' || liveTextEvent?.kind !== 'message') {
        throw new Error('expected message events');
      }
      expect(spanning.meta.serial).toBe(liveTextEvent.meta.serial);
    }
    expect(outputsOf(chronological).some((chunk) => chunk.type === 'text-delta')).toBe(false);

    // The union a real consumer assembles carries the text exactly once.
    expect(textOfChunks([...outputsOf(chronological), ...liveOutputs])).toBe('the prefix and the tail');
  });
});
