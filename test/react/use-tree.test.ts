// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession, RunNode } from '../../src/core/transport/types.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useTree } from '../../src/react/use-tree.js';
import { createMockSession } from './helper/mock-session.js';

const makeFakeRun = (runId: string): RunNode<unknown> => ({
  runId,
  parentRunId: undefined,
  forkOf: undefined,
  regeneratesMsgId: undefined,
  clientId: '',
  invocationId: '',
  status: 'complete',
  projection: undefined,
  startSerial: undefined,
  endSerial: undefined,
});

describe('useTree', () => {
  it('delegates getSiblingRuns to tree', () => {
    const mock = createMockSession([]);
    const siblings = [makeFakeRun('a'), makeFakeRun('b')];
    (mock.tree.getSiblingRuns as ReturnType<typeof vi.fn>).mockReturnValue(siblings);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getSiblingRuns('a')).toEqual(siblings);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.getSiblingRuns).toHaveBeenCalledWith('a');
  });

  it('delegates hasSiblingRuns to tree', () => {
    const mock = createMockSession([]);
    (mock.tree.hasSiblingRuns as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.hasSiblingRuns('a')).toBe(true);
  });

  it('delegates getRunNode to tree', () => {
    const mock = createMockSession([]);
    const fakeRun = makeFakeRun('run-1');
    (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue(fakeRun);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getRunNode('run-1')).toBe(fakeRun);
  });

  it('delegates getRunByMsgId to tree', () => {
    const mock = createMockSession([]);
    const fakeRun = makeFakeRun('run-1');
    (mock.tree.getRunByMsgId as ReturnType<typeof vi.fn>).mockReturnValue(fakeRun);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getRunByMsgId('msg-1')).toBe(fakeRun);
  });

  it('returns safe defaults when no session and no nearest context', () => {
    const { result } = renderHook(() => useTree());

    expect(result.current.getSiblingRuns('a')).toEqual([]);
    expect(result.current.hasSiblingRuns('a')).toBe(false);
    expect(result.current.getRunNode('a')).toBeUndefined();
    expect(result.current.getRunByMsgId('msg-1')).toBeUndefined();
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession([]);
    const siblings = [makeFakeRun('a'), makeFakeRun('b')];
    (mock.tree.getSiblingRuns as ReturnType<typeof vi.fn>).mockReturnValue(siblings);

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        ClientSessionContext.Provider,
        {
          value: {
            nearest: { session: mock.session as ClientSession<unknown, unknown, unknown> },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useTree(), { wrapper });

    expect(result.current.getSiblingRuns('a')).toEqual(siblings);
  });
});
