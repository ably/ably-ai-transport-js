/**
 * HITL tool approval — client side.
 *
 * When the UI renders a suspended assistant message containing a tool-call
 * part, it prompts the user to approve or deny. The approval is published
 * as a user message and the agent is invoked with `messageId` as
 * precondition — the agent waits for the approval to be visible before
 * starting, so the conversation it reads includes the approval.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientSession, InvocationData, MessageNode } from '../../../index.js';

/**
 * Deliver an invocation to the agent HTTP endpoint.
 * @param data - The {@link InvocationData} identifying run and approval message.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Approve or deny a pending tool call. The run must be suspended for the
 * approval to make sense; the node carries its run so no lookup is needed.
 * @param session - The client session backing the UI.
 * @param toolCallNode - The assistant node whose tool call is pending approval.
 * @param approved - True if the user clicked Approve, false if Deny.
 * @returns Resolves once the approval message has been published and the agent re-invoked.
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

  // Resume with the approval message as precondition so the agent reads
  // a conversation that includes the user's decision.
  await invokeAgent({
    sessionName: session.name,
    runId: run.id,
    messageId: approvalMessageId,
  });
};
