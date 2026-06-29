/**
 * useMessagesWithSeed — reconcile a persisted conversation seed with the live channel.
 *
 * An application that stores completed conversation turns in its own database
 * (keyed by the domain message id) seeds this hook with that history and a
 * {@link View} over the live channel. The hook takes the newest seed message's
 * id as the **seam** — the only id shared between the store and the channel,
 * since the transport's internal `codecMessageId` is never persisted — pages the
 * view back until that id reappears, and composes `seed ⧺ live` with the single
 * seam overlap dropped.
 *
 * The backward walk is re-entrant and update-driven: an empty page (e.g. racing
 * the initial attach, React StrictMode's double-invoke, or a concurrent load)
 * defers rather than giving up, and the next view `update` re-drives it. So a
 * conversation reloaded mid-stream still pages back to the seam once the live
 * arrival or hydration progresses.
 *
 * This assumes a **linear history**: each turn is persisted whole before the
 * next is sent (and a concurrent send cancels the active run), so the stored
 * prefix and the channel's live tail meet at the seam with a single overlap.
 */

import { useEffect, useRef, useState } from 'react';

import type { View } from '../core/transport/types.js';

/**
 * Compose `seed ⧺ live`: the persisted prefix followed by the live tail. The
 * seed already covers everything up to and including the seam, so drop the
 * visible window up to and including the seam wherever it sits — leaving only
 * messages newer than the seam. With no view the seed stands alone; with an
 * empty seed the live window is surfaced unchanged.
 * @param view - The live-channel view, or `undefined` before it resolves.
 * @param seed - The persisted prefix, oldest-first.
 * @param getId - Returns a message's stable domain id (the seam key).
 * @returns The composed conversation, oldest-first.
 */
const composeSeeded = <TMessage>(
  view: View<TMessage> | undefined,
  seed: TMessage[],
  getId: (message: TMessage) => string,
): TMessage[] => {
  if (!view) return seed;
  const newestSeed = seed.at(-1);
  const seamId = newestSeed === undefined ? undefined : getId(newestSeed);
  const visible = view.getMessages();
  const seamIndex = seamId === undefined ? -1 : visible.findIndex((m) => getId(m.message) === seamId);
  const live = seamIndex >= 0 ? visible.slice(seamIndex + 1) : visible;
  return [...seed, ...live.map((m) => m.message)];
};

/**
 * Identity-equal, same-length comparison of two message lists.
 * @param a - First message list.
 * @param b - Second message list.
 * @returns `true` when both lists hold the same references in the same order.
 */
const sameMessages = <TMessage>(a: TMessage[], b: TMessage[]): boolean =>
  a.length === b.length && a.every((m, i) => m === b[i]);

/** Options for {@link useMessagesWithSeed}. */
export interface UseMessagesWithSeedOptions<TMessage> {
  /**
   * The {@link View} over the live channel to reconcile against, or `undefined`
   * before the session/view resolves (the hook then surfaces the seed as-is).
   */
  view: View<TMessage> | undefined;
  /**
   * The persisted conversation (the seed), oldest-first. A **dependency** of the
   * reconciliation: a new `seed` reference re-runs the seam walk and recomposes
   * from scratch. Pass a **stable (e.g. memoised) reference** for a given
   * conversation so ordinary re-renders don't repeat the walk; change it to seed
   * a different conversation. An empty array surfaces the live channel window
   * unchanged (no seam, no walk).
   */
  seed: TMessage[];
  /**
   * Return the stable domain id of a message — the seam key shared between the
   * application's store and the channel. Called to identify the seam and to
   * drop the single overlap when composing.
   */
  getMessageId: (message: TMessage) => string;
}

/**
 * Reconcile a persisted seed with the live channel and return the composed
 * conversation (`seed` followed by the not-yet-seeded live tail).
 * @param options - The view, the seed, and the message-id accessor.
 * @param options.view - The {@link View} over the live channel, or `undefined` before it resolves.
 * @param options.seed - The persisted conversation (the seed), oldest-first.
 * @param options.getMessageId - Returns a message's stable domain id (the seam key).
 * @returns The composed conversation, oldest-first.
 */
export const useMessagesWithSeed = <TMessage>({
  view,
  seed,
  getMessageId,
}: UseMessagesWithSeedOptions<TMessage>): TMessage[] => {
  // The effect re-runs whenever `view` or `seed` changes — a new seed re-drives
  // the walk from scratch (see the `seed` option doc). `getMessageId` is held in
  // a ref instead: it's a pure accessor, so an unstable (e.g. inline) reference
  // shouldn't re-run the walk; the latest is read inside the effect.
  const getIdRef = useRef(getMessageId);
  getIdRef.current = getMessageId;

  // Compose synchronously on first render so the seed (and any already-visible
  // live tail) is surfaced immediately — no transient empty frame for a consumer
  // that replaces its messages with this value.
  const [composed, setComposed] = useState<TMessage[]>(() => composeSeeded(view, seed, getMessageId));

  useEffect(() => {
    const getId = getIdRef.current;
    const newestSeed = seed.at(-1);
    const seamId = newestSeed === undefined ? undefined : getId(newestSeed);

    if (!view) {
      setComposed(seed);
      return;
    }

    // Recompose, but keep the previous array when the messages are unchanged so
    // an `update` that doesn't alter the window (or a redundant remount compose)
    // doesn't churn a new reference through every downstream consumer.
    const compose = (): void => {
      const next = composeSeeded(view, seed, getId);
      setComposed((prev) => (sameMessages(prev, next) ? prev : next));
    };

    // `signal.aborted` (vs. a plain boolean) survives the `await` below without
    // TypeScript narrowing it away — the cleanup aborts and an in-flight
    // `loadOlder` then settles into a no-op.
    const controller = new AbortController();
    const { signal } = controller;
    let walking = false;

    // The seam is reached once it's in the window — or there's nothing to seed,
    // or no more history to page. Until then, keep paging.
    const seamReached = (): boolean =>
      seamId === undefined || !view.hasOlder() || view.getMessages().some((m) => getId(m.message) === seamId);

    // Page back toward the seam. Re-entrant and update-driven: an empty page
    // defers instead of giving up, and the next view `update` re-drives the
    // walk. The `walking` guard collapses concurrent invocations — including the
    // reveal-emitted updates — so it never spins.
    const driveWalk = async (): Promise<void> => {
      if (walking || seamReached()) return;
      walking = true;
      try {
        // `signal.aborted` is re-read each iteration: after the cleanup aborts,
        // the in-flight `loadOlder` settles and the loop then exits.
        //
        // Reveal one message at a time (`loadOlder(1)`), not because each call
        // hits the channel — the network fetch is batched by the session's
        // `historyPageSize` and served from the buffer — but so the walk stops
        // exactly at the seam and never reveals past it, keeping the `seed ⧺ live`
        // overlap a single message.
        while (!signal.aborted && !seamReached()) {
          const revealed = await view.loadOlder(1);
          if (revealed.length === 0) break; // defer to the next update
        }
      } finally {
        walking = false;
      }
    };

    compose();
    const off = view.on('update', () => {
      compose();
      void driveWalk();
    });
    void driveWalk();

    return () => {
      controller.abort();
      off();
    };
  }, [view, seed]);

  return composed;
};
