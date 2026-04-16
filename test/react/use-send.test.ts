// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { NearestTransportContext } from '../../src/react/contexts/transport-context.js';
import { useSend } from '../../src/react/use-send.js';
import { createMockTransport } from './helper/mock-transport.js';

// Wrap renderHook with a NearestTransportContext providing the given transport.
const withNearestTransport =
  (transport: ClientTransport<unknown, unknown>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(NearestTransportContext.Provider, { value: { transport, error: undefined } }, children);

describe('useSend', () => {
  it('returns a stable send function', () => {
    const { view } = createMockTransport();
    const { result, rerender } = renderHook(() => useSend({ view }));

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('delegates to view.send', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useSend({ view: mock.view }));

    await act(async () => {
      await result.current(['hello'], { body: { extra: true } });
    });

    expect(mock.send).toHaveBeenCalledWith(['hello'], { body: { extra: true } });
  });

  it('resolves view from nearest transport context when view is omitted', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useSend(), {
      wrapper: withNearestTransport(mock.transport),
    });

    await act(async () => {
      await result.current(['hello']);
    });

    expect(mock.send).toHaveBeenCalledWith(['hello'], undefined);
  });

  it('throws when no view and no context transport', async () => {
    const { result } = renderHook(() => useSend());

    await act(async () => {
      await expect(result.current(['hello'])).rejects.toMatchObject({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
      });
    });
  });

  it('throws when view is explicitly undefined (no context)', async () => {
    const { result } = renderHook(() => useSend({ view: undefined }));

    await act(async () => {
      await expect(result.current(['hello'])).rejects.toMatchObject({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
      });
    });
  });
});
