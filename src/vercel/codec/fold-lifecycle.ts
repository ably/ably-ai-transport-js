/**
 * Lifecycle chunk folds: start, start-step, finish-step, finish, abort,
 * error, message-metadata.
 */

import type * as AI from 'ai';

import { ensureMessage, type VercelProjection } from './reducer-state.js';

/**
 * Set a message's metadata from a chunk when both the message exists and the
 * chunk carries metadata. Shared by the `finish` and `message-metadata` cases,
 * which apply it identically. The `start` case is not routed through here — it
 * creates the message via `ensureMessage` first.
 * @param state - Projection holding the message.
 * @param messageId - The target codec-message-id.
 * @param metadata - The chunk's `messageMetadata`, or undefined to leave it unchanged.
 */
const applyMessageMetadata = (state: VercelProjection, messageId: string, metadata: AI.UIMessage['metadata']): void => {
  if (metadata === undefined) return;
  const message = state.messages.find((e) => e.codecMessageId === messageId)?.message;
  if (message) message.metadata = metadata;
};

/**
 * Fold a message-lifecycle chunk into the projection.
 * @param state - Projection to fold into.
 * @param chunk - The lifecycle chunk.
 * @param messageId - The target codec-message-id.
 * @returns The same projection reference.
 */
export const foldLifecycle = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'start' | 'start-step' | 'finish-step' | 'finish' | 'abort' | 'error' | 'message-metadata' }
  >,
  messageId: string,
): VercelProjection => {
  switch (chunk.type) {
    case 'start': {
      // The projection entry is keyed on the wire codec-message-id
      // (`messageId`); every subsequent chunk for this message correlates on
      // that, independent of `message.id`. So we faithfully reproduce the
      // stream's own `messageId` on the reconstructed `UIMessage.id` (the
      // value surfaced to the application) without risk of orphaning later
      // chunks. When the stream omits it, the codec-message-id seeded by
      // `ensureMessage` stands as the fallback id.
      const message = ensureMessage(state, messageId);
      if (chunk.messageId !== undefined) message.id = chunk.messageId;
      if (chunk.messageMetadata !== undefined) message.metadata = chunk.messageMetadata;
      return state;
    }
    case 'start-step': {
      const message = ensureMessage(state, messageId);
      message.parts.push({ type: 'step-start' });
      return state;
    }
    case 'finish-step': {
      // Reset text/reasoning stream trackers so a follow-up step can start
      // new parts with potentially-reused stream ids.
      const trackers = state.trackers.get(messageId);
      if (trackers) {
        trackers.text.clear();
        trackers.reasoning.clear();
      }
      return state;
    }
    case 'finish': {
      applyMessageMetadata(state, messageId, chunk.messageMetadata);
      // Tracker state retained — late events still resolvable; cleanup happens at Run end.
      return state;
    }
    case 'abort':
    case 'error': {
      // No state mutation — run termination is observed via the wire run-end
      // event, not the projection.
      return state;
    }
    case 'message-metadata': {
      applyMessageMetadata(state, messageId, chunk.messageMetadata);
      return state;
    }
  }
};
