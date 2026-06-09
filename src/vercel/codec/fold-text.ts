/**
 * Text and reasoning streaming folds: the {start, delta, end} lifecycle for
 * both `text-*` and `reasoning-*` chunks, which share the same shape.
 */

import type * as AI from 'ai';

import { ensureMessage, ensureTrackers, type VercelProjection } from './reducer-state.js';

/**
 * Fold a text or reasoning streaming chunk into the projection.
 * @param state - Projection to fold into.
 * @param chunk - The text/reasoning start, delta, or end chunk.
 * @param messageId - The target codec-message-id.
 * @returns The same projection reference.
 */
export const foldTextOrReasoning = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'text-start' | 'text-delta' | 'text-end' | 'reasoning-start' | 'reasoning-delta' | 'reasoning-end' }
  >,
  messageId: string,
): VercelProjection => {
  const message = ensureMessage(state, messageId);
  const trackers = ensureTrackers(state, messageId);

  const isText = chunk.type.startsWith('text-');
  const partType = isText ? 'text' : 'reasoning';
  const activeMap = isText ? trackers.text : trackers.reasoning;

  switch (chunk.type) {
    case 'text-start':
    case 'reasoning-start': {
      activeMap.set(chunk.id, message.parts.length);
      message.parts.push({ type: partType, text: '' });
      return state;
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const idx = activeMap.get(chunk.id);
      if (idx === undefined) return state;
      const part = message.parts[idx];
      if (part?.type === partType) {
        part.text += chunk.delta;
      }
      return state;
    }
    case 'text-end':
    case 'reasoning-end': {
      activeMap.delete(chunk.id);
      return state;
    }
  }
};
