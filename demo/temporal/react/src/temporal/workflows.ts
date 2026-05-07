/**
 * Temporal workflow definitions. This module runs inside the workflow
 * sandbox, so it can only use deterministic APIs and may not import
 * Node-specific modules.
 *
 * Each call to {@link runAgent} orchestrates one user→assistant exchange:
 *
 *   1. {@link openRun} activity binds an AIT run on the agent session.
 *   2. The workflow loops up to {@link MAX_ITERATIONS} times. Each
 *      iteration calls {@link streamStep}, which runs one `streamText`
 *      and pipes the resulting `UIMessageChunk` stream through the AIT
 *      step. The activity reads the canonical conversation history from
 *      the run's view after each `step.start()` lands, so retried or
 *      aborted predecessors are excluded from the model context.
 *   3. {@link endRun} activity ends the run.
 *
 * Pause and resume are exposed to the route handler via Temporal Updates
 * (`pauseUpdate` / `resumeUpdate`). The client also publishes
 * `x-ably-pause` / `x-ably-resume` on the AIT channel for observability;
 * the Update is the in-process wake-up that's reliable for the
 * long-lived workflow. Between iterations the workflow checks both the
 * Update-driven flag and the activity-reported `pauseRequested` flag
 * (read from `run.pauseRequested` after the step ends, as a fallback
 * when only the channel publish fired). If either is set the workflow
 * calls a {@link suspendRun} activity which publishes
 * `x-ably-run-suspend (paused)` on the channel, then awaits a resume
 * Update before scheduling the next iteration.
 *
 * Mirrors the iteration loop in `demo/vercel/react`'s `/api/agent`
 * handler — one model call per AIT step, looping while the model keeps
 * calling tools.
 */

import { condition, defineUpdate, proxyActivities, setHandler } from '@temporalio/workflow';

import type { InvocationData } from '@ably/ai-transport';

import type * as activities from './activities';

/**
 * Hard cap on iterations per run. Each iteration is one model call plus
 * any tool executions it triggers, published as one AIT step.
 */
const MAX_ITERATIONS = 10;

const { openRun, streamStep, endRun, suspendRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

/**
 * Update sent to a running workflow when the user pauses the run. The
 * workflow flips its local `paused` flag; the next iteration boundary
 * suspends the run on the channel and awaits a {@link resumeUpdate}.
 *
 * Updates carry no arguments — the workflow ID is keyed by `runId`, so
 * the addressing is implicit.
 */
export const pauseUpdate = defineUpdate<void, []>('pause');

/**
 * Update sent to a paused workflow when the user resumes. Flips the
 * local `paused` flag back to `false`; the workflow's
 * `condition(() => !paused)` wakes and the next iteration starts a new
 * AIT step which re-activates the run.
 */
export const resumeUpdate = defineUpdate<void, []>('resume');

/**
 * Workflow input — extends {@link InvocationData} with the demo's
 * simulate-failure switch. When `simulateFail` is true the first
 * iteration's `streamStep` errors mid-stream on its first activity
 * attempt; Temporal then retries the activity and the second attempt
 * succeeds, so the user sees a transient failed step followed by a
 * successful run rather than a permanently-failed run.
 */
export interface RunAgentInput extends InvocationData {
  simulateFail?: boolean;
}

/**
 * Drive a single agent run. Returns nothing — the work product is the
 * sequence of AIT steps (and finally a `run-end` or `run-suspend`)
 * published on the session's Ably channel by the activities below.
 */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const { simulateFail = false, ...invocationData } = input;

  // Pause/resume state lives in the workflow function so it is fresh
  // per execution and recovers correctly on workflow replay — Temporal
  // re-applies Updates from the event history during replay, so the
  // closure variable ends up at the same value it had on the original
  // execution.
  let paused = false;
  setHandler(pauseUpdate, () => {
    paused = true;
  });
  setHandler(resumeUpdate, () => {
    paused = false;
  });

  await openRun(invocationData);

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const failHere = simulateFail && iteration === 0;
      const result = await streamStep({
        runId: invocationData.runId,
        sessionName: invocationData.sessionName,
        simulateFail: failHere,
      });
      // Activity already ended the run (abort path) — no trailing endRun.
      if (result.runEnded === true) return;

      // Suspend if either source signals pause: the Update-driven flag
      // (the in-process wake-up) or the activity's observation of the
      // run's pauseRequested flag (read off the channel as a fallback
      // when only the channel publish fired). Sync `paused` so the
      // condition wait below holds whichever way we got here.
      if (paused || result.pauseRequested === true) {
        paused = true;
        await suspendRun({ runId: invocationData.runId });
        await condition(() => !paused);
        // Resumed — fall through to the next iteration. The next
        // streamStep starts a fresh AIT step which re-activates the
        // run from `'suspended'` per AIT-CS5.
        continue;
      }

      if (result.finishReason !== 'tool-calls') break;
    }
    await endRun({ runId: invocationData.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun({ runId: invocationData.runId, errorMessage: message });
    throw error;
  }
}
