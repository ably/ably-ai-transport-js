/**
 * Lifecycle chunk folds: start, start-step, finish-step, finish, abort,
 * error, message-metadata.
 */

import type * as AI from 'ai';

import { type VercelCtx } from './reducer-state.js';

/**
 * Set the current message's metadata from a chunk when both the message exists
 * and the chunk carries metadata. Shared by the `finish` and `message-metadata`
 * cases, which apply it identically. The `start` case is not routed through
 * here — it creates the message via `ctx.ensure` first.
 * @param ctx - The fold-body capability object.
 * @param metadata - The chunk's `messageMetadata`, or undefined to leave it unchanged.
 */
const applyMessageMetadata = (ctx: VercelCtx, metadata: AI.UIMessage['metadata']): void => {
  if (metadata === undefined) return;
  const entry = ctx.lookup();
  if (entry) entry.message.metadata = metadata;
};

/**
 * Fold a message-lifecycle chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The lifecycle chunk.
 */
export const foldLifecycle = (
  ctx: VercelCtx,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'start' | 'start-step' | 'finish-step' | 'finish' | 'abort' | 'error' | 'message-metadata' }
  >,
): void => {
  switch (chunk.type) {
    case 'start': {
      // The projection entry is keyed on the wire codec-message-id; every
      // subsequent chunk for this message correlates on that, independent of
      // `message.id`. So we faithfully reproduce the stream's own `messageId`
      // on the reconstructed `UIMessage.id` (the value surfaced to the
      // application) without risk of orphaning later chunks. When the stream
      // omits it, the codec-message-id `createEntry` stamped stands as the
      // fallback id.
      const { message } = ctx.ensure('assistant');
      if (chunk.messageId !== undefined) message.id = chunk.messageId;
      if (chunk.messageMetadata !== undefined) message.metadata = chunk.messageMetadata;
      return;
    }
    case 'start-step': {
      const { message } = ctx.ensure('assistant');
      message.parts.push({ type: 'step-start' });
      return;
    }
    case 'finish-step': {
      // Reset text/reasoning stream trackers so a follow-up step can start
      // new parts with potentially-reused stream ids.
      const entry = ctx.lookup();
      if (entry) {
        entry.tracker.text.clear();
        entry.tracker.reasoning.clear();
      }
      return;
    }
    case 'finish': {
      applyMessageMetadata(ctx, chunk.messageMetadata);
      // Tracker state retained — late events still resolvable; cleanup happens at Run end.
      return;
    }
    case 'abort':
    case 'error': {
      // No state mutation — run termination is observed via the wire run-end
      // event, not the projection.
      return;
    }
    case 'message-metadata': {
      applyMessageMetadata(ctx, chunk.messageMetadata);
      return;
    }
  }
};
