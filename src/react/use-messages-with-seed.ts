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

import { useEffect, useMemo, useRef, useState } from 'react';

import type { CodecMessage } from '../core/codec/types.js';
import type { View } from '../core/transport/types.js';

/**
 * The live tail to append after the seed: the visible window with everything up
 * to and including the seam dropped, leaving only messages newer than the seam.
 * The seed already covers everything up to and including the seam, so with the
 * seam visible we slice past it; with no seam in the window (or no seed) the
 * whole live window stands as the tail. With no view there is nothing live yet.
 * @param view - The live-channel view, or `undefined` before it resolves.
 * @param seed - The persisted prefix, oldest-first.
 * @param getId - Returns a message's stable domain id (the seam key).
 * @returns The live tail to append after the seed, oldest-first.
 */
const liveTail = <TMessage>(
  view: View<TMessage> | undefined,
  seed: TMessage[],
  getId: (message: TMessage) => string,
): CodecMessage<TMessage>[] => {
  if (!view) return [];
  const newestSeed = seed.at(-1);
  const seamId = newestSeed === undefined ? undefined : getId(newestSeed);
  const visible = view.getMessages();
  const seamIndex = seamId === undefined ? -1 : visible.findIndex((m) => getId(m.message) === seamId);
  return seamIndex >= 0 ? visible.slice(seamIndex + 1) : [...visible];
};

/**
 * Identity-equal, same-length comparison of two live-tail lists, by the domain
 * message each entry wraps. The View rebuilds its {@link CodecMessage} wrappers
 * on every refresh, so compare the underlying `message` references — those are
 * stable while the window is unchanged.
 * @param a - First live-tail list.
 * @param b - Second live-tail list.
 * @returns `true` when both lists wrap the same messages in the same order.
 */
const sameMessages = <TMessage>(a: CodecMessage<TMessage>[], b: CodecMessage<TMessage>[]): boolean =>
  a.length === b.length && a.every((m, i) => m.message === b[i]?.message);

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
   * a different conversation. An empty array is a loaded-but-empty conversation —
   * no seam, so the live channel window is surfaced unchanged; while the seed is
   * still loading, set {@link skip} rather than passing `[]`.
   */
  seed: TMessage[];
  /**
   * Return the stable domain id of a message — the seam key shared between the
   * application's store and the channel. Called to identify the seam and to
   * drop the single overlap when composing.
   */
  getMessageId: (message: TMessage) => string;
  /**
   * Hold the reconciliation while the seed is still loading (e.g. an async store
   * fetch). When `true` the hook does not walk the channel and returns `[]`: the
   * newest seed message's id is the walk's stop condition (the seam), so walking
   * before the seed resolves would scan the channel with no stop point. Clear it
   * once the seed has loaded — a loaded-but-empty `[]` then surfaces the live
   * channel normally, which is why this "not loaded yet" hold is distinct from an
   * empty seed. Defaults to `false`.
   */
  skip?: boolean;
}

/**
 * Reconcile a persisted seed with the live channel and return the composed
 * conversation (`seed` followed by the not-yet-seeded live tail).
 * @param options - The view, the seed, and the message-id accessor.
 * @param options.view - The {@link View} over the live channel, or `undefined` before it resolves.
 * @param options.seed - The persisted conversation (the seed), oldest-first.
 * @param options.getMessageId - Returns a message's stable domain id (the seam key).
 * @param options.skip - Hold the reconciliation (no walk, empty result) while the seed is still loading.
 * @returns The composed conversation, oldest-first.
 */
export const useMessagesWithSeed = <TMessage>({
  view,
  seed,
  getMessageId,
  skip = false,
}: UseMessagesWithSeedOptions<TMessage>): TMessage[] => {
  // `getMessageId` is held in a ref: it's a pure accessor, so an unstable (e.g. inline) reference
  // shouldn't re-run the walk; the latest is read inside the effect.
  const getIdRef = useRef(getMessageId);
  getIdRef.current = getMessageId;

  // Resolve the live tail synchronously on first render so any already-visible
  // live messages are surfaced immediately alongside the seed — no transient
  // empty frame for a consumer that replaces its messages with this value. While
  // skipping (seed not loaded) there is no tail and nothing to surface.
  const [live, setLive] = useState<CodecMessage<TMessage>[]>(() => (skip ? [] : liveTail(view, seed, getMessageId)));

  const newestSeed = seed.at(-1);
  const seamId = newestSeed === undefined ? undefined : getIdRef.current(newestSeed);

  // The effect re-runs whenever `view`, `seamId` (last seed message's id), or
  // `skip` changes — a new seam re-drives the walk from scratch (see the `seed`
  // option doc), and clearing `skip` starts it once the seed has loaded.
  useEffect(() => {
    const getId = getIdRef.current;

    // Hold while the seed is still loading (no seam yet) or before the view
    // resolves: don't walk the channel, surface nothing.
    if (skip || !view) {
      setLive([]);
      return;
    }

    // Re-resolve the live tail, but keep the previous array when the messages
    // are unchanged so an `update` that doesn't alter the window (or a redundant
    // remount) doesn't churn a new reference through every downstream consumer.
    const trim = (): void => {
      const next = liveTail(view, seed, getId);
      setLive((prev) => (sameMessages(prev, next) ? prev : next));
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

    trim();
    const off = view.on('update', () => {
      trim();
      void driveWalk();
    });
    void driveWalk();

    return () => {
      controller.abort();
      off();
    };
  }, [view, seamId, skip]);

  // Compose `seed ⧺ live`: the persisted prefix followed by the not-yet-seeded
  // live tail. Recomputed only when the seed reference or the resolved live tail
  // changes, so a new seed (e.g. a swapped conversation) recomposes while an
  // unchanged window keeps the same array reference for downstream consumers.
  // While skipping, the seed isn't loaded yet — surface nothing.
  return useMemo(() => (skip ? [] : [...seed, ...live.map((m) => m.message)]), [skip, seed, live]);
};
