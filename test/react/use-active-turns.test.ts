// @vitest-environment jsdom

import { act,renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useActiveTurns } from '../../src/react/use-active-turns.js';
import { createMockTransport, makeTurnEvent } from './helper/mock-transport.js';

describe('useActiveTurns', () => {
  it('returns empty map when transport is undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing undefined transport
    const { result } = renderHook(() => useActiveTurns(undefined));
    expect(result.current.size).toBe(0);
  });

  it('initializes from transport state', () => {
    const mock = createMockTransport();
    const initialTurns = new Map([['client-1', new Set(['turn-1'])]]);
    mock.getActiveTurnIds.mockReturnValue(initialTurns);

    const { result } = renderHook(() => useActiveTurns(mock.transport));
    expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
  });

  it('adds a turn on turn-start event', () => {
    const mock = createMockTransport();
    const { result } = renderHook(() => useActiveTurns(mock.transport));

    act(() => {
      mock.emit('turn', makeTurnEvent('x-ably-turn-start', 'turn-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.has('turn-1')).toBe(true);
  });

  it('removes a turn on turn-end event', () => {
    const mock = createMockTransport();
    mock.getActiveTurnIds.mockReturnValue(new Map([['client-1', new Set(['turn-1'])]]));

    const { result } = renderHook(() => useActiveTurns(mock.transport));

    act(() => {
      mock.emit('turn', makeTurnEvent('x-ably-turn-end', 'turn-1', 'client-1', 'complete'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });

  it('removes clientId entry when last turn ends', () => {
    const mock = createMockTransport();
    mock.getActiveTurnIds.mockReturnValue(
      new Map([['client-1', new Set(['turn-1', 'turn-2'])]]),
    );

    const { result } = renderHook(() => useActiveTurns(mock.transport));

    act(() => {
      mock.emit('turn', makeTurnEvent('x-ably-turn-end', 'turn-1', 'client-1'));
    });

    expect(result.current.get('client-1')?.size).toBe(1);
    expect(result.current.get('client-1')?.has('turn-2')).toBe(true);

    act(() => {
      mock.emit('turn', makeTurnEvent('x-ably-turn-end', 'turn-2', 'client-1'));
    });

    expect(result.current.has('client-1')).toBe(false);
  });
});
