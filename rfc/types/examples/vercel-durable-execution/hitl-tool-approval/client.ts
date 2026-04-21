/**
 * HITL tool approval — client side (durable execution).
 *
 * Identical to the serverless variant. The client publishes the user's
 * approval as a regular user message, then invokes the workflow endpoint
 * with the approval's message ID as precondition — the fresh workflow
 * run waits for the approval to be visible before starting.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientSession, InvocationData, MessageNode } from '../../../index.js';

/**
 * Deliver an invocation to the workflow endpoint.
 * @param data - The {@link InvocationData} identifying run and approval message.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeWorkflow = async (data: InvocationData): Promise<void> => {
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Approve or deny a pending tool call. The run must be suspended for the
 * approval to make sense; the node carries its run so no lookup is needed.
 * @param session - The client session backing the UI.
 * @param toolCallNode - The assistant node whose tool call is pending approval.
 * @param approved - True if the user clicked Approve, false if Deny.
 * @returns Resolves once the approval has been published and the workflow re-invoked.
 */
export const onApprove = async (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  toolCallNode: MessageNode<AI.UIMessage, ClientRun<AI.UIMessage>>,
  approved: boolean,
): Promise<void> => {
  const run = toolCallNode.run;
  if (run?.status !== 'suspended') return;

  const approvalMessageId = crypto.randomUUID();
  await run.send({
    id: approvalMessageId,
    role: 'user',
    parts: [{ type: 'text', text: approved ? 'approved' : 'denied' }],
  });

  await invokeWorkflow({
    sessionName: session.name,
    runId: run.id,
    messageId: approvalMessageId,
  });
};
