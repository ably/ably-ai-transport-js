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
 * It also records the channel serial the stored messages are complete up to.
 * That serial is the join: hydration hands it to `chatTransport.readSince()`,
 * which walks the channel back only as far as it and returns whatever was
 * published since, and a run still streaming is left for `resumeStream()`. No
 * run id is stored — keeping one alive across a refresh would put the
 * transport's wire metadata in the application's schema, and the walk recovers
 * the run id from the message it withholds.
 */

import type { UIMessage } from 'ai';

/** One conversation as the store holds it. */
export interface StoredConversation {
  /** The persisted messages, oldest-first. */
  messages: UIMessage[];
  /**
   * The channel serial the stored messages are complete up to, or `undefined`
   * when nothing has been stored yet. Every channel message at or before it is
   * accounted for in `messages`, which is what lets a client walk back only as
   * far as it.
   */
  latestSerial?: string;
}

const store = new Map<string, StoredConversation>();

/**
 * Replace a conversation's messages, and move the watermark to `latestSerial`.
 *
 * The AI SDK hands back the whole updated conversation rather than the newest
 * turn (`toUIMessageStream`'s `originalMessages` + `onEnd`), so a write is a
 * replacement and needs no merge or upsert.
 *
 * The watermark only ever moves forward, so a slow or retried write cannot
 * pull it back over messages the store already accounts for.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param channelName - The conversation key (the channel name).
 * @param messages - The whole conversation, oldest-first.
 * @param latestSerial - The channel serial the messages are complete up to. Omit to leave the watermark where it is.
 * @returns A promise that resolves once the messages are stored.
 */
export async function saveMessages(channelName: string, messages: UIMessage[], latestSerial?: string): Promise<void> {
  const current = store.get(channelName);
  // Ably serials order lexicographically.
  const advanced =
    latestSerial !== undefined && (current?.latestSerial === undefined || latestSerial > current.latestSerial);
  const watermark = advanced ? latestSerial : current?.latestSerial;
  store.set(channelName, {
    messages,
    ...(watermark === undefined ? {} : { latestSerial: watermark }),
  });
}

/**
 * Load the stored conversation for a channel, or an empty one when none is
 * stored.
 * @param channelName - The conversation key (the channel name).
 * @returns The stored messages (oldest-first) and the serial they are complete up to.
 */
export function loadConversation(channelName: string): StoredConversation {
  return store.get(channelName) ?? { messages: [] };
}
