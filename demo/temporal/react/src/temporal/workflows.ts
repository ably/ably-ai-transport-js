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

import { condition, defineUpdate, executeChild, proxyActivities, setHandler } from '@temporalio/workflow';

import type { InvocationData } from '@ably/ai-transport';

import type * as activities from './activities';
import type { PendingSubagentCall, SubagentResultArg } from './activities';
import { workflowIdForRun } from '../lib/temporal-ids';

/**
 * Hard cap on iterations per run. Each iteration is one model call plus
 * any tool executions it triggers, published as one AIT step. Subagent
 * fan-outs cost two iterations apiece (one streamStep that emits the
 * spawn calls, one resumeWithToolResults that feeds the results back),
 * so the cap is set comfortably above the no-subagent baseline.
 */
const MAX_ITERATIONS = 20;

const { openRun, streamStep, endRun, suspendRun, resumeWithToolResults } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

// `seedSubagentRun` publishes a run-start + user message onto the channel
// and is therefore NOT idempotent across retries: a successful Ably
// publish followed by a worker crash before the activity result reaches
// Temporal would, on retry, create a second orphan run and a duplicate
// subagent-link sidecar. Disable retry so the workflow surfaces the
// failure to the user instead of silently fanning out duplicates.
const { seedSubagentRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
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
 * Workflow input — extends {@link InvocationData} with demo-specific
 * fields:
 *
 *   - `simulateFail`: when true the first iteration's `streamStep` errors
 *     mid-stream on its first activity attempt; Temporal then retries the
 *     activity and the second attempt succeeds, so the user sees a
 *     transient failed step followed by a successful run rather than a
 *     permanently-failed run.
 *   - `depth`: how deep this run sits in the subagent tree. The root
 *     (user-facing) run is `0`; a subagent spawned from it is `1`, etc.
 *     Threaded into every `streamStep` so the toolkit can hide
 *     `spawn_subagent` once the recursion cap is reached.
 */
export interface RunAgentInput extends InvocationData {
  simulateFail?: boolean;
  depth?: number;
}

/**
 * Drive a single agent run. Returns the agent's final assistant text —
 * unused for root runs (the UI reads the response off the channel), but
 * the value matters for child runs: a parent workflow that spawned this
 * via {@link executeChild} feeds it back as a `tool-output-available`
 * result so the parent's model can continue from where it left off.
 */
export async function runAgent(input: RunAgentInput): Promise<string> {
  const { simulateFail = false, depth = 0, ...invocationData } = input;

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

  let lastText = '';
  // Set by a fan-out iteration to hand the subagents' final-text results
  // to the next iteration so it runs `resumeWithToolResults` instead of
  // a fresh `streamStep`. Reset to undefined after consumption.
  let pendingSubagentResults: SubagentResultArg[] | undefined;
  // Every subagent result this run has seen, from every fan-out. Threaded
  // into every activity so they can hydrate the run's
  // `tool-spawn_subagent` parts locally — Ably's echo-back of our own
  // `tool-output-available` publishes is not guaranteed to land before
  // the next activity reads the run's view.
  const subagentResultsSoFar: SubagentResultArg[] = [];
  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const failHere = simulateFail && iteration === 0;
      let result;
      if (pendingSubagentResults === undefined) {
        result = await streamStep({
          runId: invocationData.runId,
          sessionName: invocationData.sessionName,
          depth,
          iteration,
          priorSubagentResults: subagentResultsSoFar,
          simulateFail: failHere,
        });
      } else {
        subagentResultsSoFar.push(...pendingSubagentResults);
        result = await resumeWithToolResults({
          runId: invocationData.runId,
          sessionName: invocationData.sessionName,
          depth,
          results: subagentResultsSoFar,
        });
        pendingSubagentResults = undefined;
      }
      // Activity already ended the run (abort path) — no trailing endRun.
      if (result.runEnded === true) return lastText;
      // Keep the most recent non-empty assistant text. A trailing
      // tool-only step (e.g. hit MAX_ITERATIONS mid-tool-loop) has no
      // meaningful text to return, so preserving the last spoken text
      // gives the parent more useful tool-result content.
      if (result.text.length > 0) {
        lastText = result.text;
      }

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

      // Subagent fan-out path: the model emitted one or more
      // `spawn_subagent` tool calls that the SDK did not auto-execute.
      // Seed each child run on the shared channel, start a Temporal
      // child workflow per call (in parallel), capture each child's
      // final text, and queue the results so the next iteration is a
      // `resumeWithToolResults` instead of a regular streamStep.
      if (result.subagentCalls !== undefined && result.subagentCalls.length > 0) {
        pendingSubagentResults = await spawnSubagents({
          calls: result.subagentCalls,
          parentRunId: invocationData.runId,
          sessionName: invocationData.sessionName,
          depth,
        });
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
  return lastText;
}

interface SpawnSubagentsArgs {
  calls: readonly PendingSubagentCall[];
  parentRunId: string;
  sessionName: string;
  /** The PARENT's depth. Children get `depth + 1`. */
  depth: number;
}

/**
 * Fan out one Temporal child workflow per `spawn_subagent` call. Each
 * child is keyed by its run id so the existing pause/resume route
 * handlers can address it identically to top-level runs. Children run
 * in parallel via `Promise.all`; each resolves with the child's final
 * assistant text, which we hand back to the parent loop as a
 * tool-result.
 */
async function spawnSubagents(args: SpawnSubagentsArgs): Promise<SubagentResultArg[]> {
  return Promise.all(
    args.calls.map(async (call) => {
      const invocation = await seedSubagentRun({
        sessionName: args.sessionName,
        parentRunId: args.parentRunId,
        parentToolCallId: call.toolCallId,
        description: call.input.description,
        prompt: call.input.prompt,
      });
      const output = await executeChild(runAgent, {
        workflowId: workflowIdForRun(invocation.runId),
        args: [{ ...invocation, depth: args.depth + 1 }],
      });
      return { toolCallId: call.toolCallId, output };
    }),
  );
}
