// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CodecMessage } from '../../src/core/codec/types.js';
import type { View } from '../../src/core/transport/types.js';
import { useMessagesWithSeed } from '../../src/react/use-messages-with-seed.js';
import { makeFakeLoadUntil } from '../helper/fake-load-until.js';

interface Msg {
  id: string;
  text: string;
}

const m = (id: string): Msg => ({ id, text: id });
const codec = (id: string): CodecMessage<Msg> => ({ codecMessageId: `c-${id}`, message: m(id) });
const getMessageId = (message: Msg): string => message.id;

/**
 * A fake leaf {@link View} backed by an oldest-first channel. It starts showing
 * the newest `initialVisible` messages; `loadOlder(1)` reveals one older message
 * and emits `update`. `emptyFirstLoad` makes the first `loadOlder` return `[]`
 * without revealing (simulating the startup/StrictMode race); `emit()` fires an
 * external `update` (a live arrival).
 * @param channel - The full channel history, oldest-first.
 * @param options - Window controls.
 * @param options.initialVisible - How many newest messages start revealed.
 * @param options.emptyFirstLoad - Make the first `loadOlder` return `[]` (race).
 * @returns The fake view and an `emit` to fire an external `update`.
 */
const makeView = (
  channel: string[],
  { initialVisible, emptyFirstLoad = false }: { initialVisible: number; emptyFirstLoad?: boolean },
): { view: View<Msg>; emit: () => void; loadOlder: ReturnType<typeof vi.fn> } => {
  // Precompute the nodes once so message references are stable across
  // getMessages() calls — as the real View is for unchanged nodes.
  const nodes = channel.map((id) => codec(id));
  let oldest = channel.length - initialVisible;
  let pendingEmpty = emptyFirstLoad;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of listeners) l();
  };
  const getMessages = (): CodecMessage<Msg>[] => nodes.slice(oldest);
  const hasOlder = (): boolean => oldest > 0;
  // Model DefaultView.loadUntil's exclusive-floor trim: hide the oldest `count`
  // messages (advancing the window floor) and emit, so getMessages() reports the
  // tail after the seam. loadOlder can still re-reveal them (oldest decreases).
  const hideOldest = (count: number): void => {
    oldest = Math.min(nodes.length, oldest + count);
    emit();
  };
  // A vi.fn (not a plain closure) so a test can assert on the walk's reveals;
  // makeFakeLoadUntil calls this same reference, so the calls are observed.
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const loadOlder = vi.fn((): Promise<CodecMessage<Msg>[]> => {
    if (pendingEmpty) {
      pendingEmpty = false;
      return Promise.resolve([]); // transient empty page
    }
    if (oldest === 0) return Promise.resolve([]);
    oldest -= 1;
    const page = nodes.slice(oldest, oldest + 1);
    emit();
    return Promise.resolve(page);
  });
  const view = {
    getMessages,
    hasOlder,
    loadOlder,
    // `loadUntil` is the production walk mirrored over this mock's accessors (the
    // real one is unit-tested in test/core/transport/view.test.ts).
    loadUntil: makeFakeLoadUntil({ getMessages, hasOlder, loadOlder, hideOldest }),
    on: (_event: 'update', handler: () => void) => {
      listeners.add(handler);
      return (): void => {
        listeners.delete(handler);
      };
    },
    // CAST: minimal View stub — only the members useMessagesWithSeed reads.
  } as unknown as View<Msg>;
  return { view, emit, loadOlder };
};

const ids = (msgs: Msg[]): string[] => msgs.map((x) => x.id);

describe('useMessagesWithSeed', () => {
  it('walks to the seam and composes seed ⧺ live with the seam shown once', async () => {
    const seed = [m('u1'), m('a1')]; // seam = a1
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1 });

    const { result } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
    expect(result.current.filter((x) => x.id === 'a1')).toHaveLength(1);
  });

  it('pages past a transient empty reveal without giving up', async () => {
    // The first loadOlder returns [] (racing attach / StrictMode). loadUntil keeps
    // paging while older history remains rather than bailing on the empty reveal,
    // so it still reaches the seam on its own and the live tail u2 is not lost —
    // no external nudge required.
    const seed = [m('u1'), m('a1')]; // seam = a1
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1, emptyFirstLoad: true });

    const { result } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
  });

  it('keeps the same array reference when an update leaves the window unchanged', async () => {
    // A no-op update (no window change) must return the prior reference so a
    // downstream consumer (e.g. useMessageSync's overlay merge) isn't churned.
    const seed = [m('u1'), m('a1')]; // seam = a1, already visible
    const { view, emit } = makeView(['a1', 'u2', 'a2'], { initialVisible: 3 });

    const { result } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
    const before = result.current;
    act(() => {
      emit(); // window unchanged
    });
    expect(result.current).toBe(before);
  });

  it('never commits a frame with a duplicate seam id when the seam is in the initial window', async () => {
    // Warm reload: the initial window already reaches back through the seam
    // (initialVisible covers it). The hook must not surface that untrimmed window
    // — neither from the first-render initializer nor an eager effect sync before
    // the walk trims — or it composes seed ⧺ window with the seam duplicated for
    // that frame (the React "two children with the same key" warning).
    const seed = [m('u1'), m('a1')]; // seam = a1, inside the initial window
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 3 });

    const frames: string[][] = [];
    const { result } = renderHook(() => {
      const composed = useMessagesWithSeed({ view, seed, getMessageId });
      frames.push(ids(composed));
      return composed;
    });

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
    // Every committed frame is duplicate-free — the seam is never shown twice.
    for (const frame of frames) {
      expect(frame).toEqual([...new Set(frame)]);
    }
  });

  it('walks to history exhaustion when the seam is absent', async () => {
    const seed = [m('x1')]; // seam x1 is not on the channel
    const { view } = makeView(['u2', 'a2'], { initialVisible: 1 });

    const { result } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['x1', 'u2', 'a2']);
    });
  });

  it('surfaces the live window unchanged with an empty seed', () => {
    const { view } = makeView(['u2', 'a2'], { initialVisible: 2 });
    const { result } = renderHook(() => useMessagesWithSeed({ view, seed: [], getMessageId }));
    expect(ids(result.current)).toEqual(['u2', 'a2']);
  });

  it('returns the seed unchanged before the view resolves', () => {
    const { result } = renderHook(() => useMessagesWithSeed({ view: undefined, seed: [m('u1')], getMessageId }));
    expect(ids(result.current)).toEqual(['u1']);
  });

  it('returns a stable reference when a fresh seed array has unchanged content', async () => {
    // A caller passing a new array each render but with the same message objects
    // (e.g. `store ?? []`, `props.messages`) must not churn the result — otherwise
    // an effect depending on it loops ("Maximum update depth exceeded"). The hook
    // compares the seed by content, so a fresh-but-equal seed is a no-op.
    const u1 = m('u1');
    const a1 = m('a1'); // seam, already visible
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 3 });

    const { result, rerender } = renderHook(({ seed }) => useMessagesWithSeed({ view, seed, getMessageId }), {
      initialProps: { seed: [u1, a1] },
    });
    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
    const before = result.current;

    // New array, same element references — the result must be the same reference.
    rerender({ seed: [u1, a1] });
    expect(result.current).toBe(before);
    rerender({ seed: [u1, a1] });
    expect(result.current).toBe(before);
  });

  it('recomposes when the seed reference changes', async () => {
    // A new seed reference re-drives reconciliation rather than being ignored —
    // the seam is already visible, so the prefix swap (u1 → z1) recomposes.
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1 });
    const { result, rerender } = renderHook(({ seed }) => useMessagesWithSeed({ view, seed, getMessageId }), {
      initialProps: { seed: [m('u1'), m('a1')] },
    });

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    rerender({ seed: [m('z1'), m('u1'), m('a1')] });

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['z1', 'u1', 'a1', 'u2', 'a2']);
    });
  });

  it('aborts the seam walk when the hook unmounts', async () => {
    // A superseded run (unmount, or React StrictMode's cleanup before remount)
    // aborts its walk so it does not page on concurrently with a fresh one.
    const seed = [m('u1'), m('a1')]; // seam = a1
    const { view } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1 });
    let captured: AbortSignal | undefined;
    const realLoadUntil = view.loadUntil.bind(view);
    view.loadUntil = async (predicate, signal) => {
      captured = signal;
      return realLoadUntil(predicate, signal);
    };

    const { unmount } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    await waitFor(() => {
      expect(captured).toBeDefined();
    });
    expect(captured?.aborted).toBe(false);

    unmount();
    expect(captured?.aborted).toBe(true);
  });

  it('the fake loadUntil honours an already-aborted signal (test-double contract)', async () => {
    // Guards the fake View used by these hook tests: it mirrors production by
    // resolving [] for an already-aborted signal without paging, so a hook test
    // relying on abort behaves the same as against a real View.
    const { view, loadOlder } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1 });
    const tail = await view.loadUntil(() => false, AbortSignal.abort());
    expect(tail).toEqual([]);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('holds — no channel walk, empty result — while skip is set, then walks once cleared', async () => {
    // While the seed is still loading the consumer sets skip: the seam (stop
    // condition) is unknown, so the channel must not be paged. A loaded-but-empty
    // seed would instead surface the window (covered above); skip is distinct.
    const seed = [m('u1'), m('a1')]; // seam = a1
    const { view, loadOlder } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1 });

    const { result, rerender } = renderHook(({ skip }) => useMessagesWithSeed({ view, seed, getMessageId, skip }), {
      initialProps: { skip: true },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]); // held, nothing surfaced
    expect(loadOlder).not.toHaveBeenCalled(); // no channel scan without a seam

    // Seed loaded — clearing skip drives the walk to the seam and composes.
    rerender({ skip: false });

    await waitFor(() => {
      expect(ids(result.current)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
    expect(loadOlder).toHaveBeenCalled();
  });
});
