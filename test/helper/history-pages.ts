import type * as Ably from 'ably';
import { vi } from 'vitest';

/**
 * A fake Ably history page, chainable via `next()` — the shape
 * `channel.history()` resolves to, as consumed by `loadHistoryPages`.
 */
export interface MockPage {
  /** The page's messages (newest-first, matching Ably delivery order). */
  items: Ably.InboundMessage[];
  /** True while another page is available. */
  hasNext: () => boolean;
  /** Resolve the next page, or `undefined` when exhausted. */
  next: () => Promise<MockPage | undefined>;
}

/**
 * Build a chain of {@link MockPage}s over `pages` (newest page first,
 * newest-first within each page).
 * @param pages - History pages in Ably delivery order.
 * @returns The first page of the chain.
 */
export const buildPageChain = (pages: Ably.InboundMessage[][]): MockPage => {
  const build = (i: number): MockPage => ({
    items: pages[i] ?? [],
    hasNext: () => i < pages.length - 1,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    next: () => Promise.resolve(i < pages.length - 1 ? build(i + 1) : undefined),
  });
  return build(0);
};

/**
 * A mock channel exposing just the surface history reads need: `attach()`
 * and `history()` resolving a {@link buildPageChain} over `pages`. The
 * returned mocks let tests assert attach/history calls and their params.
 * @param pages - History pages in Ably delivery order (newest page first).
 * @returns The channel plus its `history` and `attach` mocks.
 */
export const createHistoryChannel = (
  pages: Ably.InboundMessage[][] = [],
): { channel: Ably.RealtimeChannel; historyMock: ReturnType<typeof vi.fn>; attachMock: ReturnType<typeof vi.fn> } => {
  const historyMock = vi.fn(
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    () => Promise.resolve(buildPageChain(pages)),
  );
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  const attachMock = vi.fn(() => Promise.resolve());
  const channel = {
    attach: attachMock,
    history: historyMock,
  };
  // CAST: the mock implements only the surface under test; tests treat it as a real channel.
  return { channel: channel as unknown as Ably.RealtimeChannel, historyMock, attachMock };
};
