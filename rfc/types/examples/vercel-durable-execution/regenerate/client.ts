/**
 * Regenerate — client side (durable execution).
 *
 * Identical to the serverless variant. `view.createRegenerate(messageId)`
 * forks the tree and auto-selects the new branch; the returned run's
 * invocation points the workflow at the new branch.
 */

import type * as AI from 'ai';

import type { Codec, ClientSession, ClientView, InvocationData } from '../../../index.js';

/**
 * Deliver an invocation to the workflow HTTP trigger.
 * @param data - The {@link InvocationData} produced by `run.toInvocation().toJSON()`.
 * @returns Resolves once the POST has been dispatched.
 */
const invokeWorkflow = async (data: InvocationData): Promise<void> => {
  await fetch('/api/workflow/start', { method: 'POST', body: JSON.stringify(data) });
};

/**
 * Regenerate an assistant response. Forks the tree at the response the
 * user wants redone and invokes the workflow on the new branch. The view
 * auto-selects the new branch.
 * @param view - The client view positioned on the conversation being regenerated.
 * @param assistantMessageId - The ID of the assistant message to regenerate.
 * @returns Resolves once the invocation has been dispatched.
 */
export const onRegenerateClick = async (
  view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  assistantMessageId: string,
): Promise<void> => {
  const run = view.createRegenerate(assistantMessageId);
  await run.start();
  await invokeWorkflow(run.toInvocation().toJSON());
};

/**
 * Switch the view to a specific sibling at a branch point.
 * @param view - The view whose projection should change.
 * @param messageId - The sibling to surface — must identify an existing node.
 */
export const onSelectBranchClick = (
  view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  messageId: string,
): void => {
  view.select(messageId);
};

/**
 * Wire the UI's re-render loop to view updates. The UI reads view.messages
 * and, for each node, checks `parentId` + `session.tree.getMessage(parentId)`
 * child count to decide whether to render branch-switcher controls.
 * @param session - The client session backing the UI.
 * @param view - The view being rendered.
 * @returns Unsubscribe function to detach the re-render on unmount.
 */
export const wireBranchSwitcher = (
  session: ClientSession<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  view: ClientView<Codec<AI.UIMessageChunk, AI.UIMessage>>,
): (() => void) =>
  view.subscribe(() => {
    for (const node of view.messages) {
      if (!node.parentId) continue;
      const parent = session.tree.getMessage(node.parentId);
      if (parent && parent.children.length > 1) {
        // UI renders a branch-switcher for this node using parent.children.
      }
    }
  });
