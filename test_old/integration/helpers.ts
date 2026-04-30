/**
 * Integration test helpers for decoder output extraction.
 */

import type * as AI from 'ai';

import type { DecoderOutput } from '../../src/core/codec/types.js';

type EventOutput = Extract<DecoderOutput<AI.UIMessageChunk, AI.UIMessage>, { kind: 'event' }>;

const isEventOutput = (o: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>): o is EventOutput => o.kind === 'event';

/**
 * Extract event types from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of event type strings.
 */
export const eventTypesOf = (outputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[]): string[] =>
  outputs.filter((o) => isEventOutput(o)).map((o) => o.event.type);

/**
 * Extract events from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of UIMessageChunk events.
 */
export const eventsOf = (outputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[]): AI.UIMessageChunk[] =>
  outputs.filter((o) => isEventOutput(o)).map((o) => o.event);

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
