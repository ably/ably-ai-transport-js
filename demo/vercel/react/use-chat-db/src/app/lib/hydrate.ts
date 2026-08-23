/**
 * Conversation hydration: database seed + the channel-history gap.
 *
 * The store holds every completed run's messages, so the client rebuilds the
 * conversation in two parts: the stored seed (fetched over REST), and the gap
 * between the newest stored message and the channel attach point (paged
 * backwards via the transport's `history()`, which is bounded at the attach
 * point). The gap covers everything the store has not caught up on — a run
 * that completed after the store snapshot, and a suspended run that is never
 * persisted. The same gap events also seed the useChat adapter's wire indices
 * (`chatTransport.seed`), which is what lets an approval given after a reload
 * resume the suspended run.
 */

import type { TransportHistoryOptions, TransportHistoryResult } from '@ably/ai-transport';
import type { VercelInput, VercelOutput } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { type ChatTransportEvent, foldMessages } from './fold-messages';

/** The one method hydration needs — satisfied by both `ClientTransport` and `AgentTransport`. */
export interface HistorySource {
  /** Page the channel's history backwards from the attach point; see the transport's own `history()` contract. */
  history(opts?: TransportHistoryOptions): Promise<TransportHistoryResult<VercelInput, VercelOutput>>;
}

/** What {@link collectGapEvents} returns: the gap plus whether the walk hit the channel start. */
export interface GapEvents {
  /** The collected events, oldest-first. */
  events: ChatTransportEvent[];
  /** True when the walk reached the channel start (nothing older remains). */
  exhausted: boolean;
}

/**
 * Whether a classified event carries the message with the given domain id —
 * the signal that paging has reached the newest stored message. Three ways a
 * wire event references it: the wire codec-message-id equals it (the fold
 * falls back to the codec-message-id as the domain id when a stream names
 * none), a `message`-kind input carries it as its payload's `id`, or an
 * output `start` chunk names it as the stream's `messageId`.
 * @param event - The classified event to test.
 * @param domainId - The domain `message.id` to look for.
 * @returns True when the event references that message.
 */
const referencesMessage = (event: ChatTransportEvent, domainId: string): boolean => {
  if (event.kind !== 'message') return false;
  if (event.meta.codecMessageId === domainId) return true;
  if (event.inputs.some((input) => input.kind === 'message' && input.payload.id === domainId)) return true;
  return event.outputs.some((output) => output.type === 'start' && output.messageId === domainId);
};

/**
 * Page transport history backwards from the attach point until the newest
 * stored message is reached, or the channel start when nothing is stored.
 * Stopping at the batch that references the stored message may include a
 * partial fold of it (and of older, already-stored messages) — harmless,
 * because {@link mergeConversation} trims the gap at the seam.
 * @param source - The transport whose `history()` to page.
 * @param newestStoredId - The domain id of the newest stored message, or `undefined` when the store is empty.
 * @returns The collected events, oldest-first, and the exhaustion flag.
 */
export async function collectGapEvents(source: HistorySource, newestStoredId: string | undefined): Promise<GapEvents> {
  const events: ChatTransportEvent[] = [];
  for (;;) {
    const batch = await source.history();
    events.unshift(...batch.events);
    if (batch.exhausted) return { events, exhausted: true };
    if (newestStoredId !== undefined && batch.events.some((e) => referencesMessage(e, newestStoredId))) {
      return { events, exhausted: false };
    }
  }
}

/**
 * Build the full conversation: the stored seed followed by the gap messages
 * folded from channel history. The fold is trimmed at the seam — everything
 * up to and including the newest gap message whose domain id the seed already
 * holds is dropped (a stored message's refold is at best partial), and any
 * remaining seed-known id is deduped with the seed winning.
 * @param seed - The stored messages, oldest-first.
 * @param gapEvents - The events {@link collectGapEvents} returned.
 * @returns The conversation messages, oldest-first.
 */
export async function mergeConversation(seed: UIMessage[], gapEvents: ChatTransportEvent[]): Promise<UIMessage[]> {
  const seedIds = new Set(seed.map((message) => message.id));
  const folded = await foldMessages(gapEvents);
  let seam = -1;
  for (const [index, entry] of folded.entries()) {
    if (seedIds.has(entry.message.id)) seam = index;
  }
  const gap = folded
    .slice(seam + 1)
    .map((entry) => entry.message)
    .filter((message) => !seedIds.has(message.id));
  return [...seed, ...gap];
}
