/**
 * Shared tool part transition logic for the Vercel AI SDK codec.
 *
 * Keeps the tool output state transition logic in one place, reusable by the
 * Vercel codec reducer and any other callers.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';
import type { ToolPart } from '../tool-part.js';

// ---------------------------------------------------------------------------
// Tool output chunk type
// ---------------------------------------------------------------------------

/** The set of UIMessageChunk types that represent tool output transitions. */
export type ToolOutputChunk = Extract<
  AI.UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' | 'tool-approval-request' }
>;

// ---------------------------------------------------------------------------
// Tool base helper
// ---------------------------------------------------------------------------

/**
 * State-independent identity fields of a tool part, carrying its representation
 * in `type`: a dynamic tool is `dynamic-tool` with an explicit `toolName`; a
 * statically-declared tool is `tool-${name}`, whose name is encoded in the type
 * (the AI SDK's `ToolUIPart` shape carries no separate `toolName`).
 */
export type ToolBase =
  | { type: 'dynamic-tool'; toolName: string; toolCallId: string; title?: string; providerExecuted?: boolean }
  | { type: `tool-${string}`; toolCallId: string; title?: string; providerExecuted?: boolean };

/**
 * Build the identity base for a newly-created tool part from wire/chunk fields.
 * @param source - The tool identity fields, plus the `dynamic` flag deciding the representation.
 * @param source.toolCallId - The tool call identifier.
 * @param source.toolName - The tool name.
 * @param source.dynamic - True for a dynamic tool (`dynamic-tool`); false/absent for a static `tool-${name}` part.
 * @param source.title - Optional display title.
 * @param source.providerExecuted - Whether the provider executed the tool.
 * @returns The identity base, in the representation selected by `dynamic`.
 */
export const toolBase = (source: {
  toolCallId: string;
  toolName: string;
  dynamic?: boolean;
  title?: string;
  providerExecuted?: boolean;
}): ToolBase =>
  source.dynamic
    ? stripUndefined({
        type: 'dynamic-tool' as const,
        toolCallId: source.toolCallId,
        toolName: source.toolName,
        title: source.title,
        providerExecuted: source.providerExecuted,
      })
    : stripUndefined({
        type: `tool-${source.toolName}` as const,
        toolCallId: source.toolCallId,
        title: source.title,
        providerExecuted: source.providerExecuted,
      });

/**
 * Preserve the identity base of an existing tool part when transitioning it to
 * a new state — keeps its representation (`dynamic-tool` vs `tool-${name}`), so
 * a statically-declared tool part is never rewritten to `dynamic-tool`.
 * @param part - The existing tool part being transitioned.
 * @returns The identity base carrying the part's own `type`.
 */
export const toolIdentity = (part: ToolPart): ToolBase =>
  part.type === 'dynamic-tool'
    ? stripUndefined({
        type: part.type,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        title: part.title,
        providerExecuted: part.providerExecuted,
      })
    : stripUndefined({
        type: part.type,
        toolCallId: part.toolCallId,
        title: part.title,
        providerExecuted: part.providerExecuted,
      });

// ---------------------------------------------------------------------------
// Tool part transition
// ---------------------------------------------------------------------------

/**
 * Transition a tool part to a new state based on a tool output chunk. Preserves
 * the part's representation (`dynamic-tool` vs `tool-${name}`) — a static tool
 * part stays static. Pure function — does not mutate the input part.
 * @param part - The existing tool part to transition.
 * @param chunk - The tool output chunk describing the transition.
 * @returns A new tool part in the target state, in the input part's representation.
 */
export const transitionToolPart = (part: ToolPart, chunk: ToolOutputChunk): ToolPart => {
  const base = toolIdentity(part);

  switch (chunk.type) {
    case 'tool-output-available': {
      return stripUndefined({
        ...base,
        state: 'output-available' as const,
        input: part.input,
        output: chunk.output,
        preliminary: chunk.preliminary,
      });
    }

    case 'tool-output-error': {
      return {
        ...base,
        state: 'output-error',
        input: part.input,
        errorText: chunk.errorText,
      };
    }

    case 'tool-output-denied': {
      return {
        ...base,
        state: 'output-denied',
        input: part.input,
        approval: { id: '', approved: false },
      };
    }

    case 'tool-approval-request': {
      return {
        ...base,
        state: 'approval-requested',
        input: part.input,
        approval: { id: chunk.approvalId },
      };
    }
  }
};
