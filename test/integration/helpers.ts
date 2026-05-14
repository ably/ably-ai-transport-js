/**
 * Integration test helpers for decoder output extraction.
 */

import type * as AI from 'ai';

import type { VercelEvent } from '../../src/vercel/codec/index.js';

/**
 * Filter codec-decoded events to UIMessageChunk variants (the legacy assistant
 * stream). Excludes Vercel codec-local variants (`UserMessageEvent`,
 * `ToolApprovalEvent`, `ClientToolOutputEvent`).
 * @param events - Codec-decoded events.
 * @returns UIMessageChunk-only subset.
 */
const chunksOf = (events: VercelEvent[]): AI.UIMessageChunk[] =>
  // CAST: discriminator excludes the codec-local variants.
  events.filter(
    (e): e is AI.UIMessageChunk =>
      e.type !== 'ait-user-message' &&
      e.type !== 'ait-tool-approval' &&
      e.type !== 'ait-client-tool-output' &&
      e.type !== 'ait-client-tool-output-error',
  );

/**
 * Extract event types from decoder outputs.
 * @param events - Decoder events to extract from.
 * @returns Array of event type strings.
 */
export const eventTypesOf = (events: VercelEvent[]): string[] => chunksOf(events).map((e) => e.type);

/**
 * Extract events from decoder outputs.
 * @param events - Decoder events to extract from.
 * @returns Array of UIMessageChunk events.
 */
export const eventsOf = (events: VercelEvent[]): AI.UIMessageChunk[] => chunksOf(events);

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
