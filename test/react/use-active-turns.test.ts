// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport } from '../../src/core/transport/types.js';
import { TransportContext } from '../../src/react/contexts/transport-context.js';
import { useActiveTurns } from '../../src/react/use-active-turns.js';
import { createMockTransport, makeTurnEvent } from './helper/mock-transport.js';

describe('useActiveTurns', () => {
  it('returns empty map when no transport and no nearest context', () => {
    const { result } = renderHook(() => useActiveTurns());
    expect(result.current.size).toBe(0);
  });

  it('initializes from tree state', () => {
    const mock = createMockTransport();
    const initialTurns = new Map([['client-1', new Set(['turn-1'])]]);
    (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(initialTurns);

    const { result } = renderHook(() => useActiveTurns({ transport: mock.transport }));
    expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
  });

  it('adds a turn on turn-start event', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useActiveTurns({ transport: mock.transport }));

    act(() => {
      mock.emitTree('turn', makeTurnEvent('x-ably-turn-start', 'turn-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
  });

  it('removes a turn on turn-end event', () => {
    const mock = createMockTransport();
    (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['turn-1'])]]),
    );

    const { result } = renderHook(() => useActiveTurns({ transport: mock.transport }));

    act(() => {
      mock.emitTree('turn', makeTurnEvent('x-ably-turn-end', 'turn-1', 'client-1', 'complete'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });

  it('removes clientId entry when last turn ends', () => {
    const mock = createMockTransport();
    (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['turn-1', 'turn-2'])]]),
    );

    const { result } = renderHook(() => useActiveTurns({ transport: mock.transport }));

    act(() => {
      mock.emitTree('turn', makeTurnEvent('x-ably-turn-end', 'turn-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.size).toBe(1);
    expect(result.current.get('client-1')?.has('turn-2')).toBe(true);

    act(() => {
      mock.emitTree('turn', makeTurnEvent('x-ably-turn-end', 'turn-2', 'client-1'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });

  it('does not mutate previous state Set on turn-end', () => {
    const mock = createMockTransport();
    (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['client-1', new Set(['turn-1', 'turn-2'])]]),
    );

    const { result } = renderHook(() => useActiveTurns({ transport: mock.transport }));

    // Capture reference to the Set before mutation
    const setBefore = result.current.get('client-1');
    expect(setBefore).toBeDefined();
    expect(setBefore?.size).toBe(2);

    act(() => {
      mock.emitTree('turn', makeTurnEvent('x-ably-turn-end', 'turn-1', 'client-1'));
    });

    // The old Set reference must still contain both original items
    expect(setBefore?.has('turn-1')).toBe(true);
    expect(setBefore?.has('turn-2')).toBe(true);
    expect(setBefore?.size).toBe(2);
  });

  describe('skip', () => {
    it('returns empty Map when skip is true', () => {
      const mock = createMockTransport();
      const { result } = renderHook(() => useActiveTurns({ transport: mock.transport, skip: true }));
      expect(result.current.size).toBe(0);
    });

    it('does not call tree.getActiveTurnIds when skip is true', () => {
      const mock = createMockTransport();
      renderHook(() => useActiveTurns({ transport: mock.transport, skip: true }));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock, no `this` binding needed
      expect(mock.tree.getActiveTurnIds).not.toHaveBeenCalled();
    });

    it('does not react to tree turn events when skip is true', () => {
      const mock = createMockTransport();
      const { result } = renderHook(() => useActiveTurns({ transport: mock.transport, skip: true }));

      act(() => {
        mock.emitTree('turn', makeTurnEvent('x-ably-turn-start', 'turn-1', 'client-1'));
      });

      expect(result.current.size).toBe(0);
    });

    it('resets turns to empty Map when skip flips from false to true', () => {
      const mock = createMockTransport();
      (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(
        new Map([['client-1', new Set(['turn-1'])]]),
      );

      const { result, rerender } = renderHook(
        ({ skip }: { skip: boolean }) => useActiveTurns({ transport: mock.transport, skip }),
        { initialProps: { skip: false } },
      );

      expect(result.current.get('client-1')?.has('turn-1')).toBe(true);

      act(() => {
        rerender({ skip: true });
      });

      expect(result.current.size).toBe(0);
    });

    it('subscribes and returns turns when skip flips from true to false', () => {
      const mock = createMockTransport();
      (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(
        new Map([['client-1', new Set(['turn-1'])]]),
      );

      const { result, rerender } = renderHook(
        ({ skip }: { skip: boolean }) => useActiveTurns({ transport: mock.transport, skip }),
        { initialProps: { skip: true } },
      );

      expect(result.current.size).toBe(0);

      act(() => {
        rerender({ skip: false });
      });

      expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
    });

    it('stops reacting to tree turn events after skip flips to true', () => {
      const mock = createMockTransport();
      const { result, rerender } = renderHook(
        ({ skip }: { skip: boolean }) => useActiveTurns({ transport: mock.transport, skip }),
        { initialProps: { skip: false } },
      );

      act(() => {
        rerender({ skip: true });
      });

      act(() => {
        mock.emitTree('turn', makeTurnEvent('x-ably-turn-start', 'turn-1', 'client-1'));
      });

      expect(result.current.size).toBe(0);
    });
  });

  it('uses nearest transport from context when transport is omitted', () => {
    const mock = createMockTransport();
    const initialTurns = new Map([['client-1', new Set(['turn-1'])]]);
    (mock.tree.getActiveTurnIds as ReturnType<typeof vi.fn>).mockReturnValue(initialTurns);

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

    const { result } = renderHook(() => useActiveTurns(), { wrapper });

    expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
  });
});
