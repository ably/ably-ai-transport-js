/**
 * HITL tool approval — client side (durable execution).
 *
 * Identical to the serverless variant in shape. In AI SDK v6 the user's
 * decision on a pending approval is recorded by mutating the assistant
 * message's `tool-${name}` part from state `'approval-requested'` to
 * `'approval-responded'`; `convertToModelMessages` on the server synthesises
 * the `tool-approval-response` that `streamText` reads. Publish the mutated
 * assistant message via `run.sendMessages`, then POST `run.toInvocation()`
 * to wake a fresh workflow run.
 */

import type * as AI from 'ai';
import { getToolName, isToolUIPart } from 'ai';

import type { ClientRun, ClientView } from '../../../index.js';

/**
 * Scan the view for the outstanding tool approval on the last assistant
 * message (if any).
 * @param view - The client view to scan.
 * @returns The pending approval metadata, or `undefined` if none is outstanding.
 */
const findPending = (
  view: ClientView<AI.UIMessageChunk, AI.UIMessage>,
): { approvalId: string; toolName: string; input: unknown; assistantMessageId: string } | undefined => {
  const last = view.messages.findLast((n) => n.message.role === 'assistant');
  if (!last) return undefined;
  for (const part of last.message.parts) {
    if (isToolUIPart(part) && part.state === 'approval-requested') {
      return {
        approvalId: part.approval.id,
        toolName: getToolName(part),
        input: part.input,
        assistantMessageId: last.id,
      };
    }
  }
  return undefined;
};

declare const view: ClientView<AI.UIMessageChunk, AI.UIMessage>;
declare const renderApprovalPrompt: (pending: ReturnType<typeof findPending>) => void;

view.subscribe(() => {
  renderApprovalPrompt(findPending(view));
});

/**
 * Record the user's decision on a pending approval and wake the workflow.
 * @param run - The suspended client run holding the approval.
 * @param approvalId - The `approval.id` of the `approval-requested` tool part.
 * @param approved - Whether the user approved or denied the tool call.
 * @param reason - Optional free-text justification surfaced to the model.
 */
export const respond = async (
  run: ClientRun<AI.UIMessageChunk, AI.UIMessage>,
  approvalId: string,
  approved: boolean,
  reason?: string,
): Promise<void> => {
  // Find the assistant message carrying the approval-requested part, and
  // rebuild it with that part flipped to approval-responded. Every other
  // part is copied through unchanged.
  const target = run.messages.find(
    (n) =>
      n.message.role === 'assistant' &&
      n.message.parts.some((p) => isToolUIPart(p) && p.state === 'approval-requested' && p.approval.id === approvalId),
  );
  if (!target) return;

  const mutated: AI.UIMessage = {
    ...target.message,
    parts: target.message.parts.map((part) => {
      if (isToolUIPart(part) && part.state === 'approval-requested' && part.approval.id === approvalId) {
        return {
          ...part,
          state: 'approval-responded',
          approval: { id: approvalId, approved, ...(reason === undefined ? {} : { reason }) },
        };
      }
      return part;
    }),
  };

  await run.sendMessages(mutated);

  await fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};
