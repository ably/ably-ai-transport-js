/**
 * Vercel-shaped fixtures and projections for transport integration tests:
 * a deterministic response chunk stream (no LLM call), and readers that
 * reassemble text or fold a whole message the way a real consumer would.
 */

import type * as AI from 'ai';

import { foldWithProviderReducer } from './ui-message-fold.js';

/**
 * A complete streamed text response in the AI SDK's chunk vocabulary:
 * `start` / `start-step` / `text-start` / two `text-delta` halves /
 * `text-end` / `finish`, then close.
 * @param messageId - The assistant message id on the `start` chunk.
 * @param textId - The text part's id.
 * @param text - The full text, split into two deltas.
 * @returns The chunk stream.
 */
export const textResponseChunks = (
  messageId: string,
  textId: string,
  text: string,
): ReadableStream<AI.UIMessageChunk> =>
  new ReadableStream<AI.UIMessageChunk>({
    start: (controller) => {
      const half = Math.ceil(text.length / 2);
      controller.enqueue({ type: 'start', messageId });
      controller.enqueue({ type: 'start-step' });
      controller.enqueue({ type: 'text-start', id: textId });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(0, half) });
      controller.enqueue({ type: 'text-delta', id: textId, delta: text.slice(half) });
      controller.enqueue({ type: 'text-end', id: textId });
      controller.enqueue({ type: 'finish' });
      controller.close();
    },
  });

/**
 * Reassemble the text a chunk slice carries by concatenating its text deltas.
 * Deliberately blind to delta count — the platform may split or coalesce
 * deltas in transit, and the contract is the reassembled text.
 * @param chunks - The chunks to read.
 * @returns The concatenated text.
 */
export const textOfChunks = (chunks: AI.UIMessageChunk[]): string =>
  chunks.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('');

/**
 * Fold a chunk slice into the final `UIMessage` with the provider's own
 * reducer — the fold a real consumer runs.
 * @param chunks - The chunks, in wire order.
 * @returns The folded message, or undefined when the fold yields none.
 */
export const foldUIMessage = async (chunks: AI.UIMessageChunk[]): Promise<AI.UIMessage | undefined> =>
  foldWithProviderReducer(chunks);

/**
 * The concatenated text of a folded message's text parts.
 * @param message - The folded message.
 * @returns The text.
 */
export const textOfUIMessage = (message: AI.UIMessage | undefined): string =>
  (message?.parts ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
