// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CodecMessage } from '../../src/core/codec/types.js';
import type { View } from '../../src/core/transport/types.js';
import { useMessagesWithSeed } from '../../src/react/use-messages-with-seed.js';

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
): { view: View<Msg>; emit: () => void } => {
  // Precompute the nodes once so message references are stable across
  // getMessages() calls — as the real View is for unchanged nodes.
  const nodes = channel.map((id) => codec(id));
  let oldest = channel.length - initialVisible;
  let pendingEmpty = emptyFirstLoad;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of listeners) l();
  };
  const view = {
    getMessages: () => nodes.slice(oldest),
    hasOlder: () => oldest > 0,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: (): Promise<CodecMessage<Msg>[]> => {
      if (pendingEmpty) {
        pendingEmpty = false;
        return Promise.resolve([]); // transient empty page
      }
      if (oldest === 0) return Promise.resolve([]);
      oldest -= 1;
      const page = nodes.slice(oldest, oldest + 1);
      emit();
      return Promise.resolve(page);
    },
    on: (_event: 'update', handler: () => void) => {
      listeners.add(handler);
      return (): void => {
        listeners.delete(handler);
      };
    },
    // CAST: minimal View stub — only the members useMessagesWithSeed reads.
  } as unknown as View<Msg>;
  return { view, emit };
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

  it('resumes after a transient empty page instead of giving up', async () => {
    // The first loadOlder returns [] (racing attach / StrictMode). The walk must
    // defer, then resume on the next update and still reach the seam — otherwise
    // the live tail message u2 would be lost.
    const seed = [m('u1'), m('a1')]; // seam = a1
    const { view, emit } = makeView(['a1', 'u2', 'a2'], { initialVisible: 1, emptyFirstLoad: true });

    const { result } = renderHook(() => useMessagesWithSeed({ view, seed, getMessageId }));

    // Let the initial walk hit the empty page and defer.
    await act(async () => {
      await Promise.resolve();
    });
    // An external update (e.g. a live arrival) re-drives the walk.
    act(() => {
      emit();
    });

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
});
