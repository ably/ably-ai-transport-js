/**
 * getExistingMessages — the demo's one swappable history source.
 *
 * Pages a transport's channel history to exhaustion and merges it through the
 * same merge helper the frontend renders with. Both readers of the existing
 * conversation go through here: the chat route (model context) and the
 * messages endpoint (client hydration). Swapping the channel for a database
 * later means reimplementing only this function — its callers already consume
 * the returned shape.
 */

import type { AgentTransport, TransportEvent } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import { createThreadMerge, type ThreadMessage } from './merge-thread';

/** One decoded transport event at the demo's codec instantiation. */
export type ThreadEvent = TransportEvent<unknown, OpenAIOutput>;

/** What {@link getExistingMessages} returns. */
export interface ExistingMessages {
  /** Every decoded event, oldest first — what a client-side merge consumes. */
  events: ThreadEvent[];
  /** The merged thread, oldest message first — what the model context consumes. */
  messages: ThreadMessage[];
  /**
   * The channel serial of the newest event included, or `undefined` for an
   * empty conversation. A hydrating client uses it as the seam: everything at
   * or before this serial is already in `events`, so its own gap walk keeps
   * only newer events.
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
 * Page the whole existing conversation off the channel and merge it.
 * @param transport - A connected transport whose `history()` to page.
 * @returns The decoded events, the merged thread, and the hydration seam.
 */
export const getExistingMessages = async (
  transport: Pick<AgentTransport<unknown, OpenAIOutput>, 'history'>,
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
