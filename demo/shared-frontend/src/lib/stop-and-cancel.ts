import type { ChatTransport } from '@ably/ai-transport/vercel';

/**
 * Stop the in-flight run, both locally and on the channel.
 *
 * Stopping is two operations and every demo needs both. `useChat.stop()`
 * aborts this client's request and closes the stream it is reading; it puts
 * nothing on the wire, so the agent keeps generating and every other
 * participant still sees a run in flight. `chatTransport.cancel()` publishes
 * `ai-cancel`, which is what actually reaches the agent.
 *
 * The channel cancel goes first. `cancel()` targets the run the adapter is
 * currently streaming, and tearing the stream down is what clears that
 * bookkeeping — so issuing it before `stop()` keeps the demos independent of
 * when the AI SDK releases the reader.
 * @param stop - `useChat`'s stop function.
 * @param chatTransport - The adapter, or undefined before it is built.
 * @returns Resolves once both have been issued.
 */
export async function stopAndCancel(stop: () => Promise<void>, chatTransport?: ChatTransport): Promise<void> {
  await chatTransport?.cancel();
  await stop();
}
