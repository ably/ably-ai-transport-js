/**
 * Abort and pause — client side (durable execution).
 *
 * Identical to the serverless variant. The client publishes the abort or
 * pause signal to the channel; the next workflow hop picks it up through
 * its AIT step. For pause, the run ends `suspended` and the client needs
 * to publish an `x-ably-resume` and invoke the workflow endpoint to wake
 * a new workflow run.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientSession, ClientView, InvocationData, MessageNode } from '../../../index.js';

/**
 * Global stop button. Aborts the single active run in the current view.
 * @param view - The client view being rendered.
 * @returns Resolves once the abort signal has been published.
 */
export const onStopClick = async (view: ClientView<AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (activeRun) await activeRun.abort();
};

/**
 * Per-message stop — the UI renders a stop button next to a specific
 * response and targets THAT node's run.
 * @param node - The node the user clicked the stop button on.
 * @returns Resolves once the abort signal has been published, if any.
 */
export const onStopNode = async (node: MessageNode<AI.UIMessage, ClientRun<AI.UIMessage>>): Promise<void> => {
  if (node.run?.status === 'active') await node.run.abort();
};

/**
 * Global pause. Durable signal — picked up by the next hop via its
 * AIT step whether or not a hop is currently executing.
 * @param view - The client view being rendered.
 * @returns Resolves once the pause signal has been published.
 */
export const onPauseClick = async (view: ClientView<AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (activeRun) await activeRun.pause();
};

/**
 * Resume a paused run by publishing `x-ably-resume` and invoking the
 * workflow endpoint to start a fresh workflow run.
 * @param session - The client session backing the UI.
 * @param runId - The ID of the paused run to resume.
 * @returns Resolves once the resume signal has been published and the workflow has been invoked.
 */
export const onResumeClick = async (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  runId: string,
): Promise<void> => {
  const run = session.tree.getRun(runId);
  if (run?.status !== 'suspended') return;
  await run.resume();
  const data: InvocationData = { sessionName: session.name, runId };
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });
};
