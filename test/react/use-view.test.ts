// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useView } from '../../src/react/use-view.js';
import { createMockSession } from './helper/mock-session.js';

describe('useView', () => {
  it('returns empty nodes, hasOlder=false, loading=false when no source and no nearest session', () => {
    const { result } = renderHook(() => useView());
    expect(result.current.nodes).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns initial nodes and messages from view on mount', () => {
    const mock = createMockSession(['hello', 'world']);
    const { result } = renderHook(() => useView({ session: mock.session }));
    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0]?.message).toBe('hello');
    expect(result.current.nodes[1]?.message).toBe('world');
    expect(result.current.messages).toEqual(['hello', 'world']);
  });

  it('updates nodes and messages when view emits update', () => {
    const mock = createMockSession(['hello']);
    const { result } = renderHook(() => useView({ session: mock.session }));
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
    const mock = createMockSession();
    let resolveFn: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(deferred);

    const { result } = renderHook(() => useView({ session: mock.session }));

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
    const mock = createMockSession();
    let resolveFn: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(deferred);

    const { result } = renderHook(() => useView({ session: mock.session }));

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
    const mock = createMockSession();

    renderHook(() => useView({ session: mock.session, limit: 50 }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).toHaveBeenCalledWith(50);
  });

  it('does not auto-load when limit is omitted', () => {
    const mock = createMockSession();

    renderHook(() => useView({ session: mock.session }));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
    expect(mock.view.loadOlder).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockSession(['hello']);
    const { unmount } = renderHook(() => useView({ session: mock.session }));

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
    const mock = createMockSession(['hello']);

    const { result } = renderHook(() => useView({ view: mock.view }));

    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });

  it('uses nearest session from context when session and view are omitted', () => {
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

    const { result } = renderHook(() => useView(), { wrapper });

    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);
  });

  // ---------------------------------------------------------------------------
  // Reference stability during streaming
  // ---------------------------------------------------------------------------

  it('preserves message references for unchanged messages during streaming update', () => {
    const msg1 = 'stable-message';
    const msg2 = 'streaming-message';
    const mock = createMockSession([msg1, msg2]);
    const { result } = renderHook(() => useView(mock.session));

    // Verify initial messages
    expect(result.current.messages[0]).toBe(msg1);
    expect(result.current.messages[1]).toBe(msg2);

    // Simulate streaming update: msg2 changes, msg1 stays (same reference)
    const msg2Updated = 'streaming-message-updated';
    const updatedNodes = [
      { message: msg1, msgId: 'msg-0', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
      { message: msg2Updated, msgId: 'msg-1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
    ];
    (mock.view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue(updatedNodes);

    act(() => {
      mock.emitTree('update');
    });

    // msg1's reference should be preserved - same string object
    expect(result.current.messages[0]).toBe(msg1);
    // msg2's reference should be the new value
    expect(result.current.messages[1]).toBe(msg2Updated);
  });

  describe('error', () => {
    it('error is undefined initially', () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.loadError).toBeUndefined();
    });

    it('error is set when loadOlder rejects', async () => {
      const mock = createMockSession();
      const loadError = new Ably.ErrorInfo('unable to load older messages; network error', ErrorCode.BadRequest, 400);
      (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(Promise.reject(loadError));

      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(result.current.loadError).toBe(loadError);
      expect(result.current.loading).toBe(false);
    });

    it('error is cleared on next successful loadOlder', async () => {
      const mock = createMockSession();
      const loadError = new Ably.ErrorInfo('unable to load older messages; network error', ErrorCode.BadRequest, 400);

      // First call fails
      (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValueOnce(Promise.reject(loadError));
      // Second call succeeds
      (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValueOnce(Promise.resolve());

      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.loadError).toBe(loadError);

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.loadError).toBeUndefined();
    });

    it('clears loadError when the view changes', async () => {
      const mockA = createMockSession();
      const loadError = new Ably.ErrorInfo('unable to load; network error', ErrorCode.BadRequest, 400);
      (mockA.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(Promise.reject(loadError));

      let currentView = mockA.view;
      const { result, rerender } = renderHook(() => useView({ view: currentView }));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.loadError).toBe(loadError);

      // Switch to a different view — loadError must be cleared.
      const mockB = createMockSession();
      act(() => {
        currentView = mockB.view;
        rerender();
      });

      expect(result.current.loadError).toBeUndefined();
    });

    it('error is undefined when skip is true', () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session, skip: true }));
      expect(result.current.loadError).toBeUndefined();
    });
  });

  describe('sendEvent', () => {
    it('delegates to view.sendEvent', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.sendEvent(['hello'], { body: { extra: true } });
      });

      expect(mock.sendEvent).toHaveBeenCalledWith(['hello'], { body: { extra: true } });
    });

    it('returns a stable reference across rerenders', () => {
      const mock = createMockSession();
      const { result, rerender } = renderHook(() => useView({ session: mock.session }));
      const first = result.current.sendEvent;
      rerender();
      expect(result.current.sendEvent).toBe(first);
    });

    it('throws when no view is available', async () => {
      const { result } = renderHook(() => useView());

      await act(async () => {
        await expect(result.current.sendEvent(['hello'])).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });

  describe('sendMessage', () => {
    it('delegates to view.sendMessage', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.sendMessage('hello', { body: { extra: true } });
      });

      expect(mock.sendMessage).toHaveBeenCalledWith('hello', { body: { extra: true } });
    });
  });

  describe('regenerate', () => {
    it('delegates to view.regenerate', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.regenerate('msg-1', { body: { extra: true } });
      });

      expect(mock.regenerate).toHaveBeenCalledWith('msg-1', { body: { extra: true } });
    });

    it('returns a stable reference across rerenders', () => {
      const mock = createMockSession();
      const { result, rerender } = renderHook(() => useView({ session: mock.session }));
      const first = result.current.regenerate;
      rerender();
      expect(result.current.regenerate).toBe(first);
    });

    it('throws when no view is available', async () => {
      const { result } = renderHook(() => useView());

      await act(async () => {
        await expect(result.current.regenerate('msg-1')).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });

  describe('edit', () => {
    it('delegates to view.edit with a messages array', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.edit('msg-1', ['replacement'], { body: { extra: true } });
      });

      expect(mock.edit).toHaveBeenCalledWith('msg-1', ['replacement'], { body: { extra: true } });
    });

    it('delegates to view.edit with a single message', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.edit('msg-1', 'single-replacement');
      });

      expect(mock.edit).toHaveBeenCalledWith('msg-1', 'single-replacement', undefined);
    });

    it('returns a stable reference across rerenders', () => {
      const mock = createMockSession();
      const { result, rerender } = renderHook(() => useView({ session: mock.session }));
      const first = result.current.edit;
      rerender();
      expect(result.current.edit).toBe(first);
    });

    it('throws when no view is available', async () => {
      const { result } = renderHook(() => useView());

      await act(async () => {
        await expect(result.current.edit('msg-1', 'replacement')).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });
});
