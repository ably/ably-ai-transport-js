'use client';

/**
 * React hook over the channel's LiveObjects game state.
 *
 * There are no first-party LiveObjects React hooks, so this is the demo's
 * reference implementation of the documented imperative pattern: resolve the
 * root once, subscribe (nested changes included by default), and re-snapshot
 * on every update via `compactJson()`.
 *
 * It also owns the client-side write path:
 *
 * - `join(name)` creates the three root maps if this is the first joiner, then
 *   writes this client's roster entry and (only if missing) its score counter.
 * - Self-heal: root `set`s are last-write-wins, so a lost first-joiner race can
 *   drop this client's entry — the subscription re-asserts it through the same
 *   ensure-then-write path as join, and only after a join has fully succeeded
 *   (an in-flight guard keeps the two from interleaving). The score counter is
 *   only re-created while the game is explicitly in the lobby; once the quiz
 *   runs, a missing counter is healed by the agent's `awardPoints` instead, so
 *   a LWW `set` can never wipe accrued points.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveCounter, LiveMap } from 'ably/liveobjects';
import type { LiveMapPathObject, RealtimeObject } from 'ably/liveobjects';
import {
  EMPTY_SNAPSHOT,
  snapshotFrom,
  type GameMeta,
  type PlayerEntry,
  type TriviaRoot,
  type TriviaSnapshot,
} from '../lib/trivia';

/** The slice of a session this hook needs — both session types satisfy it. */
export interface ObjectSession {
  object: RealtimeObject;
}

export interface TriviaStateHandle {
  /** Latest validated snapshot of the game state. */
  snapshot: TriviaSnapshot;
  /** Whether this client has a roster entry (survives reloads — it's object state). */
  joined: boolean;
  /** Join the game: ensures the root structure exists and registers this player. */
  join: (name: string) => Promise<void>;
  /** Set when resolving the root object failed (e.g. plugin or modes missing). */
  error: Error | undefined;
}

type Root = LiveMapPathObject<TriviaRoot>;

const ensureStructure = async (root: Root): Promise<void> => {
  if (root.get('game').instance() === undefined) {
    const initial: GameMeta = { phase: 'lobby', questionNumber: 0, totalQuestions: 0 };
    await root.set('game', LiveMap.create(initial));
  }
  if (root.get('players').instance() === undefined) {
    await root.set('players', LiveMap.create<Record<string, PlayerEntry>>({}));
  }
  if (root.get('scores').instance() === undefined) {
    await root.set('scores', LiveMap.create<Record<string, LiveCounter>>({}));
  }
};

const writePlayer = async (root: Root, clientId: string, name: string, createCounter: boolean): Promise<void> => {
  await root.get('players').set(clientId, { name, joinedAt: Date.now() });
  if (createCounter && root.get('scores').get(clientId).value() === undefined) {
    await root.get('scores').set(clientId, LiveCounter.create(0));
  }
};

export function useTriviaState(session: ObjectSession, clientId: string): TriviaStateHandle {
  const [snapshot, setSnapshot] = useState<TriviaSnapshot>(EMPTY_SNAPSHOT);
  const [error, setError] = useState<Error | undefined>(undefined);
  const rootRef = useRef<Root | undefined>(undefined);
  // The name this client joined with — set only after a join's writes have
  // succeeded, so the self-heal effect never races an in-flight join.
  const joinedNameRef = useRef<string | undefined>(undefined);
  // Serializes join/heal write sequences: the heal effect skips while a write
  // is in flight (snapshot updates from our own writes re-run it anyway).
  const writeInFlightRef = useRef(false);

  const register = useCallback(
    async (root: Root, name: string, createCounter: boolean) => {
      if (writeInFlightRef.current) return;
      writeInFlightRef.current = true;
      try {
        await ensureStructure(root);
        await writePlayer(root, clientId, name, createCounter);
      } finally {
        writeInFlightRef.current = false;
      }
    },
    [clientId],
  );

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;

    const start = async () => {
      const root = await session.object.get<TriviaRoot>();
      if (cancelled) return;
      rootRef.current = root;
      setSnapshot(snapshotFrom(root.compactJson()));
      subscription = root.subscribe(() => {
        setSnapshot(snapshotFrom(root.compactJson()));
      });
    };

    start().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      cancelled = true;
      rootRef.current = undefined;
      subscription?.unsubscribe();
    };
  }, [session]);

  const joined = clientId in snapshot.players;

  // Self-heal: if a lost first-joiner race dropped our roster entry, re-assert
  // it. The counter is only re-created when the game is explicitly in the
  // lobby (see module comment) — an undefined game (absent or malformed) does
  // not qualify, so a heal can never `set` a counter mid-game.
  useEffect(() => {
    const root = rootRef.current;
    const name = joinedNameRef.current;
    if (!root || name === undefined || joined) return;
    const inLobby = snapshot.game?.phase === 'lobby';
    register(root, name, inLobby).catch((err: unknown) => {
      // Best-effort: the next root update retries; surface for diagnosis only.
      console.error('trivia: failed to re-assert player entry', err);
    });
  }, [snapshot, joined, register]);

  const join = useCallback(
    async (name: string) => {
      const root = rootRef.current;
      if (!root) {
        throw new Error('unable to join; game state is not ready yet');
      }
      await register(root, name, true);
      joinedNameRef.current = name;
    },
    [register],
  );

  return { snapshot, joined, join, error };
}
