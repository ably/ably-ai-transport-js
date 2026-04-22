/**
 * Shared tool part transition logic for the Vercel AI SDK codec.
 *
 * Extracted from the accumulator so the tool output state transition logic
 * lives in one place, reusable by the accumulator and any other callers.
 */

import type * as AI from 'ai';

import { stripUndefined } from '../../utils.js';

// ---------------------------------------------------------------------------
// Tool output chunk type guard
// ---------------------------------------------------------------------------

/** The set of UIMessageChunk types that represent tool output transitions. */
export type ToolOutputChunk = Extract<
  AI.UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' | 'tool-approval-request' }
>;

/**
 * Whether a UIMessageChunk is a tool output transition event.
 * @param chunk - The chunk to test.
 * @returns True if the chunk is a tool output transition type.
 */
export const isToolOutputChunk = (chunk: AI.UIMessageChunk): chunk is ToolOutputChunk =>
  chunk.type === 'tool-output-available' ||
  chunk.type === 'tool-output-error' ||
  chunk.type === 'tool-output-denied' ||
  chunk.type === 'tool-approval-request';

// ---------------------------------------------------------------------------
// Tool base helper
// ---------------------------------------------------------------------------

/** Fields shared by all DynamicToolUIPart state variants. */
interface ToolBaseFields {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  title?: string;
  providerExecuted?: boolean;
}

/**
 * Extract the state-independent base fields for a DynamicToolUIPart.
 * Works with both chunks (tool-input-start, etc.) and existing parts.
 * @param source - Any object containing the required tool identity fields.
 * @param source.toolCallId - The tool call identifier.
 * @param source.toolName - The tool name.
 * @param source.title - Optional display title.
 * @param source.providerExecuted - Whether the provider executed the tool.
 * @returns Base fields shared across all DynamicToolUIPart state variants.
 */
export const toolBase = (source: {
  toolCallId: string;
  toolName: string;
  title?: string;
  providerExecuted?: boolean;
}): ToolBaseFields =>
  stripUndefined({
    type: 'dynamic-tool' as const,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    title: source.title,
    providerExecuted: source.providerExecuted,
  });

// ---------------------------------------------------------------------------
// Tool part transition
// ---------------------------------------------------------------------------

/**
 * Transition a DynamicToolUIPart to a new state based on a tool output chunk.
 * Pure function — does not mutate the input part.
 * @param part - The existing tool part to transition.
 * @param chunk - The tool output chunk describing the transition.
 * @returns A new DynamicToolUIPart in the target state.
 */
export const transitionToolPart = (part: AI.DynamicToolUIPart, chunk: ToolOutputChunk): AI.DynamicToolUIPart => {
  const base = toolBase(part);

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

// ---------------------------------------------------------------------------
// Approval response transition (server-side, not a wire chunk)
// ---------------------------------------------------------------------------

/**
 * Describes a user's response to a tool approval request. Not a wire chunk —
 * `approval-responded` is a UIMessage state that the Vercel AI SDK's
 * `convertToModelMessages` understands directly.
 */
export interface ApprovalResponse {
  /** Stable approval identifier, preserved across the request/response cycle. */
  id: string;
  /** Whether the user approved or denied. */
  approved: boolean;
  /** Optional reason accompanying the response. */
  reason?: string;
}

/**
 * Build the `approval-responded` variant of a DynamicToolUIPart. Pure.
 *
 * The union discriminator rejects a `...part` spread when moving between
 * state variants with different approval/output shapes, so the variant is
 * constructed from the extracted base fields plus the new approval record.
 * @param part - The existing tool part whose identity fields to preserve.
 * @param response - The approval response to apply.
 * @returns A new DynamicToolUIPart in state `approval-responded`.
 */
export const applyApprovalResponseToPart = (
  part: AI.DynamicToolUIPart,
  response: ApprovalResponse,
): AI.DynamicToolUIPart =>
  stripUndefined({
    ...toolBase(part),
    state: 'approval-responded' as const,
    input: part.input,
    approval: stripUndefined({ id: response.id, approved: response.approved, reason: response.reason }),
  });

/**
 * Build the `output-denied` variant of a DynamicToolUIPart. Pure.
 * @param part - The existing tool part whose identity fields to preserve.
 * @param approvalId - The approval id to record on the denied part.
 * @returns A new DynamicToolUIPart in state `output-denied`.
 */
export const applyApprovalDeniedToPart = (part: AI.DynamicToolUIPart, approvalId: string): AI.DynamicToolUIPart => ({
  ...toolBase(part),
  state: 'output-denied',
  input: part.input,
  approval: { id: approvalId, approved: false as const },
});
