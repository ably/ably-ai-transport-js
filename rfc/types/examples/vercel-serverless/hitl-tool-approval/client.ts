/**
 * HITL tool approval — client side.
 *
 * When the UI renders a suspended assistant message containing a tool-call
 * part, it prompts the user to approve or deny. The approval is published
 * as a structured tool-output user message targeting the specific
 * `toolCallId`, then the agent is re-invoked; the agent waits for the
 * approval to be visible before starting, so the conversation it reads
 * includes the approval.
 *
 * Targeting a specific tool call by `toolCallId` is type-enforced. The
 * Vercel-layer `pendingToolCalls` helper locates the pending call from
 * the run's messages.
 */

import type * as AI from 'ai';

import type { ClientRun, MessageNode } from '../../../index.js';

// TODO: will move to src/vercel/pendingToolCalls.ts per plan §4.
declare const pendingToolCalls: (
  messages: readonly MessageNode<AI.UIMessage>[],
) => { toolCallId: string; toolName: string; input: unknown; messageId: string }[];

/**
 * Approve a pending tool call by publishing the structured tool output and
 * re-invoking the agent.
 * @param run - The suspended client run holding the tool call.
 * @param toolCallId - The specific `toolCallId` the user approved.
 * @param output - The tool's output value to attach.
 * @returns Resolves once the approval has been published and the wake-up
 *   invocation POST has been dispatched.
 */
export const approveToolCall = async (
  run: ClientRun<AI.UIMessageChunk, AI.UIMessage>,
  toolCallId: string,
  output: unknown,
): Promise<void> => {
  if (run.status !== 'suspended') return;
  const pending = pendingToolCalls(run.messages).find((tc) => tc.toolCallId === toolCallId);
  if (!pending) return;

  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: `tool-${pending.toolName}`,
        toolCallId,
        state: 'output-available',
        input: pending.input,
        output,
      },
    ],
  });

  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};

/**
 * Deny a pending tool call by publishing a structured tool-error user
 * message and re-invoking the agent so it can react to the denial.
 * @param run - The suspended client run holding the tool call.
 * @param toolCallId - The specific `toolCallId` the user denied.
 * @param reason - Free-text reason surfaced as the tool error.
 * @returns Resolves once the denial has been published and the wake-up
 *   invocation POST has been dispatched.
 */
export const denyToolCall = async (
  run: ClientRun<AI.UIMessageChunk, AI.UIMessage>,
  toolCallId: string,
  reason: string,
): Promise<void> => {
  if (run.status !== 'suspended') return;
  const pending = pendingToolCalls(run.messages).find((tc) => tc.toolCallId === toolCallId);
  if (!pending) return;

  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: `tool-${pending.toolName}`,
        toolCallId,
        state: 'output-error',
        input: pending.input,
        errorText: reason,
      },
    ],
  });

  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};
