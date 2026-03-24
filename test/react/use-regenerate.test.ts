// @vitest-environment jsdom

import { act,renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useRegenerate } from '../../src/react/use-regenerate.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useRegenerate', () => {
  it('returns a stable regenerate function', () => {
    const { transport } = createMockTransport();
    const { result, rerender } = renderHook(() => useRegenerate(transport));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('delegates to transport.regenerate', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useRegenerate(mock.transport));

    await act(async () => {
      await result.current('msg-1', { body: { extra: true } });
    });

    expect(mock.regenerate).toHaveBeenCalledWith('msg-1', { body: { extra: true } });
  });
});
