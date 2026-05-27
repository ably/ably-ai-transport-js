/**
 * Steering — client side.
 *
 * A user types a follow-up while the previous response is still streaming.
 * `run.sendMessages()` publishes the new user message onto the same run —
 * the in-progress work is not cancelled, and the next iteration of the
 * agent loop picks the new input up from the updated view.
 */

import type * as AI from 'ai';

import type { ClientRun, ClientView, Codec, MessageNode } from '../../../index.js';

/**
 * Send a follow-up on the view's single active run.
 * @param view - The client view being rendered.
 * @param text - The text the user typed into the follow-up composer.
 * @returns Resolves once the steering message has been published.
 */
export const onSteerClick = async (
  view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  text: string,
): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  await activeRun.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
};

/**
 * Per-message steering: the UI exposes a "reply here" affordance on a
 * specific assistant response and targets THAT node's run.
 * @param node - The assistant node the user is replying to.
 * @param text - The text the user typed into the inline reply composer.
 * @returns Resolves once the steering message has been published.
 */
export const onSteerAtNode = async (
  node: MessageNode<AI.UIMessage, ClientRun<Codec<AI.UIMessageChunk, AI.UIMessage>>>,
  text: string,
): Promise<void> => {
  if (node.run?.status !== 'active') return;
  await node.run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
};
