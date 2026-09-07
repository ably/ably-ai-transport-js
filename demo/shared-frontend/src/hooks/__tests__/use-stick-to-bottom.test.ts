import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';

import { useStickToBottom } from '../use-stick-to-bottom';

// useStickToBottom keeps a transcript pinned to its live edge while streaming,
// releasing the pin only when the reader scrolls up. jsdom has no layout, so a
// fake element with controllable scroll geometry drives the hook.
function fakeScrollEl(scrollHeight: number, clientHeight: number, initialTop = 0): HTMLDivElement {
  const el = document.createElement('div');
  let top = initialTop;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  return el;
}

describe('useStickToBottom', () => {
  it('auto-scrolls to the bottom when the transcript grows while pinned', () => {
    const el = fakeScrollEl(1000, 300, 0);
    const { result, rerender } = renderHook(({ msgs }) => useStickToBottom(msgs), {
      initialProps: { msgs: [1] as number[] },
    });
    result.current.scrollRef.current = el;

    rerender({ msgs: [1, 2] });

    expect(el.scrollTop).toBe(1000);
  });

  it('releases the pin and offers jump-to-latest when the reader scrolls up', () => {
    const el = fakeScrollEl(1000, 300, 0);
    const { result } = renderHook(() => useStickToBottom([1]));
    result.current.scrollRef.current = el;

    // Settle at the bottom first so the pin is engaged.
    el.scrollTop = 700;
    act(() => result.current.handleScroll());
    expect(result.current.showJumpToLatest).toBe(false);

    // Scroll up — only a decrease in scrollTop releases the pin.
    el.scrollTop = 100;
    act(() => result.current.handleScroll());
    expect(result.current.showJumpToLatest).toBe(true);
  });

  it('does not auto-scroll once the pin is released', () => {
    const el = fakeScrollEl(1000, 300, 0);
    const { result, rerender } = renderHook(({ msgs }) => useStickToBottom(msgs), {
      initialProps: { msgs: [1] as number[] },
    });
    result.current.scrollRef.current = el;

    el.scrollTop = 700;
    act(() => result.current.handleScroll());
    el.scrollTop = 100;
    act(() => result.current.handleScroll());

    rerender({ msgs: [1, 2] });

    expect(el.scrollTop).toBe(100);
  });

  it('re-pins and scrolls to the bottom via jumpToLatest, hiding the affordance', () => {
    const el = fakeScrollEl(1000, 300, 0);
    const { result } = renderHook(() => useStickToBottom([1]));
    result.current.scrollRef.current = el;

    // Settle at the bottom, then scroll up to release the pin.
    el.scrollTop = 700;
    act(() => result.current.handleScroll());
    el.scrollTop = 100;
    act(() => result.current.handleScroll());
    expect(result.current.showJumpToLatest).toBe(true);

    act(() => result.current.jumpToLatest());

    expect(el.scrollTop).toBe(1000);
    expect(result.current.showJumpToLatest).toBe(false);
  });

  it('calls onNearTop only when scrolled to the very top', () => {
    const el = fakeScrollEl(1000, 300, 0);
    const onNearTop = vi.fn();
    const { result } = renderHook(() => useStickToBottom([1], undefined, onNearTop));
    result.current.scrollRef.current = el;

    el.scrollTop = 0;
    act(() => result.current.handleScroll());
    expect(onNearTop).toHaveBeenCalledTimes(1);

    el.scrollTop = 200;
    act(() => result.current.handleScroll());
    expect(onNearTop).toHaveBeenCalledTimes(1);
  });

  it('publishes a snap-to-edge callback on scrollToEndRef while mounted, clearing it on unmount', () => {
    const scrollToEndRef: RefObject<(() => void) | null> = { current: null };
    const el = fakeScrollEl(1000, 300, 0);
    const { result, unmount } = renderHook(() => useStickToBottom([1], scrollToEndRef));
    expect(typeof scrollToEndRef.current).toBe('function');
    result.current.scrollRef.current = el;

    act(() => scrollToEndRef.current?.());
    expect(el.scrollTop).toBe(1000);

    unmount();
    expect(scrollToEndRef.current).toBeNull();
  });
});
