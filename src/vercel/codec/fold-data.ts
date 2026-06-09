/**
 * data-* part folds. Transient data parts are dropped; persistent ones are
 * appended, or replaced in place when a matching `id` is already present.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';
import { ensureMessage, type VercelProjection } from './reducer-state.js';

/**
 * Fold a `data-*` chunk into the projection.
 * @param state - Projection to fold into.
 * @param chunk - The data-* chunk.
 * @param messageId - The target codec-message-id.
 * @returns The same projection reference.
 */
export const foldDataPart = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: `data-${string}` }>,
  messageId: string,
): VercelProjection => {
  if (chunk.transient) return state;

  const message = ensureMessage(state, messageId);

  // CAST: chunk.type is `data-${string}` which satisfies DataUIPart, but
  // TypeScript cannot verify the template literal matches a specific
  // UIMessagePart variant at the type level.
  const dataPart = stripUndefined({
    type: chunk.type,
    id: chunk.id,
    data: chunk.data,
  }) as AI.UIMessage['parts'][number];

  if (chunk.id !== undefined) {
    const idx = message.parts.findIndex((p) => p.type === chunk.type && 'id' in p && p.id === chunk.id);
    if (idx !== -1) {
      message.parts[idx] = dataPart;
      return state;
    }
  }

  message.parts.push(dataPart);
  return state;
};
