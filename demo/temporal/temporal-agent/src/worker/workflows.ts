/**
 * The chat workflow. One workflow instance per HTTP POST (workflowId ==
 * invocationId).
 *
 * `withRun` owns the run's bookends. It opens the run — creating it, or resuming
 * an existing one when the turn is a continuation — and on a failure makes a
 * best-effort attempt to end it `error`, so a failed turn doesn't leave the
 * browser waiting on a stream that never ends. That attempt survives a cancel or
 * terminate of this workflow, which is when it matters most.
 *
 * What is left here is this app's own algorithm: run an inference, and while it
 * comes back asking for server tools, run those tools and infer again.
 *
 * Activities publish their own terminals. The inference activity already holds a
 * loaded run, so publishing `ai-run-end` / `ai-run-suspend` there costs nothing;
 * doing it from here via `run.end()` would pay a fresh adopt and load. The
 * handle exposes `end()` and `suspend()` for orchestrations that prefer it.
 *
 * Cancels need no signal or listener activity. When the client publishes
 * `ai-cancel` on the channel, whichever activity is attached picks it up through
 * the SDK's cancel routing, aborts, publishes `ai-run-end{cancelled}` inline, and
 * returns `{ kind: 'cancelled' }`.
 */

import { proxyActivities } from '@temporalio/workflow';

import { withRun } from '@ably/ai-transport/temporal/workflow';

import type { ChatWorkflowInput } from './shared.js';
import type * as activities from './activities.js';

// Bounded retries so a failure reaches `withRun`'s cleanup instead of hanging
// forever. runToolStep gets more attempts because the demo's `getStockPrice`
// throws on an odd price (~50% of attempts), so it may need several before it
// rolls an even one.
const { runInferenceStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

const { runToolStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

export async function chatWorkflow(input: ChatWorkflowInput): Promise<void> {
  // withRun opens the run — creating it, or RESUMING an existing one when this
  // turn is a continuation — runs the body, and on a throw makes a best-effort
  // attempt to end the run 'error' so a waiting client unsticks. Best-effort is
  // literal: that attempt is non-cancellable, gets one shot with a short timeout,
  // and no-ops when the run is already terminal or parked suspended.
  //
  // It does NOT adopt the run for the activities below. A session cannot cross an
  // activity boundary, so each activity re-adopts and re-loads from `run.ids` —
  // which is why ids are what gets threaded through the loop, not a session.
  await withRun(
    input.invocation,
    {
      invocationId: input.invocationId,
      activityOptions: {
        // Cleanup keeps the SDK's fail-fast default; opening a run is worth a
        // couple of retries, since a continuation can race the resume it needs.
        openRun: { startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } },
      },
    },
    async (run) => {
      // The main loop: run inference, and while it comes back asking for server tools,
      // process each tool call and infer again. The inference activity publishes the 'end' when done.
      let outcome = await runInferenceStep({ ids: run.ids, invocation: input.invocation });

      while (outcome.kind === 'server-tools') {
        // The only non-terminal outcome: run one activity per tool call, then
        // infer again. The follow-up inference publishes the terminal when done.
        for (const toolCall of outcome.serverToolCalls) {
          await runToolStep({ ids: run.ids, invocation: input.invocation, toolCall });
        }
        outcome = await runInferenceStep({ ids: run.ids, invocation: input.invocation });
      }

      // Every other outcome is terminal, and the activity that produced it has
      // already published `ai-run-end` / `ai-run-suspend` on the wire.
    },
  );
}
