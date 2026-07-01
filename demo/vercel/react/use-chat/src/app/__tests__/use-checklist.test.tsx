import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';
import { FakeRoot } from './fake-root';
import { useChecklist, type ObjectSession } from '../hooks/use-checklist';

afterEach(() => {
  // vitest isn't configured with globals, so @testing-library/react's
  // auto-cleanup hook isn't registered — unmount explicitly so the hook's
  // effect cleanup runs after each test. Otherwise a mounted hook leaks past
  // the test file and React flushes scheduled work after jsdom tears down
  // the window, surfacing as an uncaught "window is not defined".
  cleanup();
});

function sessionFor(fake: FakeRoot): ObjectSession {
  return {
    // CAST: structural fake of the RealtimeObject surface the hook uses.
    object: { get: async () => fake } as unknown as ObjectSession['object'],
  };
}

describe('useChecklist', () => {
  it('resolves the root and exposes a validated snapshot in checklist order', async () => {
    const fake = new FakeRoot({
      '2': { text: 'Second', status: 'pending', updatedAt: 20 },
      '1': { text: 'First', status: 'active', updatedAt: 10 },
    });
    const { result } = renderHook(() => useChecklist(sessionFor(fake)));

    await waitFor(() => expect(result.current.steps.length).toBe(2));
    expect(result.current.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(result.current.error).toBeUndefined();
  });

  it('re-snapshots on object subscription events', async () => {
    const fake = new FakeRoot({});
    const { result } = renderHook(() => useChecklist(sessionFor(fake)));

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
    const session: ObjectSession = {
      // CAST: structural fake of the RealtimeObject surface the hook uses.
      object: { get: async () => Promise.reject(new Error('missing plugin')) } as unknown as ObjectSession['object'],
    };
    const { result } = renderHook(() => useChecklist(session));

    await waitFor(() => expect(result.current.error?.message).toBe('missing plugin'));
    expect(result.current.steps).toEqual([]);
  });

  it('unsubscribes on unmount', async () => {
    const fake = new FakeRoot({});
    const { result, unmount } = renderHook(() => useChecklist(sessionFor(fake)));

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
