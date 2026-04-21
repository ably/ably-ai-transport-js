/**
 * Abort and pause — client side (durable execution).
 *
 * Identical to the serverless variant. The client publishes the abort or
 * pause signal to the channel; the next workflow hop picks it up through
 * its AIT step. For pause, the run ends `suspended` and the client POSTs
 * the returned resume invocation to wake a new workflow run.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientSession, ClientView, MessageNode } from '../../../index.js';

/**
 * Global stop button. Aborts the single active run in the current view.
 * @param view - The client view being rendered.
 * @returns Resolves once the abort signal has been published and the
 *   wake-up invocation POST has been dispatched.
 */
export const onStopClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  const invocation = await activeRun.abort();
  void fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Per-message stop — the UI renders a stop button next to a specific
 * response and targets THAT node's run.
 * @param node - The node the user clicked the stop button on.
 * @returns Resolves once the abort signal has been published, if any.
 */
export const onStopNode = async (
  node: MessageNode<AI.UIMessage, ClientRun<AI.UIMessageChunk, AI.UIMessage>>,
): Promise<void> => {
  if (node.run?.status !== 'active') return;
  const invocation = await node.run.abort();
  void fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Global pause. Durable signal — picked up by the next hop via its
 * AIT step whether or not a hop is currently executing.
 * @param view - The client view being rendered.
 * @returns Resolves once the pause signal has been published and the
 *   wake-up invocation POST has been dispatched.
 */
export const onPauseClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  const invocation = await activeRun.pause();
  void fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Resume a paused run by publishing `x-ably-resume` and invoking the
 * workflow endpoint to start a fresh workflow run.
 * @param session - The client session backing the UI.
 * @param runId - The ID of the paused run to resume.
 * @returns Resolves once the resume signal has been published and the
 *   workflow invocation POST has completed.
 */
export const onResumeClick = async (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  runId: string,
): Promise<void> => {
  const run = session.tree.getRun(runId);
  if (run?.status !== 'suspended') return;
  const invocation = await run.resume();
  await fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
