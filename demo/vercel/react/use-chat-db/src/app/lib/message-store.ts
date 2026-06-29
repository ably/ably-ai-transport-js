import type { UIMessage } from 'ai';

/**
 * An in-memory stand-in for the conversation database an app would persist
 * completed turns to, keyed by conversation id (the channel name, which the
 * agent sees as `invocation.sessionName`). It is module-scoped, so it persists
 * across requests within one Node process — enough for the demo's dev server —
 * and is lost on restart. A real app swaps this for a durable store.
 *
 * It holds only **domain `UIMessage`s** (never the transport's internal
 * `codecMessageId`): the domain `message.id` is the only id shared between the
 * store and the channel, which is what makes the seam-walk reconciliation on
 * hydrate work (see the seeded chat / `useMessageSync`).
 */
const store = new Map<string, UIMessage[]>();

/**
 * Append a terminal run's whole turn, **idempotent by domain `message.id`**.
 * Re-persisting a run (same ids) updates in place rather than duplicating, and
 * chronological (oldest-first) order is preserved: existing ids keep their
 * position, genuinely new ids append at the end. This mirrors the API's
 * whole-run, atomic, id-keyed persistence contract, so the union of every
 * run's messages reconstructs the conversation with no gaps or duplicates.
 *
 * Modelled as async — it resolves once the write is durable, as a real store
 * would. The agent awaits it before ending the run, so the run-end completion
 * signal never races ahead of the persisted turn.
 * @param conversationId - The conversation key (the channel name).
 * @param messages - This run's whole turn (`run.messages`).
 * @returns A promise that resolves once the turn is persisted.
 */
export async function appendMessages(conversationId: string, messages: UIMessage[]): Promise<void> {
  const byId = new Map((store.get(conversationId) ?? []).map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  store.set(conversationId, [...byId.values()]);
}

/**
 * Load the persisted conversation for a key, oldest-first, or `[]` when none is
 * stored. This is the seed a client hydrates from before reconciling with the
 * live channel.
 * @param conversationId - The conversation key (the channel name).
 * @returns The persisted messages, oldest-first.
 */
export function loadMessages(conversationId: string): UIMessage[] {
  return store.get(conversationId) ?? [];
}
