/**
 * Retry after failure — client side.
 *
 * The client observes `step-ended` on the tree. When a step fails, it
 * publishes a retry control signal targeting that step and invokes the
 * agent — a fresh step with a new ID supersedes the failed attempt.
 */

import type * as AI from 'ai';

import type { ClientSession, InvocationData } from '../../../index.js';

/**
 * Deliver an invocation to the agent HTTP endpoint.
 * @param data - The {@link InvocationData} identifying run and target step.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Attach a retry-on-failure listener to a session's tree. The step-level
 * retry signal and IDs keep prior attempts identifiable on the channel,
 * so there's no phantom output.
 * @param session - The client session to observe.
 */
export const wireRetryOnFailure = (session: ClientSession<AI.UIMessageChunk, AI.UIMessage>): void => {
  session.tree.on('step-ended', (step, run) => {
    if (step.status !== 'failed') return;
    // Fire-and-forget: the tree event handler isn't awaiting us, but we
    // want the retry signal and invocation to go out as soon as we see
    // the failure.
    void (async (): Promise<void> => {
      await run.retry({ stepId: step.id });
      await invokeAgent({ sessionName: session.name, runId: run.id, stepId: step.id });
    })();
  });
};
