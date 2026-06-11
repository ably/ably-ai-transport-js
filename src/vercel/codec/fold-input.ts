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
import {
  ensureTrackers,
  getToolPart,
  type OwnerLookup,
  type PendingToolResolution,
  type VercelProjection,
} from './reducer-state.js';
import { toolBase, transitionToolPart } from './tool-transitions.js';

/**
 * Fold a user message into the projection, correlating on the wire
 * codec-message-id (the caller's `message.id` is preserved verbatim). A
 * multi-part user message fans out into one wire event per part, all sharing
 * the codec-message-id — folding appends the incoming parts to the existing
 * entry, reassembling the message part by part. Replays of an
 * already-folded wire part are dropped upstream by the per-serial conflict
 * key (see `conflictKeyOf`), keeping the merge idempotent.
 * @param state - Projection to fold into.
 * @param message - The user message (or one decoded part of it) to add or merge.
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
  const fromWire = meta.serial !== '';
  const existing = state.messages.find((e) => e.codecMessageId === codecMessageId);
  if (existing === undefined) {
    state.messages.push({ codecMessageId, message });
    if (!fromWire) state.optimisticUserMessages.add(codecMessageId);
  } else if (fromWire && state.optimisticUserMessages.has(codecMessageId)) {
    // The first wire-serialed fold replaces an optimistic (serial-less) seed
    // wholesale: the wire re-delivers the entire message, so keeping the
    // seeded parts would duplicate every one of them.
    existing.message = message;
    state.optimisticUserMessages.delete(codecMessageId);
  } else {
    // Merge by codec-message-id: keep the existing envelope (id and role are
    // stamped identically on every part of one message) and append the
    // incoming parts in fold order — wire serials preserve publish order.
    existing.message.parts.push(...message.parts);
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
  return resolveOrPend(state, event.codecMessageId, toolCallId, { kind: 'tool-result', output });
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
  return resolveOrPend(state, event.codecMessageId, toolCallId, { kind: 'tool-result-error', message });
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
  return resolveOrPend(state, event.codecMessageId, toolCallId, {
    kind: 'tool-approval-response',
    approved,
    ...(reason === undefined ? {} : { reason }),
  });
};

/**
 * Apply a resolution when its tool part is present, otherwise buffer it in
 * `pendingToolResolutions` for {@link retryPendingResolutions}.
 * @param state - Projection to fold into.
 * @param codecMessageId - The assistant the resolution targets.
 * @param toolCallId - The tool call being resolved.
 * @param resolution - The resolution variant to apply or buffer.
 * @returns The same projection reference.
 */
const resolveOrPend = (
  state: VercelProjection,
  codecMessageId: string,
  toolCallId: string,
  resolution: PendingToolResolution['resolution'],
): VercelProjection => {
  const owner = findOwner(state, codecMessageId, toolCallId);
  if (owner) {
    applyResolution(owner, toolCallId, resolution);
  } else {
    state.pendingToolResolutions.push({ targetCodecMessageId: codecMessageId, toolCallId, resolution });
  }
  return state;
};

/**
 * Apply one tool resolution onto its located `dynamic-tool` part, replacing
 * the part with the transitioned shape — the single application point shared
 * by the direct folds and {@link retryPendingResolutions}.
 * @param owner - The located owner (message + tracker + part).
 * @param toolCallId - The tool call being resolved.
 * @param resolution - The resolution variant to apply.
 */
const applyResolution = (
  owner: OwnerLookup,
  toolCallId: string,
  resolution: PendingToolResolution['resolution'],
): void => {
  switch (resolution.kind) {
    case 'tool-result': {
      owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
        type: 'tool-output-available',
        toolCallId,
        output: resolution.output,
      });
      break;
    }
    case 'tool-result-error': {
      owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, {
        type: 'tool-output-error',
        toolCallId,
        errorText: resolution.message,
      });
      break;
    }
    case 'tool-approval-response': {
      owner.message.parts[owner.tracker.partIndex] = approvalTransition(
        owner.part,
        resolution.approved,
        resolution.reason,
      );
      break;
    }
  }
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
    applyResolution(owner, pending.toolCallId, pending.resolution);
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
