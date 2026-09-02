/**
 * The demo's conversation store — an in-memory stand-in for the database an
 * app would persist conversations to, keyed by channel name.
 *
 * It is module-scoped, so it survives across requests inside one Node process
 * (enough for a dev server) and is lost on restart. A real app swaps the Map
 * for a durable store; nothing else here changes.
 *
 * What it holds is this demo's own currency: the **decoded transport events**,
 * oldest first, plus the channel serial they run up to. The frontend's
 * conversation state comes from `createThreadMerge`, which consumes events
 * rather than finished messages, so the events are what a client rehydrates
 * from. The serial is the watermark: hydration hands it back to the client,
 * which then pages the channel only for what was published after it.
 *
 * Writes come from the client, on each completed run — see
 * `hooks/use-responses-thread.ts`. Reads come from `GET /api/messages`, which
 * needs no Ably connection at all: the store is the whole answer.
 */

import type { ThreadEvent } from './get-existing-messages';

/** One conversation as the store holds it. */
export interface StoredConversation {
  /** The decoded transport events, oldest first. */
  events: ThreadEvent[];
  /**
   * The channel serial the events run up to, or `undefined` when nothing has
   * been stored yet. Every channel message at or before it is accounted for in
   * `events`.
   */
  latestSerial?: string;
}

const store = new Map<string, StoredConversation>();

/**
 * Save a conversation, replacing what is stored for the channel.
 *
 * A writer sends the whole conversation it holds, not the newest run alone,
 * because the watermark's contract is that everything at or before it is in
 * the store — a run-sized write cannot honour that for a run this client never
 * saw. Wholesale replacement is also what keeps a stored event sequence
 * coherent: a client that joined a run mid-stream decoded a synthesised prefix
 * for it, so two clients' sequences are each self-consistent but are not
 * interleavable event by event. A client seeds from the store before it writes,
 * so what it sends is a superset of what it replaces.
 *
 * A write whose watermark is older than the stored one is ignored, which is
 * what makes a slow or retried write harmless.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param channelName - The conversation key (the channel name).
 * @param events - The conversation's decoded events, oldest first.
 * @param latestSerial - The channel serial the events run up to.
 * @returns A promise that resolves once the conversation is stored.
 */
export async function saveConversation(
  channelName: string,
  events: ThreadEvent[],
  latestSerial?: string,
): Promise<void> {
  const current = store.get(channelName);
  // Ably serials order lexicographically.
  const stale =
    current?.latestSerial !== undefined && (latestSerial === undefined || latestSerial < current.latestSerial);
  if (stale) return;
  store.set(channelName, {
    events,
    ...(latestSerial === undefined ? {} : { latestSerial }),
  });
}

/**
 * Load the stored conversation for a channel, or an empty one when none is
 * stored.
 * @param channelName - The conversation key (the channel name).
 * @returns The stored events (oldest first) and the serial they run up to.
 */
export function loadConversation(channelName: string): StoredConversation {
  return store.get(channelName) ?? { events: [] };
}
