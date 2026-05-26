// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../src/core/transport/types.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useTree } from '../../src/react/use-tree.js';
import { createMockSession } from './helper/mock-session.js';

describe('useTree', () => {
  it('delegates getSiblings to tree', () => {
    const mock = createMockSession([]);
    (mock.tree.getSiblings as ReturnType<typeof vi.fn>).mockReturnValue(['a', 'b']);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getSiblings('msg-1')).toEqual(['a', 'b']);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.getSiblings).toHaveBeenCalledWith('msg-1');
  });

  it('delegates hasSiblings to tree', () => {
    const mock = createMockSession([]);
    (mock.tree.hasSiblings as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.hasSiblings('msg-1')).toBe(true);
  });

  it('delegates getNode to tree', () => {
    const mock = createMockSession([]);
    const fakeNode = {
      message: 'hi',
      codecMessageId: 'msg-1',
      parentId: undefined,
      forkOf: undefined,
      headers: {},
      serial: undefined,
    };
    (mock.tree.getNode as ReturnType<typeof vi.fn>).mockReturnValue(fakeNode);

    const { result } = renderHook(() => useTree({ session: mock.session }));

    expect(result.current.getNode('msg-1')).toBe(fakeNode);
  });

  it('returns safe defaults when no session and no nearest context', () => {
    const { result } = renderHook(() => useTree());

    expect(result.current.getSiblings('msg-1')).toEqual([]);
    expect(result.current.hasSiblings('msg-1')).toBe(false);
    expect(result.current.getNode('msg-1')).toBeUndefined();
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession([]);
    (mock.tree.getSiblings as ReturnType<typeof vi.fn>).mockReturnValue(['a', 'b']);

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

    expect(result.current.getSiblings('msg-1')).toEqual(['a', 'b']);
  });
});
