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

  it('delegates getSelectedIndex to tree', () => {
    const mock = createMockTransport([]);
    (mock.tree.getSelectedIndex as ReturnType<typeof vi.fn>).mockReturnValue(2);

    const { result } = renderHook(() => useTree(mock.transport));

    expect(result.current.getSelectedIndex('msg-1')).toBe(2);
  });

  it('delegates select to tree.select', () => {
    const mock = createMockTransport([]);

    const { result } = renderHook(() => useTree(mock.transport));

    result.current.select('msg-1', 1);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.tree.select).toHaveBeenCalledWith('msg-1', 1);
  });
});
