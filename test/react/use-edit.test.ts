// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useEdit } from '../../src/react/use-edit.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useEdit', () => {
  it('returns a stable edit function', () => {
    const { view } = createMockTransport();
    const { result, rerender } = renderHook(() => useEdit(view));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('delegates to view.edit', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useEdit(mock.view));

    await act(async () => {
      await result.current('msg-1', ['replacement'], { body: { extra: true } });
    });

    expect(mock.edit).toHaveBeenCalledWith('msg-1', ['replacement'], { body: { extra: true } });
  });

  it('accepts a single message instead of an array', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useEdit(mock.view));

    await act(async () => {
      await result.current('msg-1', 'single-replacement');
    });

    expect(mock.edit).toHaveBeenCalledWith('msg-1', 'single-replacement', undefined);
  });
});
