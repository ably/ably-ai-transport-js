/**
 * getExistingMessages — the agent's model context, read off the channel.
 *
 * Pages a transport's channel history to exhaustion and merges it through the
 * same merge helper the frontend renders with, so the model sees the
 * conversation exactly as the UI does.
 *
 * The channel is the right source for the agent specifically. It is already
 * attached, and the input that woke it was published there moments ago — a
 * store the client writes after a run cannot hold it yet. The client hydrates
 * the other way round, out of the demo's conversation store (see
 * `message-store.ts`), which is why nothing in the read path of
 * `GET /api/messages` touches Ably.
 */

import type { AgentTransport, TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import { createThreadMerge, type ThreadMessage, type ThreadSnapshot } from './merge-thread';
import type { OpenAIInput } from './openai-thread';

/** One decoded transport event at the demo's codec instantiation. */
export type ThreadEvent = TransportEvent<OpenAIInput, OpenAIOutput>;

/** What {@link getExistingMessages} returns. */
export interface ExistingMessages {
  /** Every decoded event, oldest first — what a client-side merge consumes. */
  events: ThreadEvent[];
  /** The merged thread, oldest message first — what the model context consumes. */
  messages: ThreadMessage[];
  /**
   * The channel serial of the newest event included, or `undefined` for an
   * empty conversation.
   */
  latestSerial: string | undefined;
}

/**
 * The serial an event rides the channel under: a message event's wire serial,
 * or a lifecycle event's own serial.
 * @param event - The decoded event.
 * @returns The serial, or `undefined` (a locally synthesised event has none).
 */
export const serialOf = (event: ThreadEvent): string | undefined =>
  event.kind === 'message' ? event.meta.serial : event.event.serial;

/**
 * The events that can safely be stored for a later client to seed from, and
 * the watermark that goes with them.
 *
 * A run that has not ended is deliberately withheld. Its output is still
 * arriving, so a client that seeded it would also receive the rest live — and
 * the two sides decode it with different decoder instances, where a decoder's
 * first contact with a stream in progress synthesises the whole accumulated
 * prefix as one delta. Seeding that prefix as well as receiving it live counts
 * the text twice, with nothing downstream able to tell the two apart. Keeping
 * the open run out of the store means the next client's own history walk and
 * live subscription own it end to end, decoded once.
 *
 * The watermark moves back accordingly: it is the newest serial among the
 * events that ARE stored, so a client's gap walk picks the open run up.
 * @param events - Every decoded event, oldest first.
 * @returns The storable events and the serial they run up to.
 */
export const seedableEvents = (events: ThreadEvent[]): { events: ThreadEvent[]; latestSerial: string | undefined } => {
  const endedRuns = new Set<string>();
  for (const event of events) {
    if (event.kind === 'run-lifecycle' && event.event.type === 'end') endedRuns.add(event.event.runId);
  }
  const runOf = (event: ThreadEvent): string | undefined =>
    event.kind === 'message' ? event.meta.runId : event.event.runId;
  const seedable = events.filter((event) => {
    const runId = runOf(event);
    return runId === undefined || endedRuns.has(runId);
  });

  let latestSerial: string | undefined;
  for (let i = seedable.length - 1; i >= 0 && latestSerial === undefined; i--) {
    const event = seedable[i];
    if (event) latestSerial = serialOf(event);
  }
  return { events: seedable, latestSerial };
};

/**
 * The merged thread that can safely be stored, and the watermark that goes
 * with it: {@link seedableEvents} filtered down to the runs that have ended,
 * merged the same way the whole conversation is.
 *
 * Merging twice rather than trimming the finished thread is deliberate. A
 * message the open run contributed to has to be absent from the store
 * entirely, not present in a half-merged state — the next client decodes that
 * run off the channel from its start, and a stored prefix would be counted
 * twice.
 * @param existing - The whole conversation, as {@link getExistingMessages} read it.
 * @returns The storable thread, its runs, and the serial it is complete up to.
 */
export const storableConversation = (existing: ExistingMessages): ThreadSnapshot & { latestSerial?: string } => {
  const storable = seedableEvents(existing.events);
  const merge = createThreadMerge();
  for (const event of storable.events) merge.apply(event);
  return {
    messages: merge.messages(),
    runs: [...merge.runs()],
    ...(storable.latestSerial === undefined ? {} : { latestSerial: storable.latestSerial }),
  };
};

/**
 * Page the whole existing conversation off the channel and merge it.
 * @param transport - A connected transport whose `history()` to page.
 * @returns The decoded events, the merged thread, and the hydration seam.
 */
export const getExistingMessages = async (
  transport: Pick<AgentTransport<OpenAIInput, OpenAIOutput>, 'history'>,
): Promise<ExistingMessages> => {
  const events: ThreadEvent[] = [];
  let exhausted = false;
  while (!exhausted) {
    const batch = await transport.history();
    // The merge consumes events in chronological order, and each batch is older
    // than the previous one — so collect by prepending, then merge once whole.
    events.unshift(...batch.events);
    exhausted = batch.exhausted;
  }

  const merge = createThreadMerge();
  for (const event of events) merge.apply(event);

  // Delivery order is chronological, so the newest serial is the last one an
  // event carries.
  let latestSerial: string | undefined;
  for (let i = events.length - 1; i >= 0 && latestSerial === undefined; i--) {
    const event = events[i];
    if (event) latestSerial = serialOf(event);
  }

  return { events, messages: merge.messages(), latestSerial };
};
