// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BranchSelection, RunInfo } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useView } from '../../src/react/use-view.js';
import { createMockSession } from './helper/mock-session.js';

describe('useView', () => {
  it('returns empty messages, hasOlder=false, loading=false when no source and no nearest session', () => {
    const { result } = renderHook(() => useView());
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns initial messages from view on mount, each paired with its codec-message-id', () => {
    const mock = createMockSession(['hello', 'world']);
    const { result } = renderHook(() => useView({ session: mock.session }));
    // The mock pairs each message with itself as the codec-message-id.
    expect(result.current.messages).toEqual([
      { codecMessageId: 'hello', message: 'hello' },
      { codecMessageId: 'world', message: 'world' },
    ]);
  });

  it('updates messages when view emits update', () => {
    const mock = createMockSession(['hello']);
    const { result } = renderHook(() => useView({ session: mock.session }));
    expect(result.current.messages).toEqual([{ codecMessageId: 'hello', message: 'hello' }]);

    // Mutate mock to return a new pair list with codec-message-ids distinct
    // from the domain messages — the SDK correlates on the former.
    (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
      { codecMessageId: 'cmid-1', message: 'hello' },
      { codecMessageId: 'cmid-2', message: 'world' },
    ]);
    (mock.view.hasOlder as ReturnType<typeof vi.fn>).mockReturnValue(true);

    act(() => {
      mock.emitTree('update');
    });

    expect(result.current.messages).toEqual([
      { codecMessageId: 'cmid-1', message: 'hello' },
      { codecMessageId: 'cmid-2', message: 'world' },
    ]);
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

    let loadPromise: Promise<void>;
    act(() => {
      loadPromise = result.current.loadOlder();
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveFn();
      await loadPromise;
    });
    expect(result.current.loading).toBe(false);
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

    const callCountBefore = (mock.view.getMessages as ReturnType<typeof vi.fn>).mock.calls.length;

    unmount();

    act(() => {
      mock.emitTree('update');
    });

    expect((mock.view.getMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
  });

  it('subscribes to a view directly when view prop is provided', () => {
    const mock = createMockSession(['hello']);

    const { result } = renderHook(() => useView({ view: mock.view }));

    expect(result.current.messages).toEqual([{ codecMessageId: 'hello', message: 'hello' }]);
  });

  it('uses nearest session from context when session and view are omitted', () => {
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

    const { result } = renderHook(() => useView(), { wrapper });

    expect(result.current.messages).toEqual([{ codecMessageId: 'hello', message: 'hello' }]);
  });

  // ---------------------------------------------------------------------------
  // Run lookup callbacks
  // ---------------------------------------------------------------------------

  describe('Run lookup callbacks', () => {
    it('runOf forwards to view.runOf', () => {
      const mock = createMockSession();
      const info: RunInfo = { runId: 'run-1', clientId: 'c1', status: 'active', invocationId: 'inv-1' };
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(info);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.runOf('msg-1')).toEqual(info);
    });

    it('run forwards to view.run', () => {
      const mock = createMockSession();
      const info: RunInfo = { runId: 'run-1', clientId: 'c1', status: 'complete', invocationId: 'inv-1' };
      (mock.view.run as ReturnType<typeof vi.fn>).mockReturnValue(info);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.run('run-1')).toEqual(info);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      expect(result.current.runOf('msg-1')).toBeUndefined();
      expect(result.current.run('run-1')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Branch selection
  // ---------------------------------------------------------------------------

  describe('Branch selection callbacks', () => {
    it('branchSelection forwards to view.branchSelection', () => {
      const mock = createMockSession();
      const bundle: BranchSelection<string> = {
        hasSiblings: true,
        siblings: ['a', 'b', 'c'],
        index: 1,
        selected: 'b',
      };
      (mock.view.branchSelection as ReturnType<typeof vi.fn>).mockReturnValue(bundle);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.branchSelection('msg-1')).toEqual(bundle);
    });

    it('selectSibling forwards to view.selectSibling', () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));
      act(() => {
        result.current.selectSibling('msg-1', 1);
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.selectSibling).toHaveBeenCalledWith('msg-1', 1);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      const branch = result.current.branchSelection('msg-1');
      expect(branch.hasSiblings).toBe(false);
      expect(branch.siblings).toEqual([]);
      expect(branch.index).toBe(0);
      expect(branch.selected).toBeUndefined();
      // selectSibling is a no-op without a session; just confirm it doesn't throw.
      expect(() => {
        result.current.selectSibling('msg-1', 0);
      }).not.toThrow();
    });
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

      (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValueOnce(Promise.reject(loadError));
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

  describe('send', () => {
    it('delegates to view.send', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      const input = { kind: 'user-message' as const };
      await act(async () => {
        await result.current.send([input], { parent: 'p1' });
      });

      expect(mock.send).toHaveBeenCalledWith([input], { parent: 'p1' });
    });

    it('returns a stable reference across rerenders', () => {
      const mock = createMockSession();
      const { result, rerender } = renderHook(() => useView({ session: mock.session }));
      const first = result.current.send;
      rerender();
      expect(result.current.send).toBe(first);
    });

    it('throws when no view is available', async () => {
      const { result } = renderHook(() => useView());

      await act(async () => {
        await expect(result.current.send([{ kind: 'user-message' }])).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });

  describe('regenerate', () => {
    it('delegates to view.regenerate', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.regenerate('msg-1', { parent: 'p1' });
      });

      expect(mock.regenerate).toHaveBeenCalledWith('msg-1', { parent: 'p1' });
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

      const replacement = { kind: 'user-message' as const };
      await act(async () => {
        await result.current.edit('msg-1', [replacement], { parent: 'p1' });
      });

      expect(mock.edit).toHaveBeenCalledWith('msg-1', [replacement], { parent: 'p1' });
    });

    it('delegates to view.edit with a single message', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      const single = { kind: 'user-message' as const };
      await act(async () => {
        await result.current.edit('msg-1', single);
      });

      expect(mock.edit).toHaveBeenCalledWith('msg-1', single, undefined);
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
        await expect(result.current.edit('msg-1', { kind: 'user-message' })).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });
});
