/**
 * useMessagesWithSeed — reconcile a persisted conversation seed with the live channel.
 *
 * An application that stores completed conversation turns in its own database
 * (keyed by the domain message id) seeds this hook with that history and a
 * {@link View} over the live channel. The hook takes the newest seed message's
 * id as the **seam** — the only id shared between the store and the channel,
 * since the transport's internal `codecMessageId` is never persisted — and drives
 * {@link View.loadUntil} to page the view back until that id reappears, composing
 * `seed ⧺ live` with the single seam overlap dropped.
 *
 * {@link View.loadUntil} owns the backward walk and treats the seam as an
 * **exclusive floor**: once it reaches the seam the view window *is* exactly the
 * not-yet-seeded tail (the seam and everything older withheld). So the hook holds
 * no seam logic of its own — it mirrors {@link View.getMessages} into state on
 * each view `update` (both as the walk's reveals land and as new live messages
 * arrive) and appends it to the seed. A conversation reloaded mid-stream still
 * pages back to the seam, and the tail stays current as the stream progresses.
 *
 * This assumes a **linear history**: each turn is persisted whole before the
 * next is sent (and a concurrent send cancels the active run), so the stored
 * prefix and the channel's live tail meet at the seam with a single overlap.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { CodecMessage } from '../core/transport/session-codec.js';
import type { View } from '../core/transport/types.js';

/**
 * Identity-equal, same-length comparison of two live-tail lists, by the domain
 * message each entry wraps. The View rebuilds its {@link CodecMessage} wrappers
 * on every refresh, so compare the underlying `message` references — those are
 * stable while the window is unchanged. Used to hold the previous array when a
 * refresh doesn't move the window, so a redundant `update` (or the first effect
 * sync matching the render-time snapshot) doesn't churn a new reference through
 * every downstream consumer.
 * @param a - First live-tail list.
 * @param b - Second live-tail list.
 * @returns `true` when both lists wrap the same messages in the same order.
 */
const sameMessages = <TMessage>(a: CodecMessage<TMessage>[], b: CodecMessage<TMessage>[]): boolean =>
  a.length === b.length && a.every((m, i) => m.message === b[i]?.message);

/**
 * Identity-equal, same-length comparison of two lists. Used to hold the seed
 * reference stable while its content is unchanged.
 * @param a - First list.
 * @param b - Second list.
 * @returns `true` when both lists hold the same elements in the same order.
 */
const sameRefs = <T>(a: T[], b: T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Options for {@link useMessagesWithSeed}. */
export interface UseMessagesWithSeedOptions<TMessage> {
  /**
   * The {@link View} over the live channel to reconcile against, or `undefined`
   * before the session/view resolves (the hook then surfaces the seed as-is).
   */
  view: View<TMessage> | undefined;
  /**
   * The persisted conversation (the seed), oldest-first. Compared by **content**
   * (element identity), so a fresh array each render is safe — passing
   * `store ?? []` or `props.messages` inline won't churn the result or re-run the
   * walk. A genuine content change (different or reordered messages, e.g. a
   * swapped conversation) re-seams and recomposes. An empty array is a
   * loaded-but-empty conversation — no seam, so the live channel window is
   * surfaced unchanged; while the seed is still loading, set {@link skip} rather
   * than passing `[]`.
   */
  seed: TMessage[];
  /**
   * Return the stable domain id of a message — the seam key shared between the
   * application's store and the channel. Called to identify the seam.
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

  // Hold the seed reference stable while its content is unchanged. Callers
  // commonly pass a fresh array each render (`data ?? []`, `props.messages`), and
  // the composed result below is keyed on the seed — so an unstable reference
  // would hand back a new array every render and loop any effect that depends on
  // it (the classic "Maximum update depth exceeded"). Compare by element identity
  // — the seed messages are themselves stable — and reuse the prior reference
  // when equal: a fresh-but-equal seed is then a no-op, while a genuine content
  // change re-seeds. So referential stability is a convenience, not a contract.
  const seedRef = useRef(seed);
  if (seedRef.current !== seed && !sameRefs(seedRef.current, seed)) seedRef.current = seed;
  const stableSeed = seedRef.current;

  const newestSeed = stableSeed.at(-1);
  const seamId = newestSeed === undefined ? undefined : getIdRef.current(newestSeed);

  // Mirror the view window synchronously on first render so any already-visible
  // live messages surface immediately alongside the seed — no transient empty
  // frame for a consumer that replaces its messages with this value. Only when
  // there is no seam (no seed): with a seam the warm window may still reach back
  // through it, so an eager mirror would compose `seed ⧺ window` with the seam
  // (and older) duplicated for the first frame, before the effect's walk trims
  // below the floor. With a seam, start empty and let the walk populate the
  // trimmed tail. While skipping (seed not loaded) there is nothing live yet.
  const [live, setLive] = useState<CodecMessage<TMessage>[]>(() =>
    skip || !view || seamId !== undefined ? [] : [...view.getMessages()],
  );

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

    // The live tail is simply the view window: `loadUntil`'s exclusive floor
    // keeps the window equal to the not-yet-seeded tail once the seam is reached,
    // and growing live messages append to it. Mirror it into state on every
    // `update` — the walk's settled reveal and live arrivals both flow through
    // here — but keep the previous array when the window is unchanged so a no-op
    // refresh doesn't churn downstream.
    const sync = (): void => {
      const next = view.getMessages();
      setLive((prev) => (sameMessages(prev, next) ? prev : [...next]));
    };
    const off = view.on('update', sync);

    // Drive the backward walk to the seam. Abort it on cleanup so a superseded
    // run (a dep change, or React StrictMode's double-invoke) stops promptly
    // instead of paging on in the background concurrently with the remount's walk.
    const controller = new AbortController();
    if (seamId === undefined) {
      // No seam (no seed): no walk runs, so the window already is the live tail.
      // Mirror it now to surface any already-visible live messages immediately.
      sync();
    } else {
      // A walk will run. It suppresses its intermediate reveals and emits a single
      // settled `update` once the window is the trimmed tail, which `sync` mirrors.
      // So do NOT mirror the window now: the warm window may still reach back
      // through the seam, and surfacing it pre-trim would compose `seed ⧺ window`
      // with the seam (and older) duplicated for that frame.
      void view.loadUntil((m) => getId(m.message) === seamId, controller.signal);
    }

    return () => {
      off();
      controller.abort();
    };
  }, [view, seamId, skip]);

  // Compose `seed ⧺ live`: the persisted prefix followed by the not-yet-seeded
  // live tail. Keyed on the content-stable seed and the live tail, so a
  // fresh-but-equal seed doesn't churn the result, a genuine seed content change
  // (e.g. a swapped conversation) recomposes, and the reference is held stable
  // for downstream consumers. While skipping, the seed isn't loaded yet —
  // surface nothing.
  return useMemo(() => (skip ? [] : [...stableSeed, ...live.map((m) => m.message)]), [skip, stableSeed, live]);
};
