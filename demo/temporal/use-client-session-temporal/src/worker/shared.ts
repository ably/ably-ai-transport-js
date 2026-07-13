/**
 * Types shared between the API route, the workflow, and the activities.
 *
 * The workflow imports from this file must remain plain data — no runtime
 * side effects — because Temporal loads workflow bundles in an isolated
 * sandbox (no Ably, no `ai` SDK, no `crypto` at import time).
 */

import type { InvocationData } from '@ably/ai-transport';

/** Identity of an already-open run — the shape the SDK's `adoptRun` accepts. */
export interface RunIds {
  /**
   * The run's authoritative id. Pinned to the Temporal workflowId (== the
   * invocationId) at `openRun`, so a fresh-process retry re-enters the same run
   * rather than opening a parallel one. Continuations keep the id from the
   * trigger's wire headers instead.
   */
  runId: string;
  /** The run's owner invocation id. Every activity stamps its own activity id on outputs. */
  invocationId: string;
  /** The event id of the run's triggering input. */
  triggerEventId: string;
}

/** Args passed into the workflow at start. */
export interface ChatWorkflowInput {
  /** The invocation pointer the client POSTed. */
  invocation: InvocationData;
  /** The workflow-supplied invocation id (equals the workflow id). */
  invocationId: string;
}

/** One tool call the inference step surfaced. */
export interface ToolCallInfo {
  /** The tool call's id — stable per call, opaque to us. */
  toolCallId: string;
  /** The tool's name (matches a key in the `tools` registry). */
  toolName: string;
  /** The tool's parsed input, as the model provided. */
  input: unknown;
}

/**
 * Outcome the inference activity returns for the workflow to route on.
 *
 * The terminal `kind` values align with the SDK's `RunEndReason` / `Run.suspend`
 * vocabulary so `_publishTerminal` can pass `kind` straight through:
 * `complete` / `cancelled` / `error` map to `run.end({ reason: kind })` and
 * `suspend` maps to `run.suspend()`. `server-tools` is the only non-terminal
 * kind — the workflow loops on it, running its tool steps then a follow-up
 * inference. (Client steering is answered inside the inference activity's own
 * loop, so it is never surfaced to the workflow.)
 *
 * All terminal outcomes have already been published on the wire by the
 * activity's own session before it returned. The workflow just decides
 * whether to schedule more activities ('server-tools') or return.
 */
export type InferenceOutcome =
  | { kind: 'complete' }
  | { kind: 'server-tools'; serverToolCalls: ToolCallInfo[] }
  | { kind: 'suspend' }
  | { kind: 'cancelled' }
  | { kind: 'error'; errorMessage: string };

/** Task-queue name shared between worker and client. */
export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ai-transport-demo';
