import { getWorkflowMetadata } from 'workflow';
import type { InvocationData, RunIdentity } from '@ably/ai-transport';

import type { FaultMode } from '../lib/fault';
import { cleanupActivity, inferenceActivity, openActivity, toolActivity } from './activities';

/** Serializable input to the durable turn workflow. */
export interface AitTurnInput {
  /** The invocation pointer the client POSTed — the durable hand-off token. */
  invocation: InvocationData;
  /** An optional fault to inject into the first inference's initial attempt (demo control). */
  fault?: FaultMode;
}

/**
 * A durable chat turn, as a Vercel Workflow driving its own agent loop.
 *
 * The workflow is the deterministic orchestrator: it holds the run identity
 * and does no channel I/O. {@link openActivity} opens the run;
 * {@link inferenceActivity} runs each model call (the first and every
 * follow-up). While an inference classifies fresh server-tool calls, the
 * workflow dispatches one {@link toolActivity} per call (each its own
 * retryable process, each tool result its own AIT step) and loops a follow-up
 * {@link inferenceActivity}. Every terminal outcome (`complete` / `suspend` /
 * `cancelled` / `error`) has already been published on the wire by the
 * activity that produced it, in its own session — the workflow only decides
 * whether to schedule more activities.
 *
 * A cancel is delivered over the channel (the client's `run.cancel()` publishes
 * `ai-cancel`, which fires the running activity's abort signal), so whichever
 * activity is in flight returns a `cancelled` outcome and publishes the
 * terminal inline — no separate cancel path is needed here.
 *
 * If an activity fails past its retry policy, the catch schedules the one-shot
 * {@link cleanupActivity} to publish `ai-run-end{error}` so observers'
 * streams close instead of hanging, then rethrows the original failure.
 * @param input - The serializable {@link AitTurnInput}.
 */
export async function runAitTurn(input: AitTurnInput): Promise<void> {
  'use workflow';
  // The workflow run id is stable across replays; thread it to every activity
  // so their sidecar telemetry correlates to one workflow in the UI.
  const { workflowRunId } = getWorkflowMetadata();
  let ids: RunIdentity | undefined;
  try {
    ids = await openActivity(input.invocation, workflowRunId);
    let outcome = await inferenceActivity(input.invocation, ids, workflowRunId, input.fault);

    while (outcome.kind === 'server-tools') {
      for (const toolCall of outcome.serverToolCalls) {
        await toolActivity(input.invocation, ids, workflowRunId, toolCall);
      }
      outcome = await inferenceActivity(input.invocation, ids, workflowRunId);
    }
  } catch (error) {
    // Retries exhausted (or the open itself failed). If a run exists on the
    // wire, publish its error terminal so every observer's stream closes
    // cleanly; swallow the cleanup's own failure so the workflow still
    // surfaces the original error.
    if (ids) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await cleanupActivity(input.invocation, ids, workflowRunId, errorMessage);
      } catch {
        /* best-effort */
      }
    }
    throw error;
  }
}
