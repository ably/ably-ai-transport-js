/**
 * Retry after failure — client side.
 *
 * The client observes `step-ended` on the tree. When a step fails, it
 * publishes a retry control signal targeting that step and POSTs the
 * returned invocation — a fresh step with a new ID supersedes the failed
 * attempt.
 */

import type * as AI from 'ai';

import type { ClientSession, Codec } from '../../../index.js';

/**
 * Attach a retry-on-failure listener to a session's tree. The step-level
 * retry signal and IDs keep prior attempts identifiable on the channel,
 * so there's no phantom output.
 * @param session - The client session to observe.
 */
export const wireRetryOnFailure = (session: ClientSession<Codec<AI.UIMessageChunk, AI.UIMessage>>): void => {
  session.tree.on('step-ended', (step, run) => {
    if (step.status !== 'failed') return;
    // Fire-and-forget: the tree event handler isn't awaiting us, but we
    // want the retry signal and invocation to go out as soon as we see
    // the failure.
    void (async (): Promise<void> => {
      const invocation = await run.retry({ stepId: step.id });
      await fetch('/api/agent', {
        method: 'POST',
        body: JSON.stringify(invocation.toJSON()),
      });
    })();
  });
};
