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

import type { ToolApprovalResponse, ToolResult, ToolResultError } from '../../core/codec/index.js';
import type { ToolPart } from '../tool-part.js';
import type {
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './events.js';
import { getToolPart, type OwnerLookup, type PendingToolResolution, type VercelCtx } from './reducer-state.js';
import { toolIdentity, transitionToolPart } from './tool-transitions.js';

/**
 * Fold a user message into the projection, correlating on the wire
 * codec-message-id via `ctx.ensure` (the caller's `message.id` is preserved
 * verbatim). A multi-part user message fans out into one wire event per part,
 * all sharing the codec-message-id. The first fold seeds the entry with the
 * incoming message verbatim; each later fold appends the incoming parts to the
 * seeded entry, reassembling the message part by part. The transport delivers
 * each wire exactly once (its per-message version high-water-mark drops
 * replays), so the merge sees every part once and stays consistent.
 *
 * Optimistic (serial-less) seeds need no special handling here: the transport
 * refolds the node from its log when the echo's serial arrives, rebuilding the
 * projection from a fresh `init` so the seed never coexists with its echo.
 * @param ctx - The fold-body capability object.
 * @param message - The user message (or one decoded part of it) to add or merge.
 */
export const foldUserMessage = (ctx: VercelCtx, message: AI.UIMessage): void => {
  // Seed the entry with the incoming message verbatim on first contact so the
  // caller-supplied `message.id` and role are surfaced unchanged. `ensure`
  // returns that same seed reference on the create, so a returned message that
  // is not the incoming one identifies a subsequent part of a multi-part
  // message; append its parts to the already-seeded entry.
  const entry = ctx.ensure(message.role, message);
  if (entry.message !== message) {
    entry.message.parts.push(...message.parts);
  }
};

/**
 * Fold a client-published `ToolResult`. The input carries
 * `codecMessageId` pointing at the assistant whose tool part holds the
 * matching `toolCallId`. If the assistant and its matching tool part are
 * both present, fold directly; otherwise pend until that tool part arrives.
 * @param ctx - The fold-body capability object.
 * @param event - The tool-result input (codecMessageId + domain payload).
 */
export const foldClientToolResult = (ctx: VercelCtx, event: ToolResult<VercelToolResultPayload>): void => {
  const { toolCallId, output } = event.payload;
  resolveOrPend(ctx, event.codecMessageId, toolCallId, { kind: 'tool-result', output });
};

/**
 * Fold a client-published `ToolResultError`. Mirrors
 * {@link foldClientToolResult} but with the error transition.
 * @param ctx - The fold-body capability object.
 * @param event - The tool-result-error input (codecMessageId + domain payload).
 */
export const foldClientToolResultError = (
  ctx: VercelCtx,
  event: ToolResultError<VercelToolResultErrorPayload>,
): void => {
  const { toolCallId, message } = event.payload;
  resolveOrPend(ctx, event.codecMessageId, toolCallId, { kind: 'tool-result-error', message });
};

/**
 * Fold a client-published `ToolApprovalResponse`. The input carries
 * `codecMessageId` pointing at the assistant whose tool part holds the
 * matching `toolCallId`. Approval → `approval-responded`;
 * denial → `output-denied` via {@link transitionToolPart}.
 * @param ctx - The fold-body capability object.
 * @param event - The approval-response input.
 */
export const foldToolApprovalResponse = (
  ctx: VercelCtx,
  event: ToolApprovalResponse<VercelToolApprovalResponsePayload>,
): void => {
  const { toolCallId, approved, reason } = event.payload;
  resolveOrPend(ctx, event.codecMessageId, toolCallId, {
    kind: 'tool-approval-response',
    approved,
    ...(reason === undefined ? {} : { reason }),
  });
};

/**
 * Apply a resolution when its tool part is present, otherwise buffer it in
 * `ctx.extra.pending` for {@link retryPendingResolutions}.
 * @param ctx - The fold-body capability object.
 * @param codecMessageId - The assistant the resolution targets.
 * @param toolCallId - The tool call being resolved.
 * @param resolution - The resolution variant to apply or buffer.
 */
const resolveOrPend = (
  ctx: VercelCtx,
  codecMessageId: string,
  toolCallId: string,
  resolution: PendingToolResolution['resolution'],
): void => {
  const owner = findOwner(ctx, codecMessageId, toolCallId);
  if (owner) {
    applyResolution(owner, toolCallId, resolution);
  } else {
    ctx.extra.pending.push({ targetCodecMessageId: codecMessageId, toolCallId, resolution });
  }
};

/**
 * Apply one tool resolution onto its located tool part, replacing the part with
 * the transitioned shape — the single application point shared by the direct
 * folds and {@link retryPendingResolutions}.
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
 * @param ctx - The fold-body capability object.
 */
export const retryPendingResolutions = (ctx: VercelCtx): void => {
  const next: PendingToolResolution[] = [];
  for (const pending of ctx.extra.pending) {
    const owner = findOwner(ctx, pending.targetCodecMessageId, pending.toolCallId);
    if (!owner) {
      next.push(pending);
      continue;
    }
    applyResolution(owner, pending.toolCallId, pending.resolution);
  }
  ctx.extra.pending = next;
};

const findOwner = (ctx: VercelCtx, codecMessageId: string, toolCallId: string): OwnerLookup | undefined => {
  const entry = ctx.lookup(codecMessageId);
  if (!entry) return undefined;
  const found = getToolPart(entry.message, entry.tracker, toolCallId);
  if (!found) return undefined;
  return { message: entry.message, tracker: found.tracker, part: found.part };
};

/**
 * Build the next tool part shape for an approval response, preserving the
 * part's representation (`dynamic-tool` vs `tool-${name}`).
 *
 * For `approved=true`, transition to `approval-responded` so the AI SDK's
 * multi-step loop will auto-run the tool on the next step.
 * `transitionToolPart` has no shape for this transition, so we synthesize
 * the part directly.
 *
 * For `approved=false`, delegate to `transitionToolPart` with a synthetic
 * `tool-output-denied` chunk so denial mirrors the chunk-driven path.
 * @param part - The existing tool part being transitioned.
 * @param approved - Whether the user approved the tool execution.
 * @param reason - Optional human-readable reason.
 * @returns The replacement tool part, in the input part's representation.
 */
const approvalTransition = (part: ToolPart, approved: boolean, reason: string | undefined): ToolPart => {
  if (approved) {
    return {
      ...toolIdentity(part),
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
