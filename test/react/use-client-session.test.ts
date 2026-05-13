// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { ClientSessionContext } from '../../src/react/contexts/client-session-context.js';
import { useClientSession } from '../../src/react/use-client-session.js';
import { createMockSession } from './helper/mock-session.js';

// Wrap renderHook with a ClientSessionContext providing the given channelName-to-session record (no nearest).
const withClientSessionContext =
  (record: Record<string, ClientSession<unknown, unknown, unknown>>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(
      ClientSessionContext.Provider,
      {
        value: {
          nearest: undefined,
          providers: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, { session: v }])),
        },
      },
      children,
    );

// Wrap renderHook with a ClientSessionContext exposing only a nearest slot.
const withNearestSession =
  (session: ClientSession<unknown, unknown, unknown>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(ClientSessionContext.Provider, { value: { nearest: { session }, providers: {} } }, children);

describe('useClientSession', () => {
  it('returns the session registered under the given channelName', () => {
    const { session } = createMockSession();
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }), {
      wrapper: withClientSessionContext({ 'ai:test': session }),
    });
    expect(result.current.session).toBe(session);
    expect(result.current.sessionError).toBeUndefined();
  });

  it('returns the session registered under a different channelName', () => {
    const { session } = createMockSession();
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:secondary' }), {
      wrapper: withClientSessionContext({ 'ai:secondary': session }),
    });
    expect(result.current.session).toBe(session);
    expect(result.current.sessionError).toBeUndefined();
  });

  it('returns the nearest session when no channelName is given', () => {
    const { session } = createMockSession();
    const { result } = renderHook(() => useClientSession(), {
      wrapper: withNearestSession(session),
    });
    expect(result.current.session).toBe(session);
    expect(result.current.sessionError).toBeUndefined();
  });

  it('sets sessionError with BadRequest when channelName given but no matching ClientSessionProvider', () => {
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:test' }));

    expect(result.current.sessionError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.sessionError?.message).toContain('no ClientSessionProvider found');
  });

  it('includes the channelName in the error message', () => {
    const { result } = renderHook(() => useClientSession({ channelName: 'ai:primary' }));

    expect(result.current.sessionError).toMatchObject({ code: ErrorCode.BadRequest });
    expect(result.current.sessionError?.message).toContain('"ai:primary"');
  });

  it('sets sessionError with BadRequest when no channelName and no nearest provider', () => {
    const { result } = renderHook(() => useClientSession());

    expect(result.current.sessionError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.sessionError?.message).toContain('no ClientSessionProvider found');
  });

  it('returns a stub session (not throw) when no provider found', () => {
    // The hook must not throw during render — check that tree access throws on the stub instead
    const { result } = renderHook(() => useClientSession());
    expect(result.current.sessionError).toBeDefined();
    expect(() => result.current.session.tree).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument }));
  });

  describe('skip', () => {
    it('returns a stub without setting sessionError when skip is true', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(result.current.session).toBeDefined();
      expect(result.current.sessionError).toBeUndefined();
    });

    it('stub tree getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(() => result.current.session.tree).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub view getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(() => result.current.session.view).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub createView throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(() => result.current.session.createView()).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub cancel throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(() => {
        void result.current.session.cancel();
      }).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }));
    });

    it('stub on throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      // CAST: cast to any overload to call without args in test
      expect(() => (result.current.session.on as (...args: unknown[]) => unknown)('error', vi.fn())).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub error messages are descriptive', () => {
      const { result } = renderHook(() => useClientSession({ skip: true }));
      expect(() => result.current.session.tree).toThrow(
        expect.objectContaining({ message: 'unable to access tree; hook is skipped' }),
      );
    });
  });

  describe('onError', () => {
    it('calls onError when the session emits an error event', () => {
      const mock = createMockSession();
      const onError = vi.fn();
      renderHook(() => useClientSession({ onError }), {
        wrapper: withNearestSession(mock.session),
      });

      const error = new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400);
      act(() => {
        mock.emit('error', error);
      });

      expect(onError).toHaveBeenCalledWith(error);
    });

    it('does not call onError after unmount', () => {
      const mock = createMockSession();
      const onError = vi.fn();
      const { unmount } = renderHook(() => useClientSession({ onError }), {
        wrapper: withNearestSession(mock.session),
      });

      unmount();

      act(() => {
        mock.emit('error', new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400));
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not subscribe when skip is true', () => {
      const mock = createMockSession();
      const onError = vi.fn();
      renderHook(() => useClientSession({ skip: true, onError }), {
        wrapper: withNearestSession(mock.session),
      });

      act(() => {
        mock.emit('error', new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400));
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not call onError when no provider found', () => {
      const onError = vi.fn();
      renderHook(() => useClientSession({ onError }));

      // No session to emit on — onError should never fire
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
