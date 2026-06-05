// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RunNode } from '../../src/core/transport/types.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useTree } from '../../src/react/use-tree.js';
import { createMockSession } from './helper/mock-session.js';

const makeFakeRun = (runId: string): RunNode<unknown> => ({
  kind: 'run',
  runId,
  parentCodecMessageId: undefined,
  forkOf: undefined,
  regeneratesCodecMessageId: undefined,
  clientId: '',
  invocationId: '',
  status: 'complete',
  projection: undefined,
  startSerial: undefined,
  endSerial: undefined,
});

describe('useTree', () => {
  it('delegates getSiblingNodes to tree', () => {
    const mock = createMockSession([]);
    const siblings = [makeFakeRun('a'), makeFakeRun('b')];
    (mock.tree.getSiblingNodes as ReturnType<typeof vi.fn>).mockReturnValue(siblings);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getSiblingNodes('a')).toEqual(siblings);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.getSiblingNodes).toHaveBeenCalledWith('a');
  });

  it('delegates getRunNode to tree', () => {
    const mock = createMockSession([]);
    const fakeRun = makeFakeRun('run-1');
    (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue(fakeRun);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getRunNode('run-1')).toBe(fakeRun);
  });

  it('delegates getNodeByCodecMessageId to tree', () => {
    const mock = createMockSession([]);
    const fakeRun = makeFakeRun('run-1');
    (mock.tree.getNodeByCodecMessageId as ReturnType<typeof vi.fn>).mockReturnValue(fakeRun);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getNodeByCodecMessageId('msg-1')).toBe(fakeRun);
  });

  it('returns safe defaults when no session and no nearest context', () => {
    const { result } = renderHook(() => useTree());

    expect(result.current.getSiblingNodes('a')).toEqual([]);
    expect(result.current.getRunNode('a')).toBeUndefined();
    expect(result.current.getNodeByCodecMessageId('msg-1')).toBeUndefined();
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession([]);
    const siblings = [makeFakeRun('a'), makeFakeRun('b')];
    (mock.tree.getSiblingNodes as ReturnType<typeof vi.fn>).mockReturnValue(siblings);

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

    const { result } = renderHook(() => useTree(), { wrapper });

    expect(result.current.getSiblingNodes('a')).toEqual(siblings);
  });
});
