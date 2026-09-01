import type { UIMessage } from 'ai';

/**
 * An in-memory stand-in for the conversation database an app would persist
 * completed turns to, keyed by conversation id (the channel name). It is
 * module-scoped, so it persists across requests within one Node process —
 * enough for the demo's dev server — and is lost on restart. A real app swaps
 * this for a durable store.
 *
 * Each conversation holds two things:
 *
 * - the **domain `UIMessage`s** (never the transport's internal
 *   `codecMessageId`), which is what a client seeds `useChat` from;
 * - the **channel serial** the stored messages are complete up to. Hydration
 *   hands that serial to `ChatTransport.readSince`, which walks the channel
 *   back only as far as it and returns the messages published since. Without
 *   it every page load would re-page the whole channel.
 */
const store = new Map<string, StoredConversation>();

/** One conversation as the store holds it. */
export interface StoredConversation {
  /** The persisted messages, oldest-first. */
  messages: UIMessage[];
  /**
   * The channel serial these messages are complete up to, or `undefined` when
   * nothing has been persisted yet. Every channel message at or before it is
   * accounted for in `messages`.
   */
  latestSerial?: string;
}

/**
 * Append a completed turn, **idempotent by domain `message.id`**.
 * Re-persisting a turn (same ids) updates in place rather than duplicating,
 * and chronological (oldest-first) order is preserved: existing ids keep their
 * position, genuinely new ids append at the end. The union of every turn's
 * messages therefore reconstructs the conversation with no gaps or duplicates.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would.
 * @param conversationId - The conversation key (the channel name).
 * @param messages - The completed turn's messages, oldest-first.
 * @param latestSerial - The channel serial the turn is complete up to. Only ever moves forward; an older serial is ignored.
 * @returns A promise that resolves once the turn is persisted.
 */
export async function appendMessages(
  conversationId: string,
  messages: UIMessage[],
  latestSerial?: string,
): Promise<void> {
  const current = store.get(conversationId);
  const byId = new Map((current?.messages ?? []).map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  // Turns can land out of order (a retried persist, a slow write); the stored
  // serial is a watermark, so it only ever advances.
  const advanced =
    latestSerial !== undefined && (current?.latestSerial === undefined || latestSerial > current.latestSerial);
  const nextSerial = advanced ? latestSerial : current?.latestSerial;
  store.set(conversationId, {
    messages: [...byId.values()],
    ...(nextSerial === undefined ? {} : { latestSerial: nextSerial }),
  });
}

/**
 * Load the persisted conversation for a key, or an empty one when none is
 * stored. This is the seed a client hydrates from before walking the channel
 * forward from `latestSerial`.
 * @param conversationId - The conversation key (the channel name).
 * @returns The stored messages (oldest-first) and the serial they are complete up to.
 */
export function loadConversation(conversationId: string): StoredConversation {
  return store.get(conversationId) ?? { messages: [] };
}
