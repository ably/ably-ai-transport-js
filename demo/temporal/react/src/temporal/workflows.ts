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
 * Mirrors the iteration loop in `demo/vercel/react`'s `/api/agent`
 * handler — one model call per AIT step, looping while the model keeps
 * calling tools.
 */

import { proxyActivities } from '@temporalio/workflow';

import type { InvocationData } from '@ably/ai-transport';

import type * as activities from './activities';

/**
 * Hard cap on iterations per run. Each iteration is one model call plus
 * any tool executions it triggers, published as one AIT step.
 */
const MAX_ITERATIONS = 10;

const { openRun, streamStep, endRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

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
 * sequence of AIT steps (and finally a `run-end`) published on the
 * session's Ably channel by the activities below.
 */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const { simulateFail = false, ...invocationData } = input;

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
      if (result.finishReason !== 'tool-calls') break;
    }
    await endRun({ runId: invocationData.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun({ runId: invocationData.runId, errorMessage: message });
    throw error;
  }
}
