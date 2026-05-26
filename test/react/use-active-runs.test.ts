// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useActiveRuns } from '../../src/react/use-active-runs.js';
import { createMockSession, makeRunEvent } from './helper/mock-session.js';

describe('useActiveRuns', () => {
  it('returns empty map when no session and no nearest context', () => {
    const { result } = renderHook(() => useActiveRuns());
    expect(result.current.size).toBe(0);
  });

  it('initializes from tree state', () => {
    const mock = createMockSession();
    const initialRuns = new Map([['client-1', new Set(['run-1'])]]);
    (mock.tree.getActiveRunIds as ReturnType<typeof vi.fn>).mockReturnValue(initialRuns);

    const { result } = renderHook(() => useActiveRuns({ session: mock.session }));
    expect(result.current.get('client-1')?.has('run-1')).toBe(true);
  });

  it('adds a run on run-start event', () => {
    const mock = createMockSession();
    const { result } = renderHook(() => useActiveRuns({ session: mock.session }));

    act(() => {
      mock.emitTree('run', makeRunEvent('ai-run-start', 'run-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.has('run-1')).toBe(true);
  });

  it('removes a run on run-end event', () => {
    const mock = createMockSession();
    (mock.tree.getActiveRunIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['run-1'])]]),
    );

    const { result } = renderHook(() => useActiveRuns({ session: mock.session }));

    act(() => {
      mock.emitTree('run', makeRunEvent('ai-run-end', 'run-1', 'client-1', 'complete'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });

  it('removes clientId entry when last run ends', () => {
    const mock = createMockSession();
    (mock.tree.getActiveRunIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['run-1', 'run-2'])]]),
    );

    const { result } = renderHook(() => useActiveRuns({ session: mock.session }));

    act(() => {
      mock.emitTree('run', makeRunEvent('ai-run-end', 'run-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.size).toBe(1);
    expect(result.current.get('client-1')?.has('run-2')).toBe(true);

    act(() => {
      mock.emitTree('run', makeRunEvent('ai-run-end', 'run-2', 'client-1'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });

  it('does not mutate previous state Set on run-end', () => {
    const mock = createMockSession();
    (mock.tree.getActiveRunIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['run-1', 'run-2'])]]),
    );

    const { result } = renderHook(() => useActiveRuns({ session: mock.session }));

    // Capture reference to the Set before mutation
    const setBefore = result.current.get('client-1');
    expect(setBefore).toBeDefined();
    expect(setBefore?.size).toBe(2);

    act(() => {
      mock.emitTree('run', makeRunEvent('ai-run-end', 'run-1', 'client-1'));
    });

    // The old Set reference must still contain both original items
    expect(setBefore?.has('run-1')).toBe(true);
    expect(setBefore?.has('run-2')).toBe(true);
    expect(setBefore?.size).toBe(2);
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession();
    const initialRuns = new Map([['client-1', new Set(['run-1'])]]);
    (mock.tree.getActiveRunIds as ReturnType<typeof vi.fn>).mockReturnValue(initialRuns);

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        ClientSessionContext.Provider,
        {
          value: {
            nearest: { session: mock.session },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useActiveRuns(), { wrapper });

    expect(result.current.get('client-1')?.has('run-1')).toBe(true);
  });
});
