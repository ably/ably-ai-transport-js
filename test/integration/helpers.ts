/**
 * Integration test helpers for decoder output extraction.
 */

import type * as AI from 'ai';

/**
 * Create a ReadableStream of UIMessageChunks that produces a complete text response.
 * The text is split into two deltas at the midpoint.
 * @param messageId - The message ID to use.
 * @param textId - The text part ID to use.
 * @param text - The text content to stream (split into two deltas).
 * @returns A ReadableStream of UIMessageChunks.
 */
export const textResponseStream = (
  messageId: string,
  textId: string,
  text: string,
): ReadableStream<AI.UIMessageChunk> => {
  const mid = Math.floor(text.length / 2);
  return new ReadableStream({
    start: (controller) => {
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'text-start', id: textId });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(0, mid) });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(mid) });
      controller.enqueue({ type: 'text-end', id: textId });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
};
