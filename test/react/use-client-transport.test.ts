// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
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
    createElement(TransportContext.Provider, { value: record }, children);

// Wrap renderHook with a NearestTransportContext providing the given transport.
const withNearestTransport =
  (transport: ClientTransport<unknown, unknown>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(NearestTransportContext.Provider, { value: transport }, children);

describe('useClientTransport', () => {
  it('returns the transport registered under the given channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:test' }), {
      wrapper: withTransportContext({ 'ai:test': transport }),
    });
    expect(result.current).toBe(transport);
  });

  it('returns the transport registered under a different channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport({ channelName: 'ai:secondary' }), {
      wrapper: withTransportContext({ 'ai:secondary': transport }),
    });
    expect(result.current).toBe(transport);
  });

  it('returns the nearest transport when no channelName is given', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport(), {
      wrapper: withNearestTransport(transport),
    });
    expect(result.current).toBe(transport);
  });

  it('throws Ably.ErrorInfo with BadRequest when channelName given but no matching TransportProvider', () => {
    const { result } = renderHook(() => {
      try {
        useClientTransport({ channelName: 'ai:test' });
        // Return value is irrelevant — the throw above is what matters
      } catch (error) {
        return error;
      }
    });

    expect(result.current).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect((result.current as { message: string }).message).toContain('no TransportProvider found');
  });

  it('includes the channelName in the error message', () => {
    const { result } = renderHook(() => {
      try {
        useClientTransport({ channelName: 'ai:primary' });
        // Return value is irrelevant — the throw above is what matters
      } catch (error) {
        return error;
      }
    });

    expect(result.current).toMatchObject({ code: ErrorCode.BadRequest });
    expect((result.current as { message: string }).message).toContain('"ai:primary"');
  });

  it('throws Ably.ErrorInfo with BadRequest when no channelName and no nearest provider', () => {
    const { result } = renderHook(() => {
      try {
        useClientTransport();
        // Return value is irrelevant — the throw above is what matters
      } catch (error) {
        return error;
      }
    });

    expect(result.current).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect((result.current as { message: string }).message).toContain('no TransportProvider found');
  });

  describe('skip', () => {
    it('returns a stub without throwing when skip is true', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(result.current).toBeDefined();
    });

    it('stub tree getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.tree).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub view getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.view).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub createView throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.createView()).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub cancel throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => {
        void result.current.cancel();
      }).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }));
    });

    it('stub on throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      // CAST: cast to any overload to call without args in test
      expect(() => (result.current.on as (...args: unknown[]) => unknown)('error', vi.fn())).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub error messages are descriptive', () => {
      const { result } = renderHook(() => useClientTransport({ skip: true }));
      expect(() => result.current.tree).toThrow(
        expect.objectContaining({ message: 'unable to access tree; hook is skipped' }),
      );
    });
  });
});
