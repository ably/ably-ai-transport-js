// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RunNode } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useView } from '../../src/react/use-view.js';
import { createMockSession } from './helper/mock-session.js';

const makeRun = (runId: string, projection?: unknown): RunNode<unknown> => ({
  runId,
  parentRunId: undefined,
  forkOf: undefined,
  regeneratesCodecMessageId: undefined,
  clientId: '',
  invocationId: '',
  status: 'complete',
  projection,
  startSerial: undefined,
  endSerial: undefined,
});

describe('useView', () => {
  it('returns empty nodes, hasOlder=false, loading=false when no source and no nearest session', () => {
    const { result } = renderHook(() => useView());
    expect(result.current.nodes).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns initial nodes and messages from view on mount', () => {
    const mock = createMockSession(['hello', 'world']);
    const { result } = renderHook(() => useView({ session: mock.session }));
    // mock-session returns one Run per seed message
    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0]?.runId).toBe('run-0');
    expect(result.current.nodes[1]?.runId).toBe('run-1');
    expect(result.current.messages).toEqual(['hello', 'world']);
  });

  it('updates nodes and messages when view emits update', () => {
    const mock = createMockSession(['hello']);
    const { result } = renderHook(() => useView({ session: mock.session }));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.messages).toEqual(['hello']);

    // Mutate mock to return a new node list and message list.
    const updatedNodes = [makeRun('run-0'), makeRun('run-1')];
    (mock.view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue(updatedNodes);
    (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(['hello', 'world']);
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

    const callCountBefore = (mock.view.flattenNodes as ReturnType<typeof vi.fn>).mock.calls.length;

    unmount();

    act(() => {
      mock.emitTree('update');
    });

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
            nearest: { session: mock.session },
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
  // RunNode-shape handle queries
  // ---------------------------------------------------------------------------

  describe('Run-keyed query callbacks', () => {
    it('select forwards to view.select', () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      act(() => {
        result.current.select('run-1', 0);
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.select).toHaveBeenCalledWith('run-1', 0);
    });

    it('getSelectedIndex forwards to view.getSelectedIndex', () => {
      const mock = createMockSession();
      (mock.view.getSelectedIndex as ReturnType<typeof vi.fn>).mockReturnValue(3);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.getSelectedIndex('run-1')).toBe(3);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.getSelectedIndex).toHaveBeenCalledWith('run-1');
    });

    it('getRunNode forwards to view.getRunNode', () => {
      const mock = createMockSession();
      const node = makeRun('run-1');
      (mock.view.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue(node);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.getRunNode('run-1')).toBe(node);
    });

    it('getMessageMetadata forwards to view.getMessageMetadata', () => {
      const mock = createMockSession();
      const metadata = {
        codecMessageId: 'm1',
        runId: 'run-1',
        clientId: 'c1',
        status: 'streaming' as const,
      };
      (mock.view.getMessageMetadata as ReturnType<typeof vi.fn>).mockReturnValue(metadata);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.getMessageMetadata('m1')).toEqual(metadata);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      expect(result.current.getRunNode('a')).toBeUndefined();
      expect(result.current.getMessageMetadata('m1')).toBeUndefined();
      expect(result.current.getSelectedIndex('a')).toBe(0);
    });
  });

  describe('Msg-anchored query callbacks', () => {
    it('hasMessageSiblings forwards to view.hasMessageSiblings', () => {
      const mock = createMockSession();
      (mock.view.hasMessageSiblings as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.hasMessageSiblings('msg-1')).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.hasMessageSiblings).toHaveBeenCalledWith('msg-1');
    });

    it('getMessageSiblings forwards to view.getMessageSiblings', () => {
      const mock = createMockSession();
      const siblings = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      (mock.view.getMessageSiblings as ReturnType<typeof vi.fn>).mockReturnValue(siblings);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.getMessageSiblings('msg-1')).toEqual(siblings);
    });

    it('getSelectedMessageSiblingIndex forwards to view.getSelectedMessageSiblingIndex', () => {
      const mock = createMockSession();
      (mock.view.getSelectedMessageSiblingIndex as ReturnType<typeof vi.fn>).mockReturnValue(2);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.getSelectedMessageSiblingIndex('msg-1')).toBe(2);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.getSelectedMessageSiblingIndex).toHaveBeenCalledWith('msg-1');
    });

    it('selectMessageSibling forwards to view.selectMessageSibling', () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));
      act(() => {
        result.current.selectMessageSibling('msg-1', 1);
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.selectMessageSibling).toHaveBeenCalledWith('msg-1', 1);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      expect(result.current.hasMessageSiblings('msg-1')).toBe(false);
      expect(result.current.getMessageSiblings('msg-1')).toEqual([]);
      expect(result.current.getSelectedMessageSiblingIndex('msg-1')).toBe(0);
      // selectMessageSibling is a no-op without a session; just confirm it doesn't throw.
      expect(() => {
        result.current.selectMessageSibling('msg-1', 0);
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

  describe('sendInput', () => {
    it('delegates to view.sendInput', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      const input = { kind: 'user-message' as const };
      await act(async () => {
        await result.current.sendInput([input], { parent: 'p1' });
      });

      expect(mock.sendInput).toHaveBeenCalledWith([input], { parent: 'p1' });
    });

    it('returns a stable reference across rerenders', () => {
      const mock = createMockSession();
      const { result, rerender } = renderHook(() => useView({ session: mock.session }));
      const first = result.current.sendInput;
      rerender();
      expect(result.current.sendInput).toBe(first);
    });

    it('throws when no view is available', async () => {
      const { result } = renderHook(() => useView());

      await act(async () => {
        await expect(result.current.sendInput([{ kind: 'user-message' }])).rejects.toMatchObject({
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
        await result.current.sendMessage('hello', { parent: 'p1' });
      });

      expect(mock.sendMessage).toHaveBeenCalledWith('hello', { parent: 'p1' });
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

      const replacement = { kind: 'edit' as const };
      await act(async () => {
        await result.current.edit('msg-1', [replacement], { parent: 'p1' });
      });

      expect(mock.edit).toHaveBeenCalledWith('msg-1', [replacement], { parent: 'p1' });
    });

    it('delegates to view.edit with a single message', async () => {
      const mock = createMockSession();
      const { result } = renderHook(() => useView({ session: mock.session }));

      const single = { kind: 'edit' as const };
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
        await expect(result.current.edit('msg-1', { kind: 'edit' })).rejects.toMatchObject({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
        });
      });
    });
  });
});
