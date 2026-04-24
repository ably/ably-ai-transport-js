// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { TransportContext } from '../../../src/react/contexts/transport-context.js';
import { useResolvedTransport } from '../../../src/react/internal/use-resolved-transport.js';
import { createMockTransport } from '../helper/mock-transport.js';

describe('useResolvedTransport', () => {
  it('returns the explicit transport when provided', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useResolvedTransport({ transport: mock.transport }));
    expect(result.current).toBe(mock.transport);
  });

  it('falls back to the nearest context transport when transport is omitted', () => {
    const mock = createMockTransport();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportContext.Provider,
        {
          value: {
            nearest: { transport: mock.transport as ClientTransport<unknown, unknown> },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useResolvedTransport(), { wrapper });
    expect(result.current).toBe(mock.transport);
  });

  it('returns undefined when skip is true even if context transport is present', () => {
    const mock = createMockTransport();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportContext.Provider,
        {
          value: {
            nearest: { transport: mock.transport as ClientTransport<unknown, unknown> },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useResolvedTransport({ skip: true }), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it('returns undefined when skip is true even if explicit transport is provided', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useResolvedTransport({ transport: mock.transport, skip: true }));
    expect(result.current).toBeUndefined();
  });

  it('returns undefined when no transport argument and no context', () => {
    const { result } = renderHook(() => useResolvedTransport());
    expect(result.current).toBeUndefined();
  });

  it('prefers explicit transport over context transport', () => {
    const contextMock = createMockTransport();
    const explicitMock = createMockTransport();
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(
        TransportContext.Provider,
        {
          value: {
            nearest: { transport: contextMock.transport as ClientTransport<unknown, unknown> },
            providers: {},
          },
        },
        children,
      );

    const { result } = renderHook(() => useResolvedTransport({ transport: explicitMock.transport }), { wrapper });
    expect(result.current).toBe(explicitMock.transport);
  });
});
