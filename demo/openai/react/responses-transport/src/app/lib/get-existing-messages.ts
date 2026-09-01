/**
 * getExistingMessages — the demo's one swappable history source.
 *
 * Pages a transport's channel history to exhaustion and folds it through the
 * same fold helper the frontend renders with. Both readers of the existing
 * conversation go through here: the chat route (model context) and the
 * messages endpoint (client hydration). Swapping the channel for a database
 * later means reimplementing only this function — its callers already consume
 * the returned shape.
 */

import type { AgentTransport, TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import { createThreadFold, type ThreadMessage } from './fold-thread';

/** One decoded transport event at the demo's codec instantiation. */
export type ThreadEvent = TransportEvent<unknown, OpenAIOutput>;

/** What {@link getExistingMessages} returns. */
export interface ExistingMessages {
  /** Every decoded event, oldest first — what a client-side fold consumes. */
  events: ThreadEvent[];
  /** The folded thread, oldest message first — what the model context consumes. */
  messages: ThreadMessage[];
  /**
   * The channel serial of the newest event included, or `undefined` for an
   * empty conversation. The model-context reader ignores it; the hydration
   * reader takes its seam from {@link seedableEvents} instead, which moves it
   * back past any run still streaming.
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
 * The events a hydrating client can safely be seeded with, and the seam that
 * goes with them.
 *
 * A run that has not ended is deliberately withheld. Its output is still
 * arriving, and the client is already receiving it live — but the two sides
 * decode it with different decoder instances, and a decoder's first contact
 * with a stream in progress synthesises the whole accumulated prefix as one
 * delta. Seeding that prefix as well as receiving it live counts the text
 * twice, with nothing downstream able to tell the two apart. Leaving the open
 * run out means the client's own history walk and live subscription own it
 * end to end, decoded once.
 *
 * The seam moves back accordingly: it is the newest serial among the events
 * that ARE seeded, so the client's gap walk picks the open run up.
 * @param events - Every decoded event, oldest first.
 * @returns The seedable events and the serial they run up to.
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
 * Page the whole existing conversation off the channel and fold it.
 * @param transport - A connected transport whose `history()` to page.
 * @returns The decoded events, the folded thread, and the hydration seam.
 */
export const getExistingMessages = async (
  transport: Pick<AgentTransport<unknown, OpenAIOutput>, 'history'>,
): Promise<ExistingMessages> => {
  const events: ThreadEvent[] = [];
  let exhausted = false;
  while (!exhausted) {
    const batch = await transport.history();
    // The fold consumes events in chronological order, and each batch is older
    // than the previous one — so collect by prepending, then fold once whole.
    events.unshift(...batch.events);
    exhausted = batch.exhausted;
  }

  const fold = createThreadFold();
  for (const event of events) fold.apply(event);

  // Delivery order is chronological, so the newest serial is the last one an
  // event carries.
  let latestSerial: string | undefined;
  for (let i = events.length - 1; i >= 0 && latestSerial === undefined; i--) {
    const event = events[i];
    if (event) latestSerial = serialOf(event);
  }

  return { events, messages: fold.messages(), latestSerial };
};
