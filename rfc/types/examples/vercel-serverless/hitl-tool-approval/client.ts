/**
 * HITL tool approval — client side.
 *
 * In AI SDK v6, a pending approval is surfaced as a `tool-${name}` part on
 * an assistant message in state `'approval-requested'`, carrying
 * `approval: { id }`. The user's decision is recorded by publishing a
 * `AI.ToolModelMessage` event containing a `tool-approval-response` part
 * targeting that assistant message. The Vercel codec's accumulator applies
 * the event — locating the `ToolUIPart` by `approvalId` and transitioning
 * its state to `'approval-responded'` — so the composed `UIMessage` that
 * `convertToModelMessages` sees on the agent side produces the
 * `tool-approval-response` that `streamText` needs.
 *
 * Transport-level shape: one additive channel op per decision, routed via
 * `run.sendEvents({ messageId })`. No full-message republish, no mutation
 * of domain state at the client — the oplog composes the final state.
 */

import type * as AI from 'ai';
import { getToolName, isToolUIPart } from 'ai';

import type { ClientRun, ClientView, Codec } from '../../../index.js';

/**
 * Alias the codec variant once; the session, view, and run types all follow
 * from it. Keeps the rest of the file readable and matches the
 * session-by-codec pattern.
 */
type VercelApprovalCodec = Codec<AI.UIMessageChunk, AI.UIMessage, AI.ToolModelMessage>;

/**
 * Scan the view for the outstanding tool approval on the last assistant
 * message (if any).
 * @param view - The client view to scan.
 * @returns The pending approval metadata, or `undefined` if none is outstanding.
 */
const findPending = (
  view: ClientView<VercelApprovalCodec>,
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

declare const view: ClientView<VercelApprovalCodec>;
declare const renderApprovalPrompt: (pending: ReturnType<typeof findPending>) => void;

view.subscribe(() => {
  renderApprovalPrompt(findPending(view));
});

/**
 * Record the user's decision on a pending approval and wake the agent.
 * Publishes a `AI.ToolModelMessage` carrying a single
 * `tool-approval-response` content part, targeting the assistant message
 * that holds the `approval-requested` tool part.
 * @param run - The suspended client run holding the approval.
 * @param approvalId - The `approval.id` of the `approval-requested` tool part.
 * @param assistantMessageId - The ID of the assistant message to target.
 * @param approved - Whether the user approved or denied the tool call.
 * @param reason - Optional free-text justification surfaced to the model.
 */
export const respond = async (
  run: ClientRun<VercelApprovalCodec>,
  approvalId: string,
  assistantMessageId: string,
  approved: boolean,
  reason?: string,
): Promise<void> => {
  await run.sendEvents(
    {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          approved,
          ...(reason === undefined ? {} : { reason }),
        },
      ],
    },
    { messageId: assistantMessageId },
  );

  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};
