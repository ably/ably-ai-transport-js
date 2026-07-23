/**
 * data-* part folds. Transient data parts are dropped; persistent ones are
 * appended, or replaced in place when a matching `id` is already present.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';
import { type VercelCtx } from './reducer-state.js';

/**
 * Fold a `data-*` chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The data-* chunk.
 */
export const foldDataPart = (ctx: VercelCtx, chunk: Extract<AI.UIMessageChunk, { type: `data-${string}` }>): void => {
  if (chunk.transient) return;

  const { message } = ctx.ensure('assistant');

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
      return;
    }
  }

  message.parts.push(dataPart);
};
