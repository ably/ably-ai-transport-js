/**
 * The demo's conversation store — an in-memory stand-in for the database an
 * app would keep conversations in, keyed by channel name.
 *
 * It is module-scoped, so it survives across requests inside one Node process
 * (enough for a dev server) and is lost on restart. A real app swaps the Map
 * for a durable store; nothing else here changes.
 *
 * **What it holds is finished messages, not wire events.** The channel's
 * currency is events, and merging them is the agent's job, done once with
 * OpenAI's own stream accumulator — so the store keeps the merged result (see
 * `merge-thread.ts`) plus the run summaries that go with it. A client seeds a
 * merge from that and only merges what happened since.
 *
 * **The server owns it.** The chat route writes it from the history page it
 * already does for the model context, so a client cannot put anything here the
 * agent did not produce. Clients read it once, on hydration, through
 * `GET /api/messages`, which touches no Ably connection.
 */

import type { ThreadSnapshot } from './merge-thread';

/** One conversation as the store holds it. */
export interface StoredConversation extends ThreadSnapshot {
  /**
   * The channel serial the stored messages are complete up to, or `undefined`
   * when nothing has been stored yet. A hydrating client walks the channel
   * only for what came after it.
   */
  latestSerial?: string;
}

const store = new Map<string, StoredConversation>();

/**
 * Replace a conversation's stored state.
 *
 * The writer holds the whole merged thread, so a write is a replacement and
 * needs no merge or upsert of its own. A write whose watermark is older than
 * the stored one is ignored, which is what makes a slow or retried write
 * harmless.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param channelName - The conversation key (the channel name).
 * @param conversation - The merged thread and the serial it is complete up to.
 * @returns A promise that resolves once the conversation is stored.
 */
export async function saveConversation(channelName: string, conversation: StoredConversation): Promise<void> {
  const current = store.get(channelName);
  // Ably serials order lexicographically.
  const stale =
    current?.latestSerial !== undefined &&
    (conversation.latestSerial === undefined || conversation.latestSerial < current.latestSerial);
  if (stale) return;
  store.set(channelName, conversation);
}

/**
 * Load the stored conversation for a channel, or an empty one when none is
 * stored.
 * @param channelName - The conversation key (the channel name).
 * @returns The merged thread, its runs, and the serial it is complete up to.
 */
export function loadConversation(channelName: string): StoredConversation {
  return store.get(channelName) ?? { messages: [], runs: [] };
}
