/**
 * The chat workflow. One workflow instance per HTTP POST (workflowId ==
 * invocationId). The workflow opens the run in one activity (`openRun` —
 * createRun + start, no inference), runs the first inference as its own
 * `runInferenceStep`, then loops server-tool + follow-up-inference activities
 * until a terminal outcome comes back. Splitting open from the first inference
 * keeps the two independently retryable: an inference failure retries the
 * inference alone, never re-opening the run.
 *
 * Activities are fully self-contained on the happy path: each publishes its
 * own terminal (`ai-run-end` / `ai-run-suspend`) inline in the session it
 * used for its step output. Two layers of failure handling wrap the workflow:
 *
 *   - Per-activity `session.end()` safety net (in each activity's catch)
 *     closes any still-open run as `cancelled` before the throw propagates.
 *   - Workflow-level catch below, which schedules a one-shot `cleanupRun`
 *     if activity retries are exhausted (Temporal has given up).
 *     `cleanupRun` publishes `run.end('error')` so the client's UI
 *     unstucks; it has a tight timeout and no retry so it can't cascade.
 *
 * Cancels: no listener activity or workflow signal. When the client
 * publishes `ai-cancel` on the channel, whichever activity is running (or
 * the next one to open its own session) picks it up via the SDK's built-in
 * cancel routing, aborts, publishes `run.end('cancelled')` inline, and
 * returns `{ kind: 'cancelled' }`.
 */

import { proxyActivities } from '@temporalio/workflow';

import type { ChatWorkflowInput, RunIds } from './shared.js';
import type * as activities from './activities.js';

// Step activities: bounded retries so failures propagate to the workflow's
// catch instead of hanging forever. runToolStep gets more attempts because
// the demo's `getStockPrice` intentionally throws on its first attempt.
const { openRun, runInferenceStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

const { runToolStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

// Cleanup is best-effort and short: one attempt, tight timeout — if it fails
// we've done what we can, don't cascade the failure further.
const { cleanupRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export async function chatWorkflow(input: ChatWorkflowInput): Promise<void> {
  let ids: RunIds | undefined;
  try {
    // openRun creates + starts the run (publishes ai-run-start / ai-run-resume)
    // without running inference, and returns the run's ids. The run id is now
    // part of the durable execution state, so it can be resumed on failure or restart.
    ids = await openRun({
      invocation: input.invocation,
      invocationId: input.invocationId,
    });

    // First inference. Every inference — first and follow-ups — goes through the
    // same adopt-load-infer activity, so the loop below handles them uniformly.
    let outcome = await runInferenceStep({ ids, invocation: input.invocation });

    while (true) {
      // Any terminal outcome — the activity that produced it already
      // published ai-run-end / ai-run-suspend on the wire in its own session.
      if (
        outcome.kind === 'complete' ||
        outcome.kind === 'suspend' ||
        outcome.kind === 'error' ||
        outcome.kind === 'cancelled'
      ) {
        return;
      }

      // server-tools: one activity per tool call, then a follow-up inference
      // (which will publish the terminal when it's done).
      for (const toolCall of outcome.serverToolCalls) {
        await runToolStep({ ids, invocation: input.invocation, toolCall });
      }

      outcome = await runInferenceStep({ ids, invocation: input.invocation });
    }
  } catch (err) {
    // Activity retries exhausted. Schedule cleanup only if openRun returned ids
    // — a failure before that means no run to clean up. Because openRun no
    // longer runs inference, an inference failure past retries still leaves ids
    // set, so cleanupRun reliably ends the run 'error' and unsticks the client
    // instead of orphaning an active run. Swallow the cleanup's own error so the
    // workflow still surfaces the original failure to Temporal.
    if (ids) {
      try {
        await cleanupRun({
          ids,
          channelName: input.invocation.sessionName,
          errorMessage: err instanceof Error ? err.message : 'workflow failed',
        });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}
