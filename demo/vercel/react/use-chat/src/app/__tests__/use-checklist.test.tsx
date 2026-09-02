import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';
import type { RealtimeObject } from 'ably/liveobjects';
import { FakeRoot } from './fake-root';
import { useChecklist } from '../hooks/use-checklist';

afterEach(() => {
  // vitest isn't configured with globals, so @testing-library/react's
  // auto-cleanup hook isn't registered — unmount explicitly so the hook's
  // effect cleanup runs after each test. Otherwise a mounted hook leaks past
  // the test file and React flushes scheduled work after jsdom tears down
  // the window, surfacing as an uncaught "window is not defined".
  cleanup();
});

function objectFor(fake: FakeRoot): RealtimeObject {
  // CAST: structural fake of the RealtimeObject surface the hook uses.
  return { get: async () => fake } as unknown as RealtimeObject;
}

describe('useChecklist', () => {
  it('resolves the root and exposes a validated snapshot in checklist order', async () => {
    const fake = new FakeRoot({
      '2': { text: 'Second', status: 'pending', updatedAt: 20 },
      '1': { text: 'First', status: 'active', updatedAt: 10 },
    });
    const { result } = renderHook(() => useChecklist(objectFor(fake)));

    await waitFor(() => expect(result.current.steps.length).toBe(2));
    expect(result.current.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(result.current.error).toBeUndefined();
  });

  it('re-snapshots on object subscription events', async () => {
    const fake = new FakeRoot({});
    const { result } = renderHook(() => useChecklist(objectFor(fake)));

    await waitFor(() => expect(result.current.steps).toEqual([]));

    act(() => {
      fake.state['1'] = { text: 'Do the thing', status: 'active', updatedAt: 5 };
      fake.notify();
    });

    await waitFor(() =>
      expect(result.current.steps).toEqual([{ index: 1, text: 'Do the thing', status: 'active', updatedAt: 5 }]),
    );
  });

  it('surfaces an error when the root cannot be resolved', async () => {
    // CAST: structural fake of the RealtimeObject surface the hook uses.
    const object = {
      get: async () => Promise.reject(new Error('missing plugin')),
    } as unknown as RealtimeObject;
    const { result } = renderHook(() => useChecklist(object));

    await waitFor(() => expect(result.current.error?.message).toBe('missing plugin'));
    expect(result.current.steps).toEqual([]);
  });

  it('unsubscribes on unmount', async () => {
    const fake = new FakeRoot({});
    const { result, unmount } = renderHook(() => useChecklist(objectFor(fake)));

    await waitFor(() => expect(result.current.steps).toEqual([]));
    unmount();

    // After unmount the listener is gone, so a later change is ignored without throwing.
    act(() => {
      fake.state['1'] = { text: 'late', status: 'pending', updatedAt: 1 };
      fake.notify();
    });
    expect(result.current.steps).toEqual([]);
  });
});
