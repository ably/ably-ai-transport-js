// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { NearestTransportContext } from '../../src/react/contexts/transport-context.js';
import { useTree } from '../../src/react/use-tree.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useTree', () => {
  it('delegates getSiblings to tree', () => {
    const mock = createMockTransport([]);
    (mock.tree.getSiblings as ReturnType<typeof vi.fn>).mockReturnValue(['a', 'b']);

    const { result } = renderHook(() => useTree({ transport: mock.transport }));

    expect(result.current.getSiblings('msg-1')).toEqual(['a', 'b']);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.getSiblings).toHaveBeenCalledWith('msg-1');
  });

  it('delegates hasSiblings to tree', () => {
    const mock = createMockTransport([]);
    (mock.tree.hasSiblings as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { result } = renderHook(() => useTree({ transport: mock.transport }));

    expect(result.current.hasSiblings('msg-1')).toBe(true);
  });

  it('delegates getNode to tree', () => {
    const mock = createMockTransport([]);
    const fakeNode = {
      message: 'hi',
      msgId: 'msg-1',
      parentId: undefined,
      forkOf: undefined,
      headers: {},
      serial: undefined,
    };
    (mock.tree.getNode as ReturnType<typeof vi.fn>).mockReturnValue(fakeNode);

    const { result } = renderHook(() => useTree({ transport: mock.transport }));

    expect(result.current.getNode('msg-1')).toBe(fakeNode);
  });

  it('returns safe defaults when no transport and no nearest context', () => {
    const { result } = renderHook(() => useTree());

    expect(result.current.getSiblings('msg-1')).toEqual([]);
    expect(result.current.hasSiblings('msg-1')).toBe(false);
    expect(result.current.getNode('msg-1')).toBeUndefined();
  });

  it('uses nearest transport from context when transport is omitted', () => {
    const mock = createMockTransport([]);
    (mock.tree.getSiblings as ReturnType<typeof vi.fn>).mockReturnValue(['a', 'b']);

    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        NearestTransportContext.Provider,
        { value: mock.transport as ClientTransport<unknown, unknown> },
        children,
      );

    const { result } = renderHook(() => useTree(), { wrapper });

    expect(result.current.getSiblings('msg-1')).toEqual(['a', 'b']);
  });
});
