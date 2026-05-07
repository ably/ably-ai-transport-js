/**
 * Deterministic workflow ID for a given AIT run. Keyed by runId only so
 * the pause/resume route handlers can find the in-flight workflow
 * without tracking a separate runId → workflowId mapping. Combined with
 * `WorkflowIdReusePolicy.ALLOW_DUPLICATE` on `client.workflow.start`,
 * which lets a retry start a fresh workflow once the previous one for
 * the same run has finished.
 * @param runId The AIT run id.
 * @returns The Temporal workflow id used to address this run.
 */
export const workflowIdForRun = (runId: string): string => `run-agent-${runId}`;
