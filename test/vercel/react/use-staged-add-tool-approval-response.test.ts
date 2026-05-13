// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../../src/core/transport/types.js';
import type { VercelEvent, VercelProjection } from '../../../src/vercel/codec/index.js';
import { useStagedAddToolApprovalResponse } from '../../../src/vercel/react/use-staged-add-tool-approval-response.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockSession = (): ClientSession<VercelEvent, VercelProjection, AI.UIMessage> =>
  // CAST: only identity is used by the pass-through wrapper.
  ({}) as unknown as ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStagedAddToolApprovalResponse', () => {
  it('delegates the call to the raw addToolApprovalResponse function (pass-through)', () => {
    const session = createMockSession();
    const raw = vi.fn();

    const { result } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    result.current({ id: 'ap-1', approved: true });

    expect(raw).toHaveBeenCalledExactlyOnceWith({ id: 'ap-1', approved: true });
  });

  it('forwards denial responses unchanged', () => {
    const session = createMockSession();
    const raw = vi.fn();

    const { result } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    result.current({ id: 'ap-1', approved: false, reason: 'User denied' });

    expect(raw).toHaveBeenCalledExactlyOnceWith({ id: 'ap-1', approved: false, reason: 'User denied' });
  });

  it('returns the same wrapped function across re-renders when deps are stable', () => {
    const session = createMockSession();
    const raw = vi.fn();

    const { result, rerender } = renderHook(() => useStagedAddToolApprovalResponse(session, raw));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
