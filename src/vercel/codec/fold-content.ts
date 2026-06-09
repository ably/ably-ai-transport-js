/**
 * File and source content-part folds: file / source-url / source-document.
 * These are independent attachments — each appends a part, never dedups.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';
import { ensureMessage, type VercelProjection } from './reducer-state.js';

/**
 * Fold a file or source content chunk into the projection.
 * @param state - Projection to fold into.
 * @param chunk - The file, source-url, or source-document chunk.
 * @param messageId - The target codec-message-id.
 * @returns The same projection reference.
 */
export const foldContentPart = (
  state: VercelProjection,
  chunk: Extract<AI.UIMessageChunk, { type: 'file' | 'source-url' | 'source-document' }>,
  messageId: string,
): VercelProjection => {
  const message = ensureMessage(state, messageId);

  switch (chunk.type) {
    case 'file': {
      message.parts.push({ type: 'file', mediaType: chunk.mediaType, url: chunk.url });
      return state;
    }
    case 'source-url': {
      message.parts.push(
        stripUndefined({
          type: 'source-url' as const,
          sourceId: chunk.sourceId,
          url: chunk.url,
          title: chunk.title,
        }),
      );
      return state;
    }
    case 'source-document': {
      message.parts.push(
        stripUndefined({
          type: 'source-document' as const,
          sourceId: chunk.sourceId,
          mediaType: chunk.mediaType,
          title: chunk.title,
          filename: chunk.filename,
        }),
      );
      return state;
    }
  }
};
