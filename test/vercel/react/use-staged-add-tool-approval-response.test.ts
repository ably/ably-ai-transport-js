// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession, MessageNode } from '../../../src/core/transport/types.js';
import { useStagedAddToolApprovalResponse } from '../../../src/vercel/react/use-staged-add-tool-approval-response.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAssistantWithApprovalRequest = (uiMsgId: string, toolCallId: string, approvalId: string): AI.UIMessage => ({
  id: uiMsgId,
  role: 'assistant',
  parts: [
    {
      type: 'dynamic-tool',
      toolCallId,
      toolName: 'getWeatherForecast',
      state: 'approval-requested',
      input: { location: 'London' },
      approval: { id: approvalId },
    },
  ],
});

const makeNode = (msgId: string, message: AI.UIMessage): MessageNode<AI.UIMessage> => ({
  kind: 'message',
  msgId,
  parentId: undefined,
  forkOf: undefined,
  message,
  headers: {},
  serial: '',
});

const createMockSession = (
  nodes: MessageNode<AI.UIMessage>[],
): ClientSession<AI.UIMessageChunk, AI.UIMessage> & { stageMessage: ReturnType<typeof vi.fn> } => {
  const stageMessage = vi.fn();
  // CAST: only the subset used by useStagedAddToolApprovalResponse is needed.
  return {
    view: { flattenNodes: () => nodes },
    stageMessage,
  } as unknown as ClientSession<AI.UIMessageChunk, AI.UIMessage> & { stageMessage: ReturnType<typeof vi.fn> };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStagedAddToolApprovalResponse', () => {
  it('patches the matching tool part on the tree, then delegates to the raw function', () => {
    const uiMsgId = 'ui-1';
    const msgId = 'tree-1';
    const toolCallId = 'tc-1';
    const approvalId = 'ap-1';

    const message = makeAssistantWithApprovalRequest(uiMsgId, toolCallId, approvalId);
    const nodes = [makeNode(msgId, message)];
    const session = createMockSession(nodes);
    const raw = vi.fn();

    const { result } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    result.current({ id: approvalId, approved: true });

    expect(session.stageMessage).toHaveBeenCalledTimes(1);
    const [stagedMsgId, stagedMessage] = session.stageMessage.mock.calls[0] as [string, AI.UIMessage];
    expect(stagedMsgId).toBe(msgId);
    expect(stagedMessage.parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolCallId,
      state: 'approval-responded',
      approval: { id: approvalId, approved: true },
    });

    expect(raw).toHaveBeenCalledExactlyOnceWith({ id: approvalId, approved: true });
  });

  it('propagates approved: false and reason into the patched approval', () => {
    const nodes = [makeNode('tree-1', makeAssistantWithApprovalRequest('ui-1', 'tc-1', 'ap-1'))];
    const session = createMockSession(nodes);
    const raw = vi.fn();

    const { result } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    result.current({ id: 'ap-1', approved: false, reason: 'User denied' });

    const [, stagedMessage] = session.stageMessage.mock.calls[0] as [string, AI.UIMessage];
    expect(stagedMessage.parts[0]).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'ap-1', approved: false, reason: 'User denied' },
    });
    expect(raw).toHaveBeenCalledExactlyOnceWith({ id: 'ap-1', approved: false, reason: 'User denied' });
  });

  it('tolerates missing approval id — delegates without staging', () => {
    const session = createMockSession([]);
    const raw = vi.fn();

    const { result } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    result.current({ id: 'unknown', approved: true });

    expect(session.stageMessage).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledExactlyOnceWith({ id: 'unknown', approved: true });
  });

  it('returns the same wrapped function across re-renders when deps are stable', () => {
    const session = createMockSession([]);
    const raw = vi.fn();

    const { result, rerender } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
