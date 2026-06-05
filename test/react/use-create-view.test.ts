// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { CodecInputEvent, CodecOutputEvent } from '../../src/core/codec/types.js';
import type { ClientSession } from '../../src/core/transport/types.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useCreateView } from '../../src/react/use-create-view.js';
import { createMockSession } from './helper/mock-session.js';

describe('useCreateView', () => {
  it('returns empty handle when session is undefined', () => {
    const { result } = renderHook(() => useCreateView({ session: undefined }));

    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('returns empty handle when session is null', () => {
    const { result } = renderHook(() => useCreateView({ session: null })); // eslint-disable-line unicorn/no-null -- testing the null input path

    expect(result.current.messages).toEqual([]);
  });

  it('creates a view and returns a populated handle', () => {
    const mock = createMockSession(['hello']);

    const { result } = renderHook(() => useCreateView({ session: mock.session }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.session.createView).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual([{ transportMessageId: 'hello', message: 'hello' }]);
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
      initialProps: { session: mock1.session },
    });

    expect(result.current.messages).toEqual([{ transportMessageId: 'first', message: 'first' }]);

    act(() => {
      rerender({ session: mock2.session });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock1.view.close).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual([{ transportMessageId: 'second', message: 'second' }]);
  });

  it('closes the view and returns empty handle when session changes to undefined', () => {
    const mock = createMockSession(['hello']);

    const initialProps: { session: ClientSession<CodecInputEvent, CodecOutputEvent, unknown, string> | undefined } = {
      session: mock.session,
    };
    const { result, rerender } = renderHook(({ session }) => useCreateView({ session }), {
      initialProps,
    });

    expect(result.current.messages).toEqual([{ transportMessageId: 'hello', message: 'hello' }]);

    act(() => {
      rerender({ session: undefined });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual([]);
  });

  it('delegates write operations to the created view', async () => {
    const mock = createMockSession();

    const { result } = renderHook(() => useCreateView({ session: mock.session }));

    const input = { kind: 'user-message' as const };
    await act(async () => {
      await result.current.send([input]);
    });

    expect(mock.send).toHaveBeenCalledWith([input], undefined);
  });

  it('returns empty handle when no session and no nearest context', () => {
    const { result } = renderHook(() => useCreateView());

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
            nearest: { session: mock.session },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useCreateView(), { wrapper });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.session.createView).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual([{ transportMessageId: 'hello', message: 'hello' }]);
  });
});
