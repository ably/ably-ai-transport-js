/**
 * Abort and pause — client side.
 *
 * Abort and pause are durable state on the session: the client publishes
 * the signal, and the agent reacts to it whether or not it was live when
 * the signal hit the channel. Shows both the single-conversation "stop"
 * button and a per-message variant that targets a specific run.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientView, MessageNode } from '../../../index.js';

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
 * Global pause. Follows the same durable-state pattern as abort — the
 * signal lands on the channel regardless of whether an agent is live.
 * @param view - The client view being rendered.
 * @returns Resolves once the pause signal has been published.
 */
export const onPauseClick = async (view: ClientView<AI.UIMessage>): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (activeRun) await activeRun.pause();
};
