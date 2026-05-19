/**
 * Module-scope cache of in-flight {@link AgentRun} handles, keyed by
 * `runId`. The Temporal workflow drives a run as a sequence of small
 * activities — `startRun` / `step` (× iterations) / `endRun` — and each
 * activity needs to operate on the same {@link AgentRun} handle that
 * `startRun` created. Workflow inputs are JSON-serialised, so the handle
 * itself can't travel through Temporal; the runId does, and the
 * worker-process cache resolves it back to the live handle.
 *
 * Lives in the worker process, not Next.js. Survives across activities
 * within one workflow as long as the same worker handles them.
 */
import type { AgentRun } from '@ably/ai-transport';
import type { UIMessageCodec } from '@ably/ai-transport/vercel';

type Run = AgentRun<typeof UIMessageCodec>;

const runs = new Map<string, Run>();

export const setRun = (runId: string, run: Run): void => {
  runs.set(runId, run);
};

export const getRun = (runId: string): Run | undefined => runs.get(runId);

export const deleteRun = (runId: string): void => {
  runs.delete(runId);
};
