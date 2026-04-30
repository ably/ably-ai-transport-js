/**
 * useStagedAddToolApprovalResponse — wrap useChat's `addToolApprovalResponse`
 * so the approval response is also applied to the transport tree
 * synchronously at click time.
 *
 * Patching the tree at click time eliminates the useChat↔tree divergence
 * the ChatTransport would otherwise have to reconcile via a history
 * overlay, and closes the observer-turn race that could wipe the
 * approval state between `addToolApprovalResponse` and
 * `sendAutomaticallyWhen`'s evaluation.
 *
 * Use this in place of useChat's raw `addToolApprovalResponse` wherever
 * you wire Approve / Deny buttons.
 */

import type * as AI from 'ai';
import type { ChatAddToolApproveResponseFunction } from 'ai';
import { useCallback } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/**
 * Returns a function with the same signature as useChat's
 * `addToolApprovalResponse`, but additionally applies the approval
 * response to the transport tree via `stageMessage` before delegating.
 *
 * If the tool call identified by `opts.id` isn't found in the tree,
 * the tree update is skipped and the raw function is still called —
 * matches useChat's tolerant behavior for stale approval ids.
 * @param transport - The client transport whose tree to patch.
 * @param addToolApprovalResponse - The raw function from `useChat()`.
 * @returns A drop-in replacement that patches the tree then delegates.
 */
export const useStagedAddToolApprovalResponse = (
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
  addToolApprovalResponse: ChatAddToolApproveResponseFunction,
): ChatAddToolApproveResponseFunction =>
  useCallback<ChatAddToolApproveResponseFunction>(
    (opts) => {
      stageApprovalResponseOnTree(transport, opts);
      return addToolApprovalResponse(opts);
    },
    [transport, addToolApprovalResponse],
  );

/**
 * Locate the assistant message whose `dynamic-tool` part carries the
 * given `approval.id`, build a patched copy with the part transitioned
 * to `approval-responded`, and stage the patched message on the tree.
 * @param transport - The transport whose tree to patch.
 * @param opts - The approval response being applied.
 * @param opts.id - The approval id matching a dynamic-tool part in the tree.
 * @param opts.approved - Whether the user approved or denied.
 * @param opts.reason - Optional reason accompanying the response.
 */
const stageApprovalResponseOnTree = (
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
  opts: { id: string; approved: boolean; reason?: string },
): void => {
  const nodes = transport.view.flattenNodes();
  for (const node of nodes) {
    const partIndex = node.message.parts.findIndex((p) => p.type === 'dynamic-tool' && p.approval?.id === opts.id);
    if (partIndex === -1) continue;

    // CAST: findIndex predicate above narrows this to a dynamic-tool part
    // with a non-undefined approval.
    const part = node.message.parts[partIndex] as AI.DynamicToolUIPart;

    // Build the approval-responded variant directly rather than spreading
    // `part`, which TypeScript narrows to whichever source-state variant
    // the union discriminator inferred and then rejects when we change
    // `state` to a variant with different approval/output constraints.
    const patchedPart: AI.DynamicToolUIPart = {
      type: 'dynamic-tool',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      state: 'approval-responded',
      input: part.input,
      approval: { id: opts.id, approved: opts.approved, reason: opts.reason },
    };

    const patchedParts = [...node.message.parts];
    patchedParts[partIndex] = patchedPart;
    transport.stageMessage(node.msgId, { ...node.message, parts: patchedParts });
    return;
  }
};
