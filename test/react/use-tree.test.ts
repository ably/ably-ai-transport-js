// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useTree } from '../../src/react/use-tree.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useTree', () => {
  it('delegates getSiblings to tree', () => {
    const mock = createMockTransport([]);
    (mock.tree.getSiblings as ReturnType<typeof vi.fn>).mockReturnValue(['a', 'b']);

    const { result } = renderHook(() => useTree(mock.transport));

    expect(result.current.getSiblings('msg-1')).toEqual(['a', 'b']);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.getSiblings).toHaveBeenCalledWith('msg-1');
  });

  it('delegates hasSiblings to tree', () => {
    const mock = createMockTransport([]);
    (mock.tree.hasSiblings as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { result } = renderHook(() => useTree(mock.transport));

    expect(result.current.hasSiblings('msg-1')).toBe(true);
  });

  it('delegates getNode to tree', () => {
    const mock = createMockTransport([]);
    const fakeNode = { message: 'hi', msgId: 'msg-1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined };
    (mock.tree.getNode as ReturnType<typeof vi.fn>).mockReturnValue(fakeNode);

    const { result } = renderHook(() => useTree(mock.transport));

    expect(result.current.getNode('msg-1')).toBe(fakeNode);
  });
});
