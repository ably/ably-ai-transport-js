/**
 * Cross-turn event application for the Vercel AI SDK codec.
 *
 * When an event (e.g. `tool-output-available`) targets a message from a
 * previous turn, the client transport calls `applyEvent` to update the
 * existing message in the conversation tree. This is the Vercel-specific
 * implementation that knows how to update `DynamicToolUIPart` states.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';

/**
 * Apply a decoded UIMessageChunk event to an existing UIMessage.
 *
 * Finds the `dynamic-tool` part matching the event's `toolCallId` and
 * transitions it to the appropriate terminal state. Returns the updated
 * message, or undefined if the event is not applicable.
 * @param message - The existing UIMessage to update.
 * @param event - The decoded UIMessageChunk event to apply.
 * @returns The updated UIMessage, or undefined if the event is not applicable.
 */
export const applyEvent = (message: AI.UIMessage, event: AI.UIMessageChunk): AI.UIMessage | undefined => {
  switch (event.type) {
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied': {
      return applyToolOutput(message, event);
    }
    default: {
      return undefined;
    }
  }
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type ToolOutputChunk = Extract<
  AI.UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' }
>;

/**
 * Find a dynamic-tool part by toolCallId and update its state.
 * Returns a shallow copy of the message with the updated part, or
 * undefined if no matching part was found.
 * @param message - The existing UIMessage containing the tool part.
 * @param chunk - The tool output chunk with the resolved state.
 * @returns The updated UIMessage, or undefined if no matching tool part was found.
 */
const applyToolOutput = (message: AI.UIMessage, chunk: ToolOutputChunk): AI.UIMessage | undefined => {
  const partIndex = message.parts.findIndex((p) => p.type === 'dynamic-tool' && p.toolCallId === chunk.toolCallId);
  if (partIndex === -1) return undefined;

  // CAST: findIndex above checked p.type === 'dynamic-tool', narrowing to DynamicToolUIPart
  const existing = message.parts[partIndex] as AI.DynamicToolUIPart;
  const base = {
    type: 'dynamic-tool' as const,
    toolCallId: existing.toolCallId,
    toolName: existing.toolName,
    ...(existing.title !== undefined && { title: existing.title }),
    ...(existing.providerExecuted !== undefined && { providerExecuted: existing.providerExecuted }),
  };

  const updatedParts = [...message.parts];

  switch (chunk.type) {
    case 'tool-output-available': {
      updatedParts[partIndex] = stripUndefined({
        ...base,
        state: 'output-available' as const,
        input: existing.input,
        output: chunk.output,
        preliminary: chunk.preliminary,
        // Preserve approval metadata so the UI can identify this was an approved tool call
        approval: existing.approval ? { id: existing.approval.id, approved: true as const } : undefined,
      });
      break;
    }
    case 'tool-output-error': {
      updatedParts[partIndex] = {
        ...base,
        state: 'output-error' as const,
        input: existing.input,
        errorText: chunk.errorText,
      };
      break;
    }
    case 'tool-output-denied': {
      updatedParts[partIndex] = {
        ...base,
        state: 'output-denied' as const,
        input: existing.input,
        approval: { id: existing.approval?.id ?? '', approved: false as const },
      };
      break;
    }
  }

  return { ...message, parts: updatedParts };
};
