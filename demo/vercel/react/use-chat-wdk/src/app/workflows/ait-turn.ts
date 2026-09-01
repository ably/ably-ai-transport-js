import { getWorkflowMetadata } from 'workflow';

import type { FaultMode } from '../lib/fault';
import {
  cleanupActivity,
  inferenceActivity,
  openActivity,
  terminalActivity,
  toolActivity,
  type RunRefs,
} from './activities';

/** Serializable input to the durable turn workflow — the invocation pointer the chat route received, plus demo controls. */
export interface AitTurnInput {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The `event-id` of the triggering input event, for the open activity's `locateInput`. */
  eventId: string;
  /** An optional fault to inject into the first inference's initial attempt (demo control). */
  fault?: FaultMode;
}

/**
 * A durable chat turn, as a Vercel Workflow driving its own agent loop.
 *
 * The workflow is the deterministic orchestrator: it holds the run refs and
 * does no channel I/O. {@link openActivity} locates the trigger and publishes
 * the run's opening event; {@link inferenceActivity} runs each model call (the
 * first and every follow-up) and returns a classified outcome without
 * publishing any lifecycle. While an outcome names fresh server-tool calls,
 * the workflow dispatches one {@link toolActivity} per call (each its own
 * retryable process, each tool result its own AIT step) and loops a follow-up
 * inference. The settled outcome then goes to {@link terminalActivity}, which
 * gates on the run's wire state and publishes `ai-run-end` — unless the
 * outcome is `settled`, which means another invocation (a client continuation)
 * already owns or finished the run and this workflow has nothing left to
 * publish.
 *
 * A cancel is delivered over the channel (the client's Stop publishes
 * `ai-cancel`, which fires the in-flight activity's run `abortSignal`), so
 * whichever activity is running returns a `cancelled` outcome and the terminal
 * activity ends the run — no separate cancel path is needed here.
 *
 * If an activity fails past its retry policy, the catch schedules the one-shot
 * {@link cleanupActivity} to publish `ai-run-end{error}` so observers' streams
 * close instead of hanging, then rethrows the original failure.
 * @param input - The serializable {@link AitTurnInput}.
 */
export async function runAitTurn(input: AitTurnInput): Promise<void> {
  'use workflow';
  // The workflow run id is stable across replays; it pins the AIT run id for a
  // fresh turn and threads to every activity so their sidecar telemetry
  // correlates to one workflow in the UI.
  const { workflowRunId } = getWorkflowMetadata();
  let refs: RunRefs | undefined;
  try {
    refs = await openActivity(input, workflowRunId);
    let outcome = await inferenceActivity(input, refs, workflowRunId, input.fault);

    while (outcome.kind === 'server-tools') {
      for (const toolCall of outcome.serverToolCalls) {
        await toolActivity(input, refs, workflowRunId, toolCall);
      }
      outcome = await inferenceActivity(input, refs, workflowRunId);
    }

    if (outcome.kind !== 'settled') {
      await terminalActivity(input, refs, workflowRunId, outcome);
    }
  } catch (error) {
    // Retries exhausted (or the open itself failed). If a run exists on the
    // wire, publish its error terminal so every observer's stream closes
    // cleanly; swallow the cleanup's own failure so the workflow still
    // surfaces the original error.
    if (refs) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await cleanupActivity(input, refs, workflowRunId, errorMessage);
      } catch {
        /* best-effort */
      }
    }
    throw error;
  }
}
