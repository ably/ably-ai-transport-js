/**
 * Tool-input streaming folds: tool-input-start / -delta / -available / -error.
 * Tool deltas arrive as raw JSON fragments accumulated in the tracker's
 * `inputText` buffer and parsed on each delta.
 */

import type * as AI from 'ai';

import { parseJson } from '../../utils.js';
import { ensureMessage, ensureTrackers, getToolPart, type VercelProjection } from './reducer-state.js';
import { toolBase } from './tool-transitions.js';

/**
 * Fold a tool-input streaming chunk into the projection.
 * @param state - Projection to fold into.
 * @param chunk - The tool-input start, delta, available, or error chunk.
 * @param messageId - The target codec-message-id.
 * @returns The same projection reference.
 */
export const foldToolInput = (
  state: VercelProjection,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-input-start' | 'tool-input-delta' | 'tool-input-available' | 'tool-input-error' }
  >,
  messageId: string,
): VercelProjection => {
  const message = ensureMessage(state, messageId);
  const trackers = ensureTrackers(state, messageId);

  switch (chunk.type) {
    case 'tool-input-start': {
      const partIndex = message.parts.length;
      message.parts.push({ ...toolBase(chunk), state: 'input-streaming', input: undefined });
      trackers.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      return state;
    }
    case 'tool-input-delta': {
      const tracker = trackers.tools.get(chunk.toolCallId);
      if (!tracker) return state;
      tracker.inputText += chunk.inputTextDelta;

      const parsedInput = parseJson(tracker.inputText);

      const found = getToolPart(message, trackers, chunk.toolCallId);
      if (!found) return state;
      message.parts[found.tracker.partIndex] = {
        ...toolBase(found.part),
        state: 'input-streaming',
        input: parsedInput,
      };
      return state;
    }
    case 'tool-input-available': {
      const found = getToolPart(message, trackers, chunk.toolCallId);
      if (!found) return state;
      message.parts[found.tracker.partIndex] = {
        ...toolBase(found.part),
        state: 'input-available',
        input: chunk.input,
      };
      return state;
    }
    case 'tool-input-error': {
      const found = getToolPart(message, trackers, chunk.toolCallId);
      if (found) {
        message.parts[found.tracker.partIndex] = {
          ...toolBase(found.part),
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        };
      } else {
        const partIndex = message.parts.length;
        message.parts.push({
          ...toolBase(chunk),
          state: 'output-error',
          input: chunk.input,
          errorText: chunk.errorText,
        });
        trackers.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      }
      return state;
    }
  }
};
