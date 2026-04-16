// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { NearestTransportContext, TransportContext } from '../../src/react/contexts/transport-context.js';
import { useClientTransport } from '../../src/react/use-client-transport.js';
import { createMockTransport } from './helper/mock-transport.js';

// Wrap renderHook with a TransportContext providing the given channelName-to-transport record.
const withTransportContext =
  (record: Record<string, ClientTransport<unknown, unknown>>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(
      TransportContext.Provider,
      { value: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, { transport: v, error: undefined }])) },
      children,
    );

// Wrap renderHook with a NearestTransportContext providing the given transport.
const withNearestTransport =
  (transport: ClientTransport<unknown, unknown>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(NearestTransportContext.Provider, { value: { transport, error: undefined } }, children);

describe('useClientTransport', () => {
  it('returns the transport registered under the given channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), {
      wrapper: withTransportContext({ 'ai:test': transport }),
    });
    expect(result.current.transport).toBe(transport);
    expect(result.current.transportError).toBeUndefined();
  });

  it('returns the transport registered under a different channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:secondary' }), {
      wrapper: withTransportContext({ 'ai:secondary': transport }),
    });
    expect(result.current.transport).toBe(transport);
    expect(result.current.transportError).toBeUndefined();
  });

  it('returns the nearest transport when no channelName is given', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport(), {
      wrapper: withNearestTransport(transport),
    });
    expect(result.current.transport).toBe(transport);
    expect(result.current.transportError).toBeUndefined();
  });

  it('sets transportError with BadRequest when channelName given but no matching TransportProvider', () => {
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }));

    expect(result.current.transportError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.transportError?.message).toContain('no TransportProvider found');
  });

  it('includes the channelName in the error message', () => {
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:primary' }));

    expect(result.current.transportError).toMatchObject({ code: ErrorCode.BadRequest });
    expect(result.current.transportError?.message).toContain('"ai:primary"');
  });

  it('sets transportError with BadRequest when no channelName and no nearest provider', () => {
    const { result } = renderHook(() => useClientTransport());

    expect(result.current.transportError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.transportError?.message).toContain('no TransportProvider found');
  });

  it('returns a stub transport (not throw) when no provider found', () => {
    // The hook must not throw during render — check that tree access throws on the stub instead
    const { result } = renderHook(() => useClientTransport());
    expect(result.current.transportError).toBeDefined();
    expect(() => result.current.transport.tree).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument }));
  });

  describe('skip', () => {
    it('returns a stub without setting transportError when skip is true', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(result.current.transport).toBeDefined();
      expect(result.current.transportError).toBeUndefined();
    });

    it('stub tree getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.transport.tree).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub view getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.transport.view).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub createView throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.transport.createView()).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub cancel throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => {
        void result.current.transport.cancel();
      }).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }));
    });

    it('stub on throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      // CAST: cast to any overload to call without args in test
      expect(() => (result.current.transport.on as (...args: unknown[]) => unknown)('error', vi.fn())).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub error messages are descriptive', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.transport.tree).toThrow(
        expect.objectContaining({ message: 'unable to access tree; hook is skipped' }),
      );
    });
  });

  describe('onError', () => {
    it('calls onError when the transport emits an error event', () => {
      const mock = createMockTransport();
      const onError = vi.fn();
      renderHook(() => useClientTransport({ onError }), {
        wrapper: withNearestTransport(mock.transport),
      });

      const error = new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400);
      act(() => {
        mock.emit('error', error);
      });

      expect(onError).toHaveBeenCalledWith(error);
    });

    it('does not call onError after unmount', () => {
      const mock = createMockTransport();
      const onError = vi.fn();
      const { unmount } = renderHook(() => useClientTransport({ onError }), {
        wrapper: withNearestTransport(mock.transport),
      });

      unmount();

      act(() => {
        mock.emit('error', new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400));
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not subscribe when skip is true', () => {
      const mock = createMockTransport();
      const onError = vi.fn();
      renderHook(() => useClientTransport({ skip: true, onError }), {
        wrapper: withNearestTransport(mock.transport),
      });

      act(() => {
        mock.emit('error', new Ably.ErrorInfo('test error', ErrorCode.BadRequest, 400));
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not call onError when no provider found', () => {
      const onError = vi.fn();
      renderHook(() => useClientTransport({ onError }));

      // No transport to emit on — onError should never fire
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
