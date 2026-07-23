/**
 * Tool-input streaming folds: tool-input-start / -delta / -available / -error.
 * Tool deltas arrive as raw JSON fragments accumulated in the tracker's
 * `inputText` buffer and parsed on each delta.
 */

import type * as AI from 'ai';

import { parseJson } from '../../utils.js';
import { getToolPart, type VercelCtx } from './reducer-state.js';
import { toolBase, toolIdentity } from './tool-transitions.js';

/**
 * Fold a tool-input streaming chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The tool-input start, delta, available, or error chunk.
 */
export const foldToolInput = (
  ctx: VercelCtx,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-input-start' | 'tool-input-delta' | 'tool-input-available' | 'tool-input-error' }
  >,
): void => {
  const { message, tracker } = ctx.ensure('assistant');

  switch (chunk.type) {
    case 'tool-input-start': {
      const partIndex = message.parts.length;
      message.parts.push({ ...toolBase(chunk), state: 'input-streaming', input: undefined });
      tracker.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      return;
    }
    case 'tool-input-delta': {
      const toolTracker = tracker.tools.get(chunk.toolCallId);
      if (!toolTracker) return;
      toolTracker.inputText += chunk.inputTextDelta;

      const parsedInput = parseJson(toolTracker.inputText);

      const found = getToolPart(message, tracker, chunk.toolCallId);
      if (!found) return;
      message.parts[found.tracker.partIndex] = {
        ...toolIdentity(found.part),
        state: 'input-streaming',
        input: parsedInput,
      };
      return;
    }
    case 'tool-input-available': {
      const found = getToolPart(message, tracker, chunk.toolCallId);
      if (!found) return;
      message.parts[found.tracker.partIndex] = {
        ...toolIdentity(found.part),
        state: 'input-available',
        input: chunk.input,
      };
      return;
    }
    case 'tool-input-error': {
      const found = getToolPart(message, tracker, chunk.toolCallId);
      if (found) {
        message.parts[found.tracker.partIndex] = {
          ...toolIdentity(found.part),
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
        tracker.tools.set(chunk.toolCallId, { partIndex, inputText: '' });
      }
      return;
    }
  }
};
