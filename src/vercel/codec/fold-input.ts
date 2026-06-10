/**
 * Client-published input folds and the pending-resolution buffering.
 *
 * Tool resolutions (`ToolResult`, `ToolResultError`, `ToolApprovalResponse`)
 * carry a `codecMessageId` targeting the assistant they amend. When that
 * assistant (or its tool part) has not yet arrived, the resolution is buffered
 * in `pendingToolResolutions` and {@link retryPendingResolutions} re-evaluates
 * it after every subsequent fold.
 */

import type * as AI from 'ai';

import type { ReducerMeta, ToolApprovalResponse, ToolResult, ToolResultError } from '../../core/codec/index.js';
import type {
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './events.js';
import { ensureTrackers, getToolPart, type OwnerLookup, type VercelProjection } from './reducer-state.js';
import { toolBase, transitionToolPart } from './tool-transitions.js';

/**
 * Fold a user message into the projection, correlating on the wire
 * codec-message-id (the caller's `message.id` is preserved verbatim).
 * @param state - Projection to fold into.
 * @param message - The user message to add or replace.
 * @param meta - Transport-derived metadata carrying the codec-message-id.
 * @returns The same projection reference.
 */
export const foldUserMessage = (
  state: VercelProjection,
  message: AI.UIMessage,
  meta: ReducerMeta,
): VercelProjection => {
  // Correlate the projection entry on the wire codec-message-id; the
  // caller-supplied `message.id` is preserved verbatim and surfaced to the
  // application unchanged. Without a codec-message-id the message has no
  // identity to key on, so it is appended as a fresh entry.
  const codecMessageId = meta.messageId;
  if (codecMessageId === undefined) {
    state.messages.push({ codecMessageId: message.id, message });
    return state;
  }
  const existingIdx = state.messages.findIndex((e) => e.codecMessageId === codecMessageId);
  if (existingIdx === -1) {
    state.messages.push({ codecMessageId, message });
  } else {
    state.messages[existingIdx] = { codecMessageId, message };
  }
  return state;
};

/**
 * Fold a client-published `ToolResult`. The input carries
 * `codecMessageId` pointing at the assistant whose `dynamic-tool` part
 * holds the matching `toolCallId`. If the assistant and its matching
 * `dynamic-tool` part are both present, fold directly; otherwise pend
 * until that tool part arrives.
 * @param state - Projection to fold into.
 * @param event - The tool-result input (codecMessageId + domain payload).
 * @returns The same projection reference.
 */
export const foldClientToolResult = (
  state: VercelProjection,
  event: ToolResult<VercelToolResultPayload>,
): VercelProjection => {
  const { toolCallId, output } = event.payload;
  const owner = findOwner(state, event.codecMessageId, toolCallId);
  if (owner) {
    owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
      type: 'tool-output-available',
      toolCallId,
      output,
    });
    return state;
  }

  state.pendingToolResolutions.push({
    targetCodecMessageId: event.codecMessageId,
    toolCallId,
    resolution: { kind: 'tool-result', output },
  });
  return state;
};

/**
 * Fold a client-published `ToolResultError`. Mirrors
 * {@link foldClientToolResult} but with the error transition.
 * @param state - Projection to fold into.
 * @param event - The tool-result-error input (codecMessageId + domain payload).
 * @returns The same projection reference.
 */
export const foldClientToolResultError = (
  state: VercelProjection,
  event: ToolResultError<VercelToolResultErrorPayload>,
): VercelProjection => {
  const { toolCallId, message } = event.payload;
  const owner = findOwner(state, event.codecMessageId, toolCallId);
  if (owner) {
    owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
      type: 'tool-output-error',
      toolCallId,
      errorText: message,
    });
    return state;
  }

  state.pendingToolResolutions.push({
    targetCodecMessageId: event.codecMessageId,
    toolCallId,
    resolution: { kind: 'tool-result-error', message },
  });
  return state;
};

/**
 * Fold a client-published `ToolApprovalResponse`. The input carries
 * `codecMessageId` pointing at the assistant whose `dynamic-tool` part
 * holds the matching `toolCallId`. Approval → `approval-responded`;
 * denial → `output-denied` via {@link transitionToolPart}.
 * @param state - Projection to fold into.
 * @param event - The approval-response input.
 * @returns The same projection reference.
 */
export const foldToolApprovalResponse = (
  state: VercelProjection,
  event: ToolApprovalResponse<VercelToolApprovalResponsePayload>,
): VercelProjection => {
  const { toolCallId, approved, reason } = event.payload;
  const owner = findOwner(state, event.codecMessageId, toolCallId);
  if (owner) {
    owner.message.parts[owner.tracker.partIndex] = approvalTransition(owner.part, approved, reason);
    return state;
  }

  state.pendingToolResolutions.push({
    targetCodecMessageId: event.codecMessageId,
    toolCallId,
    resolution: {
      kind: 'tool-approval-response',
      approved,
      ...(reason === undefined ? {} : { reason }),
    },
  });
  return state;
};

/**
 * Re-attempt every pending tool resolution against the current projection.
 * Successfully promoted entries are removed from the pending list. Cheap:
 * bounded by the number of pending entries.
 * @param state - Projection to walk and mutate.
 */
export const retryPendingResolutions = (state: VercelProjection): void => {
  const next: VercelProjection['pendingToolResolutions'] = [];
  for (const pending of state.pendingToolResolutions) {
    const owner = findOwner(state, pending.targetCodecMessageId, pending.toolCallId);
    if (!owner) {
      next.push(pending);
      continue;
    }
    switch (pending.resolution.kind) {
      case 'tool-result': {
        owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
          type: 'tool-output-available',
          toolCallId: pending.toolCallId,
          output: pending.resolution.output,
        });
        break;
      }
      case 'tool-result-error': {
        owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
          type: 'tool-output-error',
          toolCallId: pending.toolCallId,
          errorText: pending.resolution.message,
        });
        break;
      }
      case 'tool-approval-response': {
        owner.message.parts[owner.tracker.partIndex] = approvalTransition(
          owner.part,
          pending.resolution.approved,
          pending.resolution.reason,
        );
        break;
      }
    }
  }
  state.pendingToolResolutions = next;
};

const findOwner = (state: VercelProjection, codecMessageId: string, toolCallId: string): OwnerLookup | undefined => {
  const entry = state.messages.find((e) => e.codecMessageId === codecMessageId);
  if (!entry) return undefined;
  const trackers = ensureTrackers(state, codecMessageId);
  const found = getToolPart(entry.message, trackers, toolCallId);
  if (!found) return undefined;
  return { message: entry.message, tracker: found.tracker, part: found.part };
};

/**
 * Build the next `dynamic-tool` part shape for an approval response.
 *
 * For `approved=true`, transition to `approval-responded` so the AI SDK's
 * multi-step loop will auto-run the tool on the next step.
 * `transitionToolPart` has no shape for this transition, so we synthesize
 * the part directly.
 *
 * For `approved=false`, delegate to `transitionToolPart` with a synthetic
 * `tool-output-denied` chunk so denial mirrors the chunk-driven path.
 * @param part - The existing `dynamic-tool` part being transitioned.
 * @param approved - Whether the user approved the tool execution.
 * @param reason - Optional human-readable reason.
 * @returns The replacement `dynamic-tool` part.
 */
const approvalTransition = (
  part: AI.DynamicToolUIPart,
  approved: boolean,
  reason: string | undefined,
): AI.DynamicToolUIPart => {
  if (approved) {
    return {
      ...toolBase(part),
      state: 'approval-responded',
      input: 'input' in part ? part.input : undefined,
      approval: {
        id: 'approval' in part && part.approval ? part.approval.id : '',
        approved: true,
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }
  return transitionToolPart(part, {
    type: 'tool-output-denied',
    toolCallId: part.toolCallId,
    ...(reason === undefined ? {} : { reason }),
  });
};
