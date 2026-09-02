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
 * **The server owns it, and nothing reads the channel for history.** The chat
 * route writes it twice per turn — the prompt as the run opens, the assistant's
 * messages when the run is over — from what the run itself published (see
 * `conversation.ts`). Clients read it once, on hydration, through
 * `GET /api/messages`, which touches no Ably connection.
 */

import type { ThreadSnapshot } from './merge-thread';

/**
 * One conversation as the store holds it — the merged thread and its runs. No
 * watermark: a client reads the store and takes everything else from its live
 * subscription, so there is no history window to bound.
 */
export type StoredConversation = ThreadSnapshot;

const store = new Map<string, StoredConversation>();

/**
 * Replace a conversation's stored state.
 *
 * The writer holds the whole merged thread — it seeded from the store and
 * added this turn — so a write is a replacement and needs no merge or upsert
 * of its own.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param channelName - The conversation key (the channel name).
 * @param conversation - The merged thread and its runs.
 * @returns A promise that resolves once the conversation is stored.
 */
export async function saveConversation(channelName: string, conversation: StoredConversation): Promise<void> {
  store.set(channelName, conversation);
}

/**
 * Load the stored conversation for a channel, or an empty one when none is
 * stored.
 * @param channelName - The conversation key (the channel name).
 * @returns The merged thread and its runs.
 */
export function loadConversation(channelName: string): StoredConversation {
  return store.get(channelName) ?? { messages: [], runs: [] };
}
