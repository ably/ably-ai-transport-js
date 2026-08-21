// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BranchHandle, RunInfo } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useView } from '../../src/react/use-view.js';
import { createMockSession } from './helper/mock-session.js';

/**
 * Build a {@link RunInfo} with the given status. Restricted to the non-error
 * statuses, which is the arm of the union that carries no `error`.
 * @param status - The lifecycle status to report.
 * @returns A RunInfo for the single Run the reactivity tests track.
 */
const runInfo = (status: Exclude<RunInfo['status'], 'error'>): RunInfo => ({
  runId: 'run-1',
  clientId: 'c1',
  status,
  invocationId: 'inv-1',
  steps: [],
});

/**
 * Render `useView` and record the status a consumer derives in its render
 * body — the documented pattern for gating a Stop button on the owning Run.
 * The recorded tail is the value the component last rendered with, so a status
 * change that never re-renders shows up as a stale entry.
 * @param mock - The mock session backing the view.
 * @returns The recorded statuses alongside the renderHook result.
 */
const renderDerivingStatus = (mock: ReturnType<typeof createMockSession>) => {
  const derived: (RunInfo['status'] | undefined)[] = [];
  const rendered = renderHook(() => {
    const view = useView({ session: mock.session });
    derived.push(view.runOf('hello')?.status);
    return view;
  });
  return { derived, ...rendered };
};

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

  it('re-renders on a view run event so run-status reads stay reactive', () => {
    const mock = createMockSession(['hello']);
    let renders = 0;
    renderHook(() => {
      renders++;
      return useView({ session: mock.session });
    });
    const before = renders;

    // A run suspending or ending changes content within a run without changing
    // the visible structure, so the View emits its `run` event without an
    // accompanying `update`. The hook must still re-render so a consumer reading
    // run status via runOf / run / runs sees the change.
    act(() => {
      mock.emitTree('run', { type: 'suspend', runId: 'run-1' });
    });

    expect(renders).toBeGreaterThan(before);
  });

  it('loadOlder sets loading, calls view.loadOlder, then clears loading', async () => {
    const mock = createMockSession();
    let resolveFn: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(deferred);

    const { result } = renderHook(() => useView({ session: mock.session }));

    let loadPromise: Promise<unknown>;
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

  it('resolves loadOlder to the page the view revealed', async () => {
    const mock = createMockSession();
    const revealed = [{ codecMessageId: 'cmid-old', message: 'old' }];
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockResolvedValue(revealed);

    const { result } = renderHook(() => useView({ session: mock.session }));

    let page: unknown;
    await act(async () => {
      page = await result.current.loadOlder();
    });
    expect(page).toEqual(revealed);
  });

  it('returns [] from loadOlder when no view is resolved (skip: true)', async () => {
    const mock = createMockSession();
    const { result } = renderHook(() => useView({ session: mock.session, skip: true }));

    let page: unknown;
    await act(async () => {
      page = await result.current.loadOlder();
    });
    expect(page).toEqual([]);
  });

  it('returns [] from loadOlder when the view load fails', async () => {
    const mock = createMockSession();
    (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.reject(new Ably.ErrorInfo('unable to load older messages; network error', ErrorCode.BadRequest, 400)),
    );

    const { result } = renderHook(() => useView({ session: mock.session }));

    let page: unknown;
    await act(async () => {
      page = await result.current.loadOlder();
    });
    expect(page).toEqual([]);
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
      const info: RunInfo = { runId: 'run-1', clientId: 'c1', status: 'active', invocationId: 'inv-1', steps: [] };
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(info);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.runOf('msg-1')).toEqual(info);
    });

    it('run forwards to view.run', () => {
      const mock = createMockSession();
      const info: RunInfo = { runId: 'run-1', clientId: 'c1', status: 'complete', invocationId: 'inv-1', steps: [] };
      (mock.view.run as ReturnType<typeof vi.fn>).mockReturnValue(info);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.run('run-1')).toEqual(info);
    });

    it('runs forwards to view.runs', () => {
      const mock = createMockSession();
      const list: RunInfo[] = [
        { runId: 'run-1', clientId: 'c1', status: 'complete', invocationId: 'inv-1', steps: [] },
        { runId: 'run-2', clientId: 'c1', status: 'active', invocationId: 'inv-2', steps: [] },
      ];
      (mock.view.runs as ReturnType<typeof vi.fn>).mockReturnValue(list);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.runs()).toEqual(list);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      expect(result.current.runOf('msg-1')).toBeUndefined();
      expect(result.current.run('run-1')).toBeUndefined();
      expect(result.current.runs()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Branch selection
  // ---------------------------------------------------------------------------

  describe('Branch selection callbacks', () => {
    it('branchSelection forwards to view.branchSelection', () => {
      const mock = createMockSession();
      const handle: BranchHandle<string> = {
        hasSiblings: true,
        siblings: ['a', 'b', 'c'],
        index: 1,
        selected: 'b',
        select: vi.fn(),
      };
      (mock.view.branchSelection as ReturnType<typeof vi.fn>).mockReturnValue(handle);
      const { result } = renderHook(() => useView({ session: mock.session }));
      expect(result.current.branchSelection('msg-1')).toEqual(handle);
    });

    it('branchSelection() returns the view-supplied handle and select() drives it', () => {
      const mock = createMockSession();
      const select = vi.fn();
      (mock.view.branchSelection as ReturnType<typeof vi.fn>).mockReturnValue({
        hasSiblings: true,
        siblings: ['a', 'b'],
        index: 0,
        selected: 'a',
        select,
      });
      const { result } = renderHook(() => useView({ session: mock.session }));
      act(() => {
        result.current.branchSelection('msg-1').select(1);
      });
      // The hook forwards the id to the view and hands back the view's own
      // handle, so select() routes to the view-supplied spy — not a wrapper.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock
      expect(mock.view.branchSelection).toHaveBeenCalledWith('msg-1');
      expect(select).toHaveBeenCalledWith(1);
    });

    it('safe defaults when no session is available', () => {
      const { result } = renderHook(() => useView());
      const branch = result.current.branchSelection('msg-1');
      expect(branch.hasSiblings).toBe(false);
      expect(branch.siblings).toEqual([]);
      expect(branch.index).toBe(0);
      expect(branch.selected).toBeUndefined();
      // select is a no-op without a session; just confirm it doesn't throw.
      expect(() => {
        branch.select(0);
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

    it('wraps a non-ErrorInfo loadOlder rejection as SessionHistoryFetchFailed', async () => {
      const mock = createMockSession();
      (mock.view.loadOlder as ReturnType<typeof vi.fn>).mockReturnValue(Promise.reject(new Error('boom')));

      const { result } = renderHook(() => useView({ session: mock.session }));

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(result.current.loadError).toBeErrorInfo({
        code: ErrorCode.SessionHistoryFetchFailed,
        statusCode: 500,
        message: 'unable to load older messages; boom',
      });
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

  // ---------------------------------------------------------------------------
  // Run lifecycle reactivity
  // ---------------------------------------------------------------------------

  describe('Run lifecycle reactivity', () => {
    it('re-renders on run-end so a runOf-derived status is current', () => {
      const mock = createMockSession(['hello']);
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('active'));

      const { derived } = renderDerivingStatus(mock);
      expect(derived.at(-1)).toBe('active');

      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('complete'));
      act(() => {
        mock.emitTree('run', {
          type: 'end',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-1',
          reason: 'complete',
        });
      });

      expect(derived.at(-1)).toBe('complete');
    });

    it('re-renders on suspend and resume', () => {
      const mock = createMockSession(['hello']);
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('active'));

      const { derived } = renderDerivingStatus(mock);

      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('suspended'));
      act(() => {
        mock.emitTree('run', {
          type: 'suspend',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-1',
        });
      });
      expect(derived.at(-1)).toBe('suspended');

      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('active'));
      act(() => {
        mock.emitTree('run', {
          type: 'resume',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-2',
        });
      });
      expect(derived.at(-1)).toBe('active');
    });

    it('holds the Run lookups stable across a message-only update', () => {
      const mock = createMockSession(['hello']);
      const { result } = renderHook(() => useView({ session: mock.session }));
      const before = result.current.runOf;

      (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        { codecMessageId: 'cmid-1', message: 'hello' },
        { codecMessageId: 'cmid-2', message: 'world' },
      ]);
      act(() => {
        mock.emitTree('update');
      });

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.runOf).toBe(before);
    });

    it('unsubscribes from run events on unmount', () => {
      const mock = createMockSession(['hello']);
      const { unmount } = renderHook(() => useView({ session: mock.session }));
      expect(mock.viewHandlerCount('run')).toBe(1);

      unmount();

      expect(mock.viewHandlerCount('run')).toBe(0);
    });

    it('does not subscribe to run events when skip is true', () => {
      const mock = createMockSession(['hello']);
      renderHook(() => useView({ session: mock.session, skip: true }));

      expect(mock.viewHandlerCount('run')).toBe(0);
    });

    it('re-renders on run-start', () => {
      // The mock's `runOf` answers undefined until stubbed — the pre-run state.
      const mock = createMockSession(['hello']);

      const { derived } = renderDerivingStatus(mock);
      expect(derived.at(-1)).toBeUndefined();

      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('active'));
      act(() => {
        mock.emitTree('run', {
          type: 'start',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-1',
        });
      });

      expect(derived.at(-1)).toBe('active');
    });

    it('re-renders when a run ends in error', () => {
      const mock = createMockSession(['hello']);
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue(runInfo('active'));

      const { derived } = renderDerivingStatus(mock);

      const error = new Ably.ErrorInfo('unable to complete run; model failed', ErrorCode.BadRequest, 400);
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: 'run-1',
        clientId: 'c1',
        status: 'error',
        invocationId: 'inv-1',
        steps: [],
        error,
      });
      act(() => {
        mock.emitTree('run', {
          type: 'end',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-1',
          reason: 'error',
          error,
        });
      });

      expect(derived.at(-1)).toBe('error');
    });

    it('holds every handle callback stable across a run event', () => {
      const mock = createMockSession(['hello']);
      const { result } = renderHook(() => useView({ session: mock.session }));
      const before = {
        runOf: result.current.runOf,
        run: result.current.run,
        runs: result.current.runs,
        send: result.current.send,
        regenerate: result.current.regenerate,
        edit: result.current.edit,
        branchSelection: result.current.branchSelection,
        loadOlder: result.current.loadOlder,
      };

      act(() => {
        mock.emitTree('run', {
          type: 'end',
          runId: 'run-1',
          clientId: 'c1',
          invocationId: 'inv-1',
          serial: 'serial-1',
          reason: 'complete',
        });
      });

      expect(result.current.runOf).toBe(before.runOf);
      expect(result.current.run).toBe(before.run);
      expect(result.current.runs).toBe(before.runs);
      expect(result.current.send).toBe(before.send);
      expect(result.current.regenerate).toBe(before.regenerate);
      expect(result.current.edit).toBe(before.edit);
      expect(result.current.branchSelection).toBe(before.branchSelection);
      expect(result.current.loadOlder).toBe(before.loadOlder);
    });

    it('re-reads Run state once it has subscribed', () => {
      const mock = createMockSession(['hello']);
      // Hold the message snapshot reference-stable, as the real view does, so
      // the effect's message sync is an Object.is no-op and React bails out of
      // it. Any render past the first is then attributable to the Run re-read.
      (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        { codecMessageId: 'hello', message: 'hello' },
      ]);

      let renders = 0;
      renderHook(() => {
        renders += 1;
        return useView({ session: mock.session });
      });

      // A lifecycle event landing between the first render and the
      // subscription reaches no handler, and nothing follows a terminal event
      // to correct it — so subscribing re-reads rather than trusting the
      // status the first render saw.
      expect(renders).toBeGreaterThan(1);
    });
  });
});
