/**
 * The demo's conversation store — an in-memory stand-in for the database an
 * app would keep conversations in, keyed by channel name.
 *
 * It is module-scoped, so it survives across requests inside one Node process
 * (enough for a dev server) and is lost on restart. A real app swaps the Map
 * for a durable store; nothing else here changes.
 *
 * **The server owns it.** Every write happens in the chat route: the user's
 * turn as the run opens, and the finished conversation when the AI SDK's
 * stream ends. A client never writes, so it cannot put anything in the store
 * that the agent did not produce. Clients read it once, on hydration, through
 * `GET /api/messages`.
 *
 * It also records the run currently open on the channel. A page that loads
 * while a run is streaming has a conversation but no live stream, so
 * hydration hands that run id to `resumeStream` as a reconnect hint and the
 * adapter picks the run up from the channel.
 */

import type { UIMessage } from 'ai';

/** One conversation as the store holds it. */
export interface StoredConversation {
  /** The persisted messages, oldest-first. */
  messages: UIMessage[];
  /**
   * The run streaming on the channel right now, when there is one. A client
   * resumes it on hydration rather than waiting for the next append.
   */
  activeRunId?: string;
}

const store = new Map<string, StoredConversation>();

/**
 * Replace a conversation's messages, leaving the open run as it is.
 *
 * The AI SDK hands back the whole updated conversation rather than the newest
 * turn (`toUIMessageStream`'s `originalMessages` + `onEnd`), so a write is a
 * replacement and needs no merge or upsert.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param channelName - The conversation key (the channel name).
 * @param messages - The whole conversation, oldest-first.
 * @returns A promise that resolves once the messages are stored.
 */
export async function saveMessages(channelName: string, messages: UIMessage[]): Promise<void> {
  const current = store.get(channelName);
  store.set(channelName, { ...current, messages });
}

/**
 * Record which run is open on the channel, or that none is.
 *
 * The route sets it as a run opens and clears it when the run's stream ends,
 * so the value a hydrating client reads is only ever a run it can still join.
 * @param channelName - The conversation key (the channel name).
 * @param activeRunId - The open run's id, or `undefined` to clear it.
 * @returns A promise that resolves once the change is durable.
 */
export async function setActiveRun(channelName: string, activeRunId: string | undefined): Promise<void> {
  const current = store.get(channelName) ?? { messages: [] };
  store.set(channelName, {
    messages: current.messages,
    ...(activeRunId === undefined ? {} : { activeRunId }),
  });
}

/**
 * Load the stored conversation for a channel, or an empty one when none is
 * stored.
 * @param channelName - The conversation key (the channel name).
 * @returns The stored messages (oldest-first) and the open run, if any.
 */
export function loadConversation(channelName: string): StoredConversation {
  return store.get(channelName) ?? { messages: [] };
}
