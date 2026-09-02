/**
 * Types shared between the API route, the workflow, and the activities.
 *
 * The workflow imports from this file must remain plain data — no runtime
 * side effects — because Temporal loads workflow bundles in an isolated
 * sandbox (no Ably, no `ai` SDK, no `crypto` at import time).
 */

import type { InvocationData } from '@ably/ai-transport';

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
 * The terminal `kind` values align with the SDK's `RunEndReason` vocabulary so
 * the activity's terminal publisher can pass `kind` straight through:
 * `complete` / `cancelled` / `error` map to `run.end({ reason: kind })`.
 * `awaiting-client` ends the run complete — the useChat adapter publishes each
 * tool resolution as a plain input carrying no run id, so the continuation
 * opens a fresh run and a suspended one would never be resumed.
 * `server-tools` is the only non-terminal kind — the workflow loops on it,
 * running its tool steps then a follow-up inference.
 *
 * All terminal outcomes have already been published on the wire by the
 * activity's own transport before it returned. The workflow just decides
 * whether to schedule more activities ('server-tools') or return.
 */
export type InferenceOutcome =
  | { kind: 'complete' }
  | { kind: 'server-tools'; serverToolCalls: ToolCallInfo[] }
  | { kind: 'awaiting-client' }
  | { kind: 'cancelled' }
  | { kind: 'error'; errorMessage: string };

/** Task-queue name shared between worker and client. */
export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ai-transport-demo';
