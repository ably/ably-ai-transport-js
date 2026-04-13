// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { NearestTransportContext } from '../../src/react/contexts/transport-context.js';
import { useView } from '../../src/react/use-view.js';
import { createMockTransport } from './helper/mock-transport.js';

describe('useView', () => {
  it('returns empty nodes, hasOlder=false, loading=false when no source and no nearest transport', () => {
    const { result } = renderHook(() => useView());
    expect(result.current.nodes).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns initial nodes and messages from view on mount', () => {
    const mock = createMockTransport(['hello', 'world']);
    const { result } = renderHook(() => useView({ transport: mock.transport }));
    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0]?.message).toBe('hello');
    expect(result.current.nodes[1]?.message).toBe('world');
    expect(result.current.messages).toEqual(['hello', 'world']);
  });

  it('updates nodes and messages when view emits update', () => {
    const mock = createMockTransport(['hello']);
    const { result } = renderHook(() => useView({ transport: mock.transport }));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);

    // Mutate mock to return a new node list
    const updatedNodes = [
      { message: 'hello', msgId: 'msg-0', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
      { message: 'world', msgId: 'msg-1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
    ];
    (mock.view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue(updatedNodes);
    (mock.view.hasOlder as ReturnType<typeof vi.fn>).mockReturnValue(true);

    act(() => {
      mock.emitTree('update');
    });

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.messages).toEqual(['hello', 'world']);
    expect(result.current.hasOlder).toBe(true);
  });

  it('loadOlder sets loading, calls view.loadOlder, then clears loading', async () => {
    const mock = createMockTransport();
    let resolveFn: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(deferred);

    const { result } = renderHook(() => useView({ transport: mock.transport }));

    // Start loading
    let loadPromise: Promise<void>;
    act(() => {
      loadPromise = result.current.loadOlder();
    });
    expect(result.current.loading).toBe(true);

    // Resolve
    await act(async () => {
      resolveFn();
      await loadPromise;
    });
    expect(result.current.loading).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).toHaveBeenCalledOnce();
  });

  it('prevents concurrent loadOlder calls', async () => {
    const mock = createMockTransport();
    let resolveFn: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(deferred);

    const { result } = renderHook(() => useView({ transport: mock.transport }));

    // First call
    let loadPromise: Promise<void>;
    act(() => {
      loadPromise = result.current.loadOlder();
    });

    // Second call while first is pending — should be a no-op
    act(() => {
      void result.current.loadOlder();
    });

    await act(async () => {
      resolveFn();
      await loadPromise;
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).toHaveBeenCalledOnce();
  });

  it('auto-loads on mount when limit is provided', () => {
    const mock = createMockTransport();

    renderHook(() => useView({ transport: mock.transport, limit: 50 }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).toHaveBeenCalledWith(50);
  });

  it('does not auto-load when limit is omitted', () => {
    const mock = createMockTransport();

    renderHook(() => useView({ transport: mock.transport }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).not.toHaveBeenCalled();
  });

  it('update calls the view update method', async () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useView({ transport: mock.transport }));

    const events = ['tool-output'];

    await act(async () => {
      await result.current.update('target-1', events);
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.update).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.update).toHaveBeenCalledWith('target-1', events, undefined);
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockTransport(['hello']);
    const { unmount } = renderHook(() => useView({ transport: mock.transport }));

    unmount();

    // After unmount, update the mock and emit — state should not change
    const callCountBefore = (mock.view.flattenNodes as ReturnType<typeof vi.fn>).mock.calls.length;

    act(() => {
      mock.emitTree('update');
    });

    // flattenNodes should not be called again after unmount
    expect((mock.view.flattenNodes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
  });

  it('subscribes to a view directly when view prop is provided', () => {
    const mock = createMockTransport(['hello']);

    const { result } = renderHook(() => useView({ view: mock.view }));

    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });

  it('uses nearest transport from context when transport and view are omitted', () => {
    const mock = createMockTransport(['hello']);
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        NearestTransportContext.Provider,
        { value: mock.transport as ClientTransport<unknown, unknown> },
        children,
      );

    const { result } = renderHook(() => useView(), { wrapper });

    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });
});
