'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** What {@link useStickToBottom} returns to wire a scrolling transcript. */
export interface StickToBottom {
  /** Attach to the scroll container. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Attach to the container's `onScroll`. */
  handleScroll: () => void;
  /** Whether to show a "jump to latest" affordance (the reader has scrolled up). */
  showJumpToLatest: boolean;
  /** Re-pin to the bottom and scroll there. */
  jumpToLatest: () => void;
}

/**
 * Keep a transcript pinned to its live edge while streaming, releasing the pin
 * only when the reader deliberately scrolls up. Follows content growth (tokens
 * or a tall tool card landing) without treating it as a scroll-away.
 *
 * @param messages - The transcript array; auto-scroll runs on every change to it while pinned.
 * @param scrollToEndRef - Optional; receives a "snap to the live edge" callback while mounted (the composer calls it on send).
 * @param onNearTop - Optional; called when the reader scrolls to the very top (used to page in older history).
 */
export function useStickToBottom(
  messages: readonly unknown[],
  scrollToEndRef?: RefObject<(() => void) | null>,
  onNearTop?: () => void,
): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (pinnedToBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!scrollToEndRef) return;
    scrollToEndRef.current = () => {
      pinnedToBottomRef.current = true;
      setShowJumpToLatest(false);
      scrollToBottom();
    };
    return () => {
      scrollToEndRef.current = null;
    };
  }, [scrollToEndRef, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    // Re-pin whenever the reader is at the bottom; release the pin only when they
    // deliberately scroll up. The 80px threshold absorbs sub-pixel rounding and
    // the scroll event fired by our own auto-scroll.
    if (distanceFromBottom < 80) {
      pinnedToBottomRef.current = true;
    } else if (scrolledUp) {
      pinnedToBottomRef.current = false;
    }
    setShowJumpToLatest(!pinnedToBottomRef.current);

    if (el.scrollTop < 60) onNearTop?.();
  }, [onNearTop]);

  const jumpToLatest = useCallback(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollToBottom();
  }, [scrollToBottom]);

  return { scrollRef, handleScroll, showJumpToLatest, jumpToLatest };
}
