/**
 * Subagent fan-out — client side.
 *
 * The client is unchanged from basic chat: it invokes the parent
 * orchestrator, which spawns children as additional runs on the same
 * session. The UI sees the parent's streamed reasoning and every child
 * run's output side by side without special handling — they are all just
 * runs on this session.
 */

import type * as AI from 'ai';

import type { Codec, ClientView, InvocationData } from '../../../index.js';

/**
 * Deliver an invocation to the parent agent HTTP endpoint.
 * @param data - The {@link InvocationData} produced by `run.toInvocation().toJSON()`.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeParent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/parent-agent', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Handler for the send button. Opens a run, publishes the user's message,
 * then invokes the parent orchestrator. Fan-out into subagents is an
 * internal concern of the orchestrator's agent loop.
 * @param view - The client view new runs should be positioned on.
 * @param text - The text the user typed into the composer.
 * @returns Resolves once the invocation has been dispatched.
 */
export const onSendClick = async (
  view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  text: string,
): Promise<void> => {
  const run = view.createRun();
  await run.start();
  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeParent(run.toInvocation().toJSON());
};
