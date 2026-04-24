/**
 * Steering — client side (durable execution).
 *
 * Identical to the serverless variant. `run.sendMessages()` publishes the
 * new user message onto the running run; the next workflow hop picks it
 * up when it re-reads the session.
 */

import type * as AI from 'ai';

import type { Codec, ClientRun, ClientView, MessageNode } from '../../../index.js';

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
 * Per-message steering: target a specific response's run.
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
