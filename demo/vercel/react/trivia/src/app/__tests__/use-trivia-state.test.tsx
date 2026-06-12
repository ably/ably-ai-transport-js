import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { FakeRoot, type FakeState } from './fake-root';

vi.mock('ably/liveobjects', () => ({
  LiveMap: { create: (entries: Record<string, unknown> = {}) => ({ __kind: 'map-create', entries }) },
  LiveCounter: { create: (count = 0) => ({ __kind: 'counter-create', count }) },
}));

import { useTriviaState, type ObjectSession } from '../hooks/use-trivia-state';

function setup(initial: FakeState = {}) {
  const fake = new FakeRoot(initial);
  const session: ObjectSession = {
    // CAST: structural fake of the RealtimeObject surface the hook uses.
    object: { get: async () => fake } as unknown as ObjectSession['object'],
  };
  return { fake, session };
}

describe('useTriviaState', () => {
  it('resolves the root and exposes a validated snapshot', async () => {
    const { session } = setup({
      game: { phase: 'question', questionNumber: 1, totalQuestions: 3, question: 'Q?' },
      players: { a: { name: 'Alice', joinedAt: 1 } },
      scores: { a: 10 },
    });
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot.game?.phase).toBe('question'));
    expect(result.current.joined).toBe(true);
    expect(result.current.snapshot.scores).toEqual({ a: 10 });
  });

  it('updates the snapshot on object subscription events', async () => {
    const { fake, session } = setup({ players: {}, scores: {} });
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot.players).toEqual({}));

    act(() => {
      fake.state.players = { b: { name: 'Bob', joinedAt: 2 } };
      fake.notify();
    });

    await waitFor(() => expect(result.current.snapshot.players.b?.name).toBe('Bob'));
    expect(result.current.joined).toBe(false);
  });

  it('join creates the root structure, the roster entry, and a zeroed counter', async () => {
    const { fake, session } = setup({});
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await act(async () => {
      await result.current.join('Alice');
    });

    expect(fake.state.game).toMatchObject({ phase: 'lobby', questionNumber: 0, totalQuestions: 0 });
    expect(fake.state.players?.a).toMatchObject({ name: 'Alice' });
    expect(fake.state.scores).toEqual({ a: 0 });
    await waitFor(() => expect(result.current.joined).toBe(true));
  });

  it('join never resets an existing counter', async () => {
    const { fake, session } = setup({
      game: { phase: 'question', questionNumber: 1, totalQuestions: 3 },
      players: {},
      scores: { a: 20 },
    });
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot.scores).toEqual({ a: 20 }));
    await act(async () => {
      await result.current.join('Alice');
    });

    expect(fake.state.scores).toEqual({ a: 20 });
  });

  it('self-heals a dropped roster entry, re-creating the counter only in the lobby', async () => {
    const { fake, session } = setup({});
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await act(async () => {
      await result.current.join('Alice');
    });
    await waitFor(() => expect(result.current.joined).toBe(true));

    // Simulate a lost first-joiner race in the lobby: our entry and counter vanish.
    act(() => {
      fake.state.players = {};
      fake.state.scores = {};
      fake.notify();
    });

    await waitFor(() => expect(fake.state.players?.a).toMatchObject({ name: 'Alice' }));
    expect(fake.state.scores).toEqual({ a: 0 });
  });

  it('does not re-create the counter when healing mid-game', async () => {
    const { fake, session } = setup({});
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await act(async () => {
      await result.current.join('Alice');
    });
    await waitFor(() => expect(result.current.joined).toBe(true));

    // The game moves on, then our entry is dropped mid-game.
    act(() => {
      fake.state.game = { phase: 'question', questionNumber: 1, totalQuestions: 3 };
      fake.state.players = {};
      fake.state.scores = {};
      fake.notify();
    });

    await waitFor(() => expect(fake.state.players?.a).toMatchObject({ name: 'Alice' }));
    // No counter re-create outside the lobby — awardPoints heals it instead.
    expect(fake.state.scores).toEqual({});
  });

  it('does not self-heal for a player whose join never succeeded', async () => {
    const { fake, session } = setup({});
    // Sabotage the first structure write so join fails before completing.
    fake.set = async () => {
      throw new Error('boom');
    };
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.snapshot).toBeDefined());
    await expect(
      act(async () => {
        await result.current.join('Alice');
      }),
    ).rejects.toThrow('boom');

    // An unrelated object update must not re-assert the failed join.
    act(() => {
      fake.state.players = { b: { name: 'Bob', joinedAt: 2 } };
      fake.notify();
    });
    await waitFor(() => expect(result.current.snapshot.players.b).toBeDefined());
    expect(fake.state.players?.a).toBeUndefined();
  });

  it('surfaces an error when the root cannot be resolved', async () => {
    const session: ObjectSession = {
      // CAST: structural fake of the RealtimeObject surface the hook uses.
      object: { get: async () => Promise.reject(new Error('missing plugin')) } as unknown as ObjectSession['object'],
    };
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await waitFor(() => expect(result.current.error?.message).toBe('missing plugin'));
  });

  it('join rejects before the root has resolved', async () => {
    let resolveRoot: ((root: FakeRoot) => void) | undefined;
    const pending = new Promise<FakeRoot>((resolve) => {
      resolveRoot = resolve;
    });
    const session: ObjectSession = {
      // CAST: structural fake of the RealtimeObject surface the hook uses.
      object: { get: () => pending } as unknown as ObjectSession['object'],
    };
    const { result } = renderHook(() => useTriviaState(session, 'a'));

    await expect(result.current.join('Alice')).rejects.toThrow(/not ready/);
    resolveRoot?.(new FakeRoot({}));
  });
});
