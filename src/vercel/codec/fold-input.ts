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
import { isToolPart, type ToolPart } from '../tool-part.js';
import type {
  ForkSeed,
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
import { toolIdentity, transitionToolPart } from './tool-transitions.js';

/**
 * Fold a user message into the projection, correlating on the wire
 * codec-message-id (the caller's `message.id` is preserved verbatim). A
 * multi-part user message fans out into one wire event per part, all sharing
 * the codec-message-id — folding appends the incoming parts to the existing
 * entry, reassembling the message part by part. The transport delivers each
 * wire exactly once (its per-message version high-water-mark drops replays),
 * so the merge sees every part once and stays consistent.
 *
 * Optimistic (serial-less) seeds need no special handling here: the transport
 * refolds the node from its log when the echo's serial arrives, rebuilding the
 * projection from a fresh `init` so the seed never coexists with its echo.
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
  const existing = state.messages.find((e) => e.codecMessageId === codecMessageId);
  if (existing === undefined) {
    state.messages.push({ codecMessageId, message });
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
 * `codecMessageId` pointing at the assistant whose tool part holds the
 * matching `toolCallId`. If the assistant and its matching tool part are
 * both present, fold directly; otherwise pend until that tool part arrives.
 * @param state - Projection to fold into.
 * @param event - The tool-result input (codecMessageId + domain payload).
 * @returns The same projection reference.
 */
export const foldClientToolResult = (
  state: VercelProjection,
  event: ToolResult<VercelToolResultPayload>,
): VercelProjection => {
  const { toolCallId, output, forkSeed } = event.payload;
  seedForkIfAbsent(state, event.codecMessageId, forkSeed);
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
  const { toolCallId, message, forkSeed } = event.payload;
  seedForkIfAbsent(state, event.codecMessageId, forkSeed);
  return resolveOrPend(state, event.codecMessageId, toolCallId, { kind: 'tool-result-error', message });
};

/**
 * Fold a client-published `ToolApprovalResponse`. The input carries
 * `codecMessageId` pointing at the assistant whose tool part holds the
 * matching `toolCallId`. Approval → `approval-responded`;
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
 * Reconstruct the suspended run's full message list from a fork continuation's
 * {@link ForkSeed} when the target assistant is absent from THIS projection —
 * the seam that makes a fork run self-contained (see {@link ForkSeed}). A no-op
 * when the seed is absent (an ordinary result folding onto an assistant the
 * projection already holds) or when the target is already present (a refold
 * whose earlier wire seeded it, or a non-fork result) — so it is idempotent
 * across refolds.
 *
 * Every seed message is reconstructed under its OWN (fresh) codec-message-id,
 * carrying its parts in their current state — earlier tool calls already
 * resolved, the current one still awaiting this fork's result. Seeding the whole
 * run (not just the current tool-call assistant) preserves context across
 * SEQUENTIAL client tool calls. A tracker is registered for each tool part so
 * resolution — and any later fold — locates it by `toolCallId`, exactly as the
 * streaming tool-input fold would have. The caller then applies this fork's
 * result onto the target via {@link resolveOrPend}.
 * @param state - Projection to seed into.
 * @param targetCodecMessageId - The result's target codec-message-id; the seed
 *   is applied only when this target is absent (the guard against re-seeding).
 * @param seed - The reconstruction seed, if the input carried one.
 */
const seedForkIfAbsent = (state: VercelProjection, targetCodecMessageId: string, seed: ForkSeed | undefined): void => {
  if (seed === undefined) return;
  // Guard on the TARGET's presence: once the fork's own wire (or a prior
  // refold) has seeded the run, replaying the seed is a no-op.
  if (state.messages.some((e) => e.codecMessageId === targetCodecMessageId)) return;
  for (const { codecMessageId, message } of seed.messages) {
    // Skip a message already present (defensive against a seed that overlaps
    // an existing entry); reconstruct the rest.
    if (state.messages.some((e) => e.codecMessageId === codecMessageId)) continue;
    // Copy the parts array (the seed is shared wire data, replayed on every
    // refold); resolutions REPLACE parts by index rather than mutating them, so
    // a shallow array copy is sufficient and mirrors the existing input folds.
    const parts = [...message.parts];
    state.messages.push({ codecMessageId, message: { ...message, parts } });
    const trackers = ensureTrackers(state, codecMessageId);
    for (const [partIndex, part] of parts.entries()) {
      if (isToolPart(part)) trackers.tools.set(part.toolCallId, { partIndex, inputText: '' });
    }
  }
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
