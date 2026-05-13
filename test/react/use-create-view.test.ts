// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientSession } from '../../src/core/transport/types.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useCreateView } from '../../src/react/use-create-view.js';
import { createMockSession } from './helper/mock-session.js';

describe('useCreateView', () => {
  it('returns empty handle when session is undefined', () => {
    const { result } = renderHook(() => useCreateView({ session: undefined }));

    expect(result.current.nodes).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('returns empty handle when session is null', () => {
    const { result } = renderHook(() => useCreateView({ session: null })); // eslint-disable-line unicorn/no-null -- testing the null input path

    expect(result.current.nodes).toEqual([]);
  });

  it('creates a view and returns a populated handle', () => {
    const mock = createMockSession(['hello']);

    const { result } = renderHook(() => useCreateView({ session: mock.session }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.session.createView).toHaveBeenCalledOnce();
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });

  it('closes the view on unmount', () => {
    const mock = createMockSession();

    const { unmount } = renderHook(() => useCreateView({ session: mock.session }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).not.toHaveBeenCalled();

    unmount();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).toHaveBeenCalledOnce();
  });

  it('closes the old view and creates a new one when session changes', () => {
    const mock1 = createMockSession(['first']);
    const mock2 = createMockSession(['second']);

    const { result, rerender } = renderHook(({ session }) => useCreateView({ session }), {
      initialProps: { session: mock1.session as ClientSession<unknown, unknown, string> | undefined },
    });

    expect(result.current.messages).toEqual(['first']);

    act(() => {
      rerender({ session: mock2.session });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock1.view.close).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual(['second']);
  });

  it('closes the view and returns empty handle when session changes to undefined', () => {
    const mock = createMockSession(['hello']);

    const { result, rerender } = renderHook(({ session }) => useCreateView({ session }), {
      initialProps: { session: mock.session as ClientSession<unknown, unknown, string> | undefined },
    });

    expect(result.current.messages).toEqual(['hello']);

    act(() => {
      rerender({ session: undefined });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).toHaveBeenCalledOnce();
    expect(result.current.nodes).toEqual([]);
  });

  it('delegates write operations to the created view', async () => {
    const mock = createMockSession();

    const { result } = renderHook(() => useCreateView({ session: mock.session }));

    await act(async () => {
      await result.current.send(['new message']);
    });

    expect(mock.send).toHaveBeenCalledWith(['new message'], undefined);
  });

  it('returns empty handle when no session and no nearest context', () => {
    const { result } = renderHook(() => useCreateView());

    expect(result.current.nodes).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('uses nearest session from context when session is omitted', () => {
    const mock = createMockSession(['hello']);
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

    const { result } = renderHook(() => useCreateView(), { wrapper });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.session.createView).toHaveBeenCalledOnce();
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });
});
