/**
 * File and source content-part folds: file / source-url / source-document.
 * These are independent attachments — each appends a part, never dedups.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';
import { type VercelCtx } from './reducer-state.js';

/**
 * Fold a file or source content chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The file, source-url, or source-document chunk.
 */
export const foldContentPart = (
  ctx: VercelCtx,
  chunk: Extract<AI.UIMessageChunk, { type: 'file' | 'source-url' | 'source-document' }>,
): void => {
  const { message } = ctx.ensure('assistant');

  switch (chunk.type) {
    case 'file': {
      message.parts.push({ type: 'file', mediaType: chunk.mediaType, url: chunk.url });
      return;
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
      return;
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
      return;
    }
  }
};
