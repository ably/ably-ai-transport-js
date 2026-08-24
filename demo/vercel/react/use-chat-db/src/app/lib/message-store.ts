import type { UIMessage } from 'ai';

/**
 * An in-memory stand-in for the conversation database an app would persist
 * completed turns to, keyed by conversation id (the channel name). It is
 * module-scoped, so it persists across requests within one Node process —
 * enough for the demo's dev server — and is lost on restart. A real app swaps
 * this for a durable store.
 *
 * It holds only **domain `UIMessage`s** (never the transport's internal
 * `transportMessageId`): the domain `message.id` is the only id shared between the
 * store and the channel, which is what lets hydration page the history gap
 * back to the newest stored message and merge without duplication (see
 * `lib/hydrate.ts`).
 */
const store = new Map<string, UIMessage[]>();

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
 * @returns A promise that resolves once the turn is persisted.
 */
export async function appendMessages(conversationId: string, messages: UIMessage[]): Promise<void> {
  const byId = new Map((store.get(conversationId) ?? []).map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  store.set(conversationId, [...byId.values()]);
}

/**
 * Load the persisted conversation for a key, oldest-first, or `[]` when none is
 * stored. This is the seed a client hydrates from before paging the
 * channel-history gap.
 * @param conversationId - The conversation key (the channel name).
 * @returns The persisted messages, oldest-first.
 */
export function loadMessages(conversationId: string): UIMessage[] {
  return store.get(conversationId) ?? [];
}
