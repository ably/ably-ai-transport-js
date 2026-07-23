/**
 * Agent-published tool-output transitions: tool-output-available /
 * tool-output-error / tool-output-denied / tool-approval-request.
 */

import type * as AI from 'ai';

import { getToolPart, type OwnerLookup, type VercelCtx } from './reducer-state.js';
import { transitionToolPart } from './tool-transitions.js';

/**
 * Locate the tool part for a `toolCallId` anywhere in the projection.
 * Agent-emitted second-pass tool outputs (after an approved tool runs) are
 * stamped with a fresh codec-message-id that differs from the assistant holding
 * the tool call, so they can't be found via `meta.messageId` — they fold onto
 * whichever message holds the matching tool call (created in the first pass or
 * by an approval response).
 * @param ctx - The fold-body capability object.
 * @param toolCallId - The tool call to locate.
 * @returns The owning message, tracker, and part, or `undefined` if absent.
 */
const findToolPartOwner = (ctx: VercelCtx, toolCallId: string): OwnerLookup | undefined => {
  for (const entry of ctx.entries()) {
    const found = getToolPart(entry.message, entry.tracker, toolCallId);
    if (found) return { message: entry.message, tracker: found.tracker, part: found.part };
  }
  return undefined;
};

/**
 * Fold an agent-published tool-output chunk into the projection.
 * @param ctx - The fold-body capability object.
 * @param chunk - The tool-output-available/-error/-denied or tool-approval-request chunk.
 */
export const foldToolOutput = (
  ctx: VercelCtx,
  chunk: Extract<
    AI.UIMessageChunk,
    { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' | 'tool-approval-request' }
  >,
): void => {
  // `tool-output-available` / `tool-output-error` after an approved tool runs
  // are emitted by streamText's continuation pass under a fresh
  // codec-message-id that differs from the assistant holding the tool call.
  // Resolve the owning part by toolCallId across the whole projection so the
  // output folds onto the original message. Deliberately do NOT `ensure` the
  // current message first. That would leave a phantom empty message behind the
  // fresh id. Drop on miss: a tool output with no matching tool call has no
  // anchor to attach to.
  if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
    const owner = findToolPartOwner(ctx, chunk.toolCallId);
    if (!owner) return;
    owner.message.parts[owner.tracker.partIndex] = transitionToolPart(owner.part, chunk);
    return;
  }

  // `tool-approval-request` (first pass) creates the part on the run's own
  // message; `tool-output-denied` transitions that same part. Both key on the
  // current event's codec-message-id.
  const { message, tracker } = ctx.ensure('assistant');

  const found = getToolPart(message, tracker, chunk.toolCallId);
  if (!found) return;

  message.parts[found.tracker.partIndex] = transitionToolPart(found.part, chunk);
};
