/**
 * Abort and pause — client side.
 *
 * Abort and pause are durable state on the session: the client publishes
 * the signal, and the agent reacts to it whether or not it was live when
 * the signal hit the channel. Shows both the single-conversation "stop"
 * button and a per-message variant that targets a specific run.
 *
 * Per plan §5.3, control signals return an {@link Invocation} the caller
 * POSTs to the agent endpoint when no agent is currently running. The
 * caller decides fire-and-forget vs `await` based on whether they need to
 * guarantee the lifecycle state lands.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientView, MessageNode } from '../../../index.js';

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
  void fetch('/api/agent', {
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
export const onStopNode = async (node: MessageNode<AI.UIMessage, ClientRun<AI.UIMessage>>): Promise<void> => {
  if (node.run?.status !== 'active') return;
  const invocation = await node.run.abort();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Global pause. Follows the same durable-state pattern as abort — the
 * signal lands on the channel regardless of whether an agent is live.
 * @param view - The client view being rendered.
 * @returns Resolves once the pause signal has been published and the
 *   wake-up invocation POST has been dispatched.
 */
export const onPauseClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  const invocation = await activeRun.pause();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

/**
 * Resume a suspended run. Awaits the POST so the caller learns the agent
 * endpoint accepted the wake-up — useful when the UI wants to enable
 * progress indicators only once the server has accepted the resume.
 * @param view - The client view being rendered.
 * @returns Resolves once the resume signal has been published and the
 *   wake-up POST has completed.
 */
export const onResumeClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const suspendedRun = view.runs.find((r) => r.status === 'suspended');
  if (!suspendedRun) return;
  const invocation = await suspendedRun.resume();
  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
