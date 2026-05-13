/**
 * useStagedAddToolApprovalResponse — pass-through wrapper around useChat's
 * `addToolApprovalResponse`.
 *
 * Previously this hook also staged the approval response onto the session's
 * tree via `stageMessage` to prevent a useChat↔tree race. With the codec
 * contract refactor (atomic-#1) `stageMessage` is retired — approvals are
 * intended to flow as typed `ToolApprovalEvent` TEvents on the active Run,
 * folded by the reducer.
 *
 * The full tool-approval-as-TEvent flow (publishing the approval event,
 * matching it against the active run, reconciling useChat's internal state)
 * is owned by the ChatTransport rework in Tier 4 #12. Until then this hook
 * remains a thin pass-through so consumers' import paths keep working — the
 * optimistic tree patch is gone.
 */

import type * as AI from 'ai';
import type { ChatAddToolApproveResponseFunction } from 'ai';
import { useCallback } from 'react';

import type { ClientSession } from '../../core/transport/types.js';
import type { VercelEvent, VercelProjection } from '../codec/index.js';

/**
 * Drop-in replacement for useChat's `addToolApprovalResponse` that delegates
 * directly. The previous optimistic tree-staging behavior was retired with
 * the codec contract refactor.
 * @param session - The client session (retained for API compatibility; unused).
 * @param addToolApprovalResponse - The raw function from `useChat()`.
 * @returns The same `addToolApprovalResponse`, memoized.
 */
export const useStagedAddToolApprovalResponse = (
  session: ClientSession<VercelEvent, VercelProjection, AI.UIMessage>,
  addToolApprovalResponse: ChatAddToolApproveResponseFunction,
): ChatAddToolApproveResponseFunction => {
  void session;
  return useCallback<ChatAddToolApproveResponseFunction>(
    (opts) => addToolApprovalResponse(opts),
    [addToolApprovalResponse],
  );
};
