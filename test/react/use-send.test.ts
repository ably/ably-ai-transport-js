// @vitest-environment jsdom

import { act,renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSend } from '../../src/react/use-send.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useSend', () => {
  it('returns a stable send function', () => {
    const { transport } = createMockTransport();
    const { result, rerender } = renderHook(() => useSend(transport));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('delegates to transport.send', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useSend(mock.transport));

    await act(async () => {
      await result.current(['hello'], { body: { extra: true } });
    });

    expect(mock.send).toHaveBeenCalledWith(['hello'], { body: { extra: true } });
  });
});
