// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSend } from '../../src/react/use-send.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useSend', () => {
  it('returns a stable send function', () => {
    const { view } = createMockTransport();
    const { result, rerender } = renderHook(() => useSend(view));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('delegates to view.send', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useSend(mock.view));

    await act(async () => {
      await result.current(['hello'], { body: { extra: true } });
    });

    expect(mock.send).toHaveBeenCalledWith(['hello'], { body: { extra: true } });
  });
});
