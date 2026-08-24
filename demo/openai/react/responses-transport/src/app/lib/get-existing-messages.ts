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
import type { OpenAIInput, OpenAIOutput } from '@ably/ai-transport/openai';

import { createThreadFold, type ThreadMessage } from './fold-thread';

/** One decoded transport event at the demo's codec instantiation. */
export type ThreadEvent = TransportEvent<OpenAIInput, OpenAIOutput>;

/** What {@link getExistingMessages} returns. */
export interface ExistingMessages {
  /** Every decoded event, oldest first — what a client-side fold consumes. */
  events: ThreadEvent[];
  /** The folded thread, oldest message first — what the model context consumes. */
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
 * @returns The serial, or `undefined` (an optimistic local echo has none).
 */
export const serialOf = (event: ThreadEvent): string | undefined =>
  event.kind === 'message' ? event.meta.serial : event.event.serial;

/**
 * Page the whole existing conversation off the channel and fold it.
 * @param transport - A connected transport whose `history()` to page.
 * @returns The decoded events, the folded thread, and the hydration seam.
 */
export const getExistingMessages = async (
  transport: Pick<AgentTransport<OpenAIInput, OpenAIOutput>, 'history'>,
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
