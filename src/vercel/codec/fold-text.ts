/**
 * Text and reasoning streaming folds: the {start, delta, end} lifecycle for
 * both `text-*` and `reasoning-*` chunks, which share the same shape.
 */

import type * as AI from 'ai';

import { type VercelCtx } from './reducer-state.js';

/**
 * Fold a text or reasoning streaming chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The text/reasoning start, delta, or end chunk.
 */
export const foldTextOrReasoning = (
  ctx: VercelCtx,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'text-start' | 'text-delta' | 'text-end' | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end' }
  >,
): void => {
  const { message, tracker } = ctx.ensure('assistant');

  const isText = chunk.type.startsWith('text-');
  const partType = isText ? 'text' : 'reasoning';
  const activeMap = isText ? tracker.text : tracker.reasoning;

  switch (chunk.type) {
    case 'text-start':
    case 'reasoning-start': {
      activeMap.set(chunk.id, message.parts.length);
      message.parts.push({ type: partType, text: '' });
      return;
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const idx = activeMap.get(chunk.id);
      if (idx === undefined) return;
      const part = message.parts[idx];
      if (part?.type === partType) {
        part.text += chunk.delta;
      }
      return;
    }
    case 'text-end':
    case 'reasoning-end': {
      activeMap.delete(chunk.id);
      return;
    }
  }
};
