// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { ErrorCode } from '../../src/errors.js';
import { TransportContext } from '../../src/react/contexts/transport-context.js';
import { useClientTransport } from '../../src/react/use-client-transport.js';
import { createMockTransport } from './helper/mock-transport.js';

// Wrap renderHook with a TransportContext providing the given channelName-to-transport record.
const withTransportContext =
  (record: Record<string, ClientTransport<unknown, unknown>>) =>
  ({ children }: { children: ReactNode }) =>
    createElement(TransportContext.Provider, { value: record }, children);

describe('useClientTransport', () => {
  it('returns the transport registered under the given channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport('ai:test'), {
      wrapper: withTransportContext({ 'ai:test': transport }),
    });
    expect(result.current).toBe(transport);
  });

  it('returns the transport registered under a different channelName', () => {
    const { transport } = createMockTransport();
    const { result } = renderHook(() => useClientTransport('ai:secondary'), {
      wrapper: withTransportContext({ 'ai:secondary': transport }),
    });
    expect(result.current).toBe(transport);
  });

  it('throws Ably.ErrorInfo with BadRequest when no TransportProvider is present', () => {
    const { result } = renderHook(() => {
      try {
        useClientTransport('ai:test');
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
        useClientTransport('ai:primary');
        // Return value is irrelevant — the throw above is what matters
      } catch (error) {
        return error;
      }
    });

    expect(result.current).toMatchObject({ code: ErrorCode.BadRequest });
    expect((result.current as { message: string }).message).toContain('"ai:primary"');
  });
});
