// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { TransportContext } from '../../src/react/contexts/transport-context.js';
import { useCreateView } from '../../src/react/use-create-view.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useCreateView', () => {
  it('returns empty handle when transport is undefined', () => {
    const { result } = renderHook(() => useCreateView({ transport: undefined }));

    expect(result.current.nodes).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('returns empty handle when transport is null', () => {
    const { result } = renderHook(() => useCreateView({ transport: null })); // eslint-disable-line unicorn/no-null -- testing the null input path

    expect(result.current.nodes).toEqual([]);
  });

  it('creates a view and returns a populated handle', () => {
    const mock = createMockTransport(['hello']);

    const { result } = renderHook(() => useCreateView({ transport: mock.transport }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.transport.createView).toHaveBeenCalledOnce();
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });

  it('closes the view on unmount', () => {
    const mock = createMockTransport();

    const { unmount } = renderHook(() => useCreateView({ transport: mock.transport }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).not.toHaveBeenCalled();

    unmount();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).toHaveBeenCalledOnce();
  });

  it('closes the old view and creates a new one when transport changes', () => {
    const mock1 = createMockTransport(['first']);
    const mock2 = createMockTransport(['second']);

    const { result, rerender } = renderHook(({ transport }) => useCreateView({ transport }), {
      initialProps: { transport: mock1.transport as ClientTransport<unknown, string> | undefined },
    });

    expect(result.current.messages).toEqual(['first']);

    act(() => {
      rerender({ transport: mock2.transport });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock1.view.close).toHaveBeenCalledOnce();
    expect(result.current.messages).toEqual(['second']);
  });

  it('closes the view and returns empty handle when transport changes to undefined', () => {
    const mock = createMockTransport(['hello']);

    const { result, rerender } = renderHook(({ transport }) => useCreateView({ transport }), {
      initialProps: { transport: mock.transport as ClientTransport<unknown, string> | undefined },
    });

    expect(result.current.messages).toEqual(['hello']);

    act(() => {
      rerender({ transport: undefined });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.close).toHaveBeenCalledOnce();
    expect(result.current.nodes).toEqual([]);
  });

  it('delegates write operations to the created view', async () => {
    const mock = createMockTransport();

    const { result } = renderHook(() => useCreateView({ transport: mock.transport }));

    await act(async () => {
      await result.current.send(['new message']);
    });

    expect(mock.send).toHaveBeenCalledWith(['new message'], undefined);
  });

  it('returns empty handle when no transport and no nearest context', () => {
    const { result } = renderHook(() => useCreateView());

    expect(result.current.nodes).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
  });

  it('uses nearest transport from context when transport is omitted', () => {
    const mock = createMockTransport(['hello']);
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportContext.Provider,
        {
          value: {
            nearest: { transport: mock.transport as ClientTransport<unknown, unknown>, error: undefined },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useCreateView(), { wrapper });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.transport.createView).toHaveBeenCalledOnce();
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });
});
